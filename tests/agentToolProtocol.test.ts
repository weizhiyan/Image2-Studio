import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAgentModel, extractDsmlToolCalls, generateImageToolDef } from '../bridge/agent';
import type { ModelProfile } from '../bridge/settings';

const profile: ModelProfile = {
  id: 'text-test', name: '测试语言模型', baseUrl: 'https://model.example/v1', apiKey: 'test-key',
  model: 'deepseek-flash', kind: 'text', textFormat: 'responses', defaultSize: '', models: [], enabledModels: [],
};

const params = {
  systemSpec: '你是绘板助手。',
  messages: [{ role: 'user' as const, content: '再来一个 4*4 宫格' }],
  tools: [generateImageToolDef()],
};

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('原生工具调用协议', () => {
  it('Responses 发送原生工具并解析 function_call，跳过 reasoning', async () => {
    const fetch = vi.fn(async () => jsonResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '<|DSML|>invalid hidden reasoning' }] },
        { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'generate_image', arguments: '{"prompt":"保留动物头像画风，改为4行4列十六宫格","ratio":"1:1","count":1}', status: 'completed' },
      ],
    }));
    vi.stubGlobal('fetch', fetch);
    const onTextDelta = vi.fn();
    const result = await callAgentModel(profile, { ...params, onTextDelta });
    expect(result).toMatchObject({ text: '', protocol: 'tools', toolCalls: [{ id: 'call-1', name: 'generate_image', args: { ratio: '1:1', count: 1 } }] });
    expect(result.toolCalls[0].args.prompt).toContain('十六宫格');
    expect(onTextDelta).not.toHaveBeenCalled();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://model.example/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({ instructions: params.systemSpec, max_output_tokens: 4096, tools: [{ type: 'function', name: 'generate_image' }] });
  });

  it('把工具结果用 function_call_output 回传，并只给当前消息附上本轮参考图', async () => {
    const fetch = vi.fn(async () => jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '已完成。' }] }] }));
    vi.stubGlobal('fetch', fetch);
    const onTextDelta = vi.fn();
    const result = await callAgentModel(profile, {
      ...params,
      messages: [
        { role: 'user', content: '旧需求', images: ['data:image/png;base64,b2xk'] },
        { role: 'assistant', content: '上一版已完成。' },
        { role: 'user', content: '改为4×4宫格' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call-previous', name: 'generate_image', args: { prompt: '十六宫格' } }] },
        { role: 'tool', content: '图片已生成', toolCallId: 'call-previous' },
      ],
      visualContextImages: ['data:image/png;base64,bmV3'],
      onTextDelta,
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const { input } = JSON.parse(String(init.body));
    expect(JSON.stringify(input)).not.toContain('b2xk');
    expect(input[2].content).toContainEqual({ type: 'input_image', image_url: 'data:image/png;base64,bmV3' });
    expect(input[3]).toMatchObject({ type: 'function_call', call_id: 'call-previous', name: 'generate_image' });
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call-previous', output: '图片已生成' });
    expect(result.text).toBe('已完成。');
    expect(onTextDelta).toHaveBeenCalledWith('已完成。');
  });

  it.each([
    { status: 'incomplete', output: [{ type: 'function_call', name: 'generate_image', arguments: '{"prompt":"未完' }] },
    { output: [{ type: 'function_call', name: 'generate_image', arguments: '{"prompt":"未完' }] },
    { output: [{ type: 'function_call', name: 'generate_image', arguments: '[]' }] },
    { output: [{ type: 'function_call', name: 'generate_image', arguments: '{}', status: 'incomplete' }] },
    { output: [{ type: 'function_call', name: 'unknown_tool', arguments: '{}' }] },
  ])('不完整、损坏或未授权的调用按错误处理，不静默转换为空参数或自动重发：%j', async (payload) => {
    const fetch = vi.fn(async () => jsonResponse(payload));
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel(profile, params)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('只在明确不支持原生 tools 时回落 JSON 指令协议', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'tools are not supported' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ output_text: '{"action":"generate_image","args":{"prompt":"4×4宫格"}}' }));
    vi.stubGlobal('fetch', fetch);
    const result = await callAgentModel(profile, params);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toHaveProperty('tools');
    expect(JSON.parse(fetch.mock.calls[1][1].body)).not.toHaveProperty('tools');
    expect(result.toolCalls[0].args.prompt).toBe('4×4宫格');
  });

  it('鉴权错误不回落或重试', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: 'invalid key' } }, 401));
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel(profile, params)).rejects.toThrow('HTTP 401');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Chat Completions 按 function.name 和 function.arguments 归并原生工具增量', async () => {
    const deltas = [
      { tool_calls: [{ index: 0, id: 'chat-call', type: 'function', function: { name: 'generate_image', arguments: '{"prompt":' } }] },
      { tool_calls: [{ index: 0, function: { arguments: '"4×4宫格","count":1}' } }] },
    ];
    const body = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const result = await callAgentModel({ ...profile, textFormat: 'chat' }, params);
    expect(result.toolCalls).toEqual([{ id: 'chat-call', name: 'generate_image', args: { prompt: '4×4宫格', count: 1 } }]);
  });
});

describe('DSML 兼容与失败边界', () => {
  it.each(['calls', 'function_calls', 'tool_calls'])('完整移除 %s 外壳，不把协议源码显示给用户', (wrapper) => {
    const result = extractDsmlToolCalls(`准备生成。<｜DSML｜${wrapper}><｜DSML｜invoke name="generate_image"><｜DSML｜parameter name="args" string="false">{"prompt":"4×4宫格"}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜${wrapper}>`);
    expect(result?.text).toBe('准备生成。');
    expect(result?.toolCalls[0].args.prompt).toBe('4×4宫格');
  });

  it('截断的 DSML 按错误处理，而不是显示正常完成', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output_text: '<|DSML|>invoke name="generate_image"><|DSML|>parameter name="args" string="false">{"prompt":"未结束' })));
    await expect(callAgentModel(profile, params)).rejects.toThrow('本次未提交生成');
  });

  it('一批调用里有损坏的参数时不执行其中的部分调用', async () => {
    const text = '<|DSML|>function_calls>'
      + '<|DSML|>invoke name="generate_image"><|DSML|>parameter name="args" string="false">{"prompt":"第一张"}</|DSML|>parameter></|DSML|>invoke>'
      + '<|DSML|>invoke name="generate_image"><|DSML|>parameter name="args" string="false">{broken}</|DSML|>parameter></|DSML|>invoke>'
      + '</|DSML|>function_calls>';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output_text: text })));
    await expect(callAgentModel(profile, params)).rejects.toThrow('本次未提交生成');
  });
});
