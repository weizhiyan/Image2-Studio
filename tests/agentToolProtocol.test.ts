import { afterEach, describe, expect, it, vi } from 'vitest';
import { askUserToolDef, callAgentModel, extractDsmlToolCalls, generateImageToolDef, normalizeAskUserQuestions } from '../bridge/agent';
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

describe('澄清问题协议', () => {
  it('开放输入接受空 options、保留 optional，并不误判为多选', () => {
    expect(normalizeAskUserQuestions([
      { id: 'copy', title: '画面上的精确文案？', type: 'text', optional: true },
      { id: 'style', title: '风格？', type: 'multiple', options: ['简约', '写实'], optional: false },
      { id: 'bad', title: '无选项单选', type: 'single' },
    ])).toEqual([
      { id: 'copy', title: '画面上的精确文案？', type: 'text', optional: true, multiple: false, options: [] },
      { id: 'style', title: '风格？', type: 'multiple', optional: false, multiple: true, options: [{ label: '简约', value: '简约' }, { label: '写实', value: '写实' }] },
    ]);
  });

  it('工具 schema 允许 text/optional 且不强制所有题目都有 options', () => {
    const properties = askUserToolDef().parameters.properties as Record<string, any>;
    const question = properties.questions.items;
    expect(question.properties.type.enum).toEqual(['single', 'multiple', 'text']);
    expect(question.properties.optional.type).toBe('boolean');
    expect(question.required).toEqual(['title']);
    expect(question.properties.options.minItems).toBeUndefined();
    expect(askUserToolDef().description).toContain('自然语言');
  });
});

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
    expect(input[2].content).not.toContainEqual(expect.objectContaining({ type: 'input_image' }));
    expect(input[3]).toMatchObject({ type: 'function_call', call_id: 'call-previous', name: 'generate_image' });
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call-previous', output: '图片已生成' });
    expect(input[5]).toMatchObject({ role: 'user', content: expect.arrayContaining([{ type: 'input_image', image_url: 'data:image/png;base64,bmV3' }]) });
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

  it('原生调用之外夹带截断的 DSML 不执行部分调用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output_text: '<|DSML|>invoke name="generate_image">', output: [{ type: 'function_call', name: 'generate_image', arguments: '{"prompt":"ok"}' }] })));
    await expect(callAgentModel(profile, params)).rejects.toThrow('本次未提交生成');
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

  it('参数400即使提到 tools/function 也不自动换协议', async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: 'invalid tools schema: function parameters must be an object' } }, 400));
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel(profile, params)).rejects.toThrow('invalid tools schema');
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it('Chat 请求使用角色温度，缺省 0.6', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n';
    const fetch = vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const chatProfile = { ...profile, textFormat: 'chat' as const };
    const bodyOf = (index: number) => JSON.parse(String(
      (fetch.mock.calls[index] as unknown as [string, RequestInit])[1].body,
    ));
    await callAgentModel(chatProfile, { ...params, temperature: 0.9 });
    expect(bodyOf(0)).toMatchObject({ temperature: 0.9 });

    fetch.mockClear();
    await callAgentModel(chatProfile, params);
    expect(bodyOf(0)).toMatchObject({ temperature: 0.6 });

    fetch.mockClear();
    await callAgentModel(chatProfile, { ...params, temperature: 1.5 });
    expect(bodyOf(0)).toMatchObject({ temperature: 1 });
  });

  it('Responses 拒绝 temperature 时去掉后重试', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'temperature is not supported' } }, 400))
      .mockResolvedValueOnce(jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '好的' }] }] }));
    vi.stubGlobal('fetch', fetch);
    const bodyOf = (index: number) => JSON.parse(String(
      (fetch.mock.calls[index] as unknown as [string, RequestInit])[1].body,
    ));
    const result = await callAgentModel(profile, { ...params, temperature: 0.9 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(0)).toMatchObject({ temperature: 0.9 });
    expect(bodyOf(1)).not.toHaveProperty('temperature');
    expect(result.text).toBe('好的');
  });
});

describe('Chat 流与工具完整性', () => {
  const chat = { ...profile, textFormat: 'chat' as const };
  const event = (choice: unknown) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;

  it('把显式 reasoning_content 作为思考增量，不进正文', async () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"先判断是否要生图。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"这是正文。","reasoning_content":"继续规划。"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const onTextDelta = vi.fn();
    const onReasoningDelta = vi.fn();
    const result = await callAgentModel(chat, { ...params, onTextDelta, onReasoningDelta });
    expect(result.text).toBe('这是正文。');
    expect(onTextDelta).toHaveBeenCalledWith('这是正文。');
    expect(onReasoningDelta.mock.calls.map((call) => call[0]).join('')).toBe('先判断是否要生图。继续规划。');
    expect(result.text).not.toContain('先判断是否要生图');
  });

  it('最后无换行的 SSE tail 也被解析', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(event({ delta: { content: '尾部' } }).trimEnd() + '\n\ndata: [DONE]')));
    await expect(callAgentModel(chat, params)).resolves.toMatchObject({ text: '尾部' });
  });

  it('未带换行的最后正文增量不会丢失', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(event({ delta: { content: '尾部正文' }, finish_reason: 'stop' }).trimEnd())));
    await expect(callAgentModel(chat, params)).resolves.toMatchObject({ text: '尾部正文' });
  });

  it('最后一个合法 finish_reason 无换行时也算完整结束', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(event({ delta: { content: '完整' } }) + event({ delta: {}, finish_reason: 'stop' }).trimEnd())));
    await expect(callAgentModel(chat, params)).resolves.toMatchObject({ text: '完整' });
  });

  it.each([
    event({ delta: { content: '半句' } }),
    event({ delta: { content: '半句' }, finish_reason: 'length' }) + 'data: [DONE]\n\n',
    event({ delta: { content: '半句' }, finish_reason: 'content_filter' }) + 'data: [DONE]\n\n',
    'data: {broken}\n\ndata: [DONE]\n\n',
    'data: [DONE]\n\n',
    event({ delta: { tool_calls: [{ index: 0, function: { name: 'unknown_tool', arguments: '{}' } }] } }) + 'data: [DONE]\n\n',
    event({ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }) + 'data: [DONE]\n\n',
    event({ delta: { content: '{"action":"generate_image","args":{"prompt":"半个' } }) + 'data: [DONE]\n\n',
  ])('断流、截断和未知工具不被成功或回退掩盖：%s', async (body) => {
    const fetch = vi.fn(async () => new Response(body));
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel(chat, params)).rejects.toThrow(/未提交生成|截断|不完整/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('末轮 tools 为空时省略 tools 与 tool_choice', async () => {
    const fetch = vi.fn(async () => new Response(event({ delta: { content: '总结' } }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    await callAgentModel(chat, { ...params, tools: [] });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('Responses 无工具总结不再注入可调用动作的 JSON 协议', async () => {
    const fetch = vi.fn(async () => jsonResponse({ output_text: '已完成的总结' }));
    vi.stubGlobal('fetch', fetch);
    await callAgentModel(profile, { ...params, tools: [] });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.instructions).toBe(params.systemSpec);
    expect(body).not.toHaveProperty('tools');
  });

  it('Chat 首次 fetch failed 时重试一次并成功，不误触发 JSON 协议', async () => {
    const failed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetch = vi.fn()
      .mockRejectedValueOnce(failed)
      .mockResolvedValueOnce(new Response(event({ delta: { content: '重试成功' }, finish_reason: 'stop' }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    const onTextDelta = vi.fn();
    const result = await callAgentModel(chat, { ...params, onTextDelta });
    expect(result.text).toBe('重试成功');
    expect(onTextDelta).toHaveBeenCalledWith('重试成功');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('网络持续失败时给出可执行的错误，不把 fetch failed 直接丢给用户', async () => {
    const failed = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
    const fetch = vi.fn().mockRejectedValue(failed);
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel(chat, params)).rejects.toThrow('语言模型请求失败：无法连接上游或代理（ETIMEDOUT）');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Chat 明确拒绝 temperature 时仅移除该字段重试一次', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { message: 'Unsupported parameter: temperature' } }, 400))
      .mockResolvedValueOnce(new Response(event({ delta: { content: '好' } }) + 'data: [DONE]\n\n'));
    vi.stubGlobal('fetch', fetch);
    await callAgentModel(chat, { ...params, temperature: 0.9 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    const second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(first.temperature).toBe(0.9);
    delete first.temperature;
    expect(second).toEqual(first);
  });

  it.each(['chat', 'responses'] as const)('%s 不吞掉仅提及 temperature 的其它参数错误', async (textFormat) => {
    const fetch = vi.fn(async () => jsonResponse({ error: { message: 'invalid model name; temperature was 0.6' } }, 400));
    vi.stubGlobal('fetch', fetch);
    await expect(callAgentModel({ ...profile, textFormat }, { ...params, temperature: 0.6 })).rejects.toThrow('invalid model name');
    expect(fetch).toHaveBeenCalledTimes(1);
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

  it.each([
    '{"action":"generate_image","args":{"prompt":"未结束',
    '```json\n{"action":"generate_image", "args": {broken}}\n```',
    '{"action":"unknown_tool","args":{}}',
    '{"args":{"prompt":"未完成"}, "action":"generate_image"',
    '<|DSML|>calls><|DSML|>invoke name="generate_image"><|DSML|>parameter name="args" string="false">{"prompt":"ok"}</|DSML|>parameter></|DSML|>invoke><|DSML|>invoke name="generate_</|DSML|>calls>',
    '{"action":"generate_image","args":{"prompt":"ok"}}\n{"action":"generate_image","args":{"prompt":"未完',
    '<|DSML|>calls><|DSML|>invoke name="generate_image"><|DSML|>parameter name="args" string="false">{"prompt":"ok"}</|DSML|>parameter></|DSML|>invoke>',
  ])('JSON 回落拒绝疑似未闭合动作、额外坏动作和 DSML 外壳：%s', async (output_text) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ output_text })));
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
