import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildVideoPromptSpec, callTextModel, optimizeVideoPrompt, testTextProfile } from '../bridge/textApi';
import type { ModelProfile } from '../bridge/settings';

const responsesProfile: ModelProfile = {
  id: 'deepseek-test',
  name: 'Deespeek',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'test-key',
  model: 'deepseek-flash',
  defaultSize: '1024x1024',
  models: ['deepseek-flash'],
  enabledModels: ['deepseek-flash'],
  kind: 'text',
  textFormat: 'responses',
};

const chatProfile: ModelProfile = { ...responsesProfile, textFormat: 'chat' };

afterEach(() => vi.unstubAllGlobals());

describe('Responses 文本解析', () => {
  it('只读取最终 message，不把 reasoning 当成回复', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: '内部思考，不应展示' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'OK' }] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(callTextModel(responsesProfile, {
      systemSpec: 'reply',
      userText: 'OK',
      imageUrls: [],
      maxTokens: 64,
    })).resolves.toBe('OK');
  });

  it('支持顶层 output_text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      output_text: '```text\nOK\n```',
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'hidden' }] }],
    }), { status: 200 })));

    await expect(callTextModel(responsesProfile, {
      systemSpec: 'reply',
      userText: 'OK',
      imageUrls: [],
      maxTokens: 64,
    })).resolves.toBe('OK');
  });

  it('只有 reasoning 时返回可操作的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'only reasoning' }] }],
    }), { status: 200 })));

    await expect(callTextModel(responsesProfile, {
      systemSpec: 'reply',
      userText: 'OK',
      imageUrls: [],
      maxTokens: 64,
    })).rejects.toThrow(/没有生成最终回答|Responses/);
  });

  it('incomplete 且没有最终回答时提示提高输出上限', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'truncated' }] }],
    }), { status: 200 })));

    await expect(callTextModel(responsesProfile, {
      systemSpec: 'reply',
      userText: 'OK',
      imageUrls: [],
      maxTokens: 64,
    })).rejects.toThrow(/提高输出上限|Chat Completions/);
  });
});

describe('文本接口连通测试', () => {
  it('保留 Chat Completions 的标准解析', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callTextModel(chatProfile, {
      systemSpec: 'reply',
      userText: 'OK',
      imageUrls: [],
      maxTokens: 64,
    })).resolves.toBe('OK');
  });

  it('DeepSeek 连通测试使用足够容纳 reasoning 的预算', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(testTextProfile(responsesProfile)).resolves.toContain('语言模型连通正常，回复：OK');
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.max_output_tokens).toBe(256);
  });
});

describe('文本温度兼容与输出完整性', () => {
  const input = { systemSpec: 'reply', userText: 'OK', imageUrls: [], maxTokens: 64, temperature: 0.8 };
  it.each(['chat', 'responses'] as const)('%s 不支持温度时仅删除 temperature', async (textFormat) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'temperature is not supported' } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(textFormat === 'chat' ? { choices: [{ message: { content: 'OK' } }] } : { output_text: 'OK' })));
    vi.stubGlobal('fetch', fetch);
    await expect(callTextModel({ ...responsesProfile, textFormat }, input)).resolves.toBe('OK');
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0][1].body);
    const second = JSON.parse(fetch.mock.calls[1][1].body);
    expect(first.temperature).toBe(0.8);
    delete first.temperature;
    expect(second).toEqual(first);
  });

  it.each(['chat', 'responses'] as const)('%s 其它400不因提到 temperature 就重试', async (textFormat) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid model; temperature=0.8' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(callTextModel({ ...responsesProfile, textFormat }, input)).rejects.toThrow('invalid model');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['length', 'content_filter'])('chat %s 不把部分文本当成功', async (finish_reason) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"generate_image"' }, finish_reason }] }))));
    await expect(callTextModel(chatProfile, input)).rejects.toThrow(/截断|不完整|过滤/);
  });

  it('Responses incomplete 即使有 output_text 仍然拒绝', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'incomplete', output_text: '半句话' }))));
    await expect(callTextModel(responsesProfile, input)).rejects.toThrow(/incomplete|最终回答/);
  });
});

describe('视频脚本优化', () => {
  it('通过已有语言模型生成短视频提示词并带入当前参数', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: '小船缓慢驶过海面，镜头从近景平稳拉远，最后停在橙色晚霞下。' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(optimizeVideoPrompt(chatProfile, {
      prompt: '一只纸船在海面漂浮',
      ratio: '9:16',
      seconds: 10,
      resolution: '720p',
      referenceMode: 'style',
    })).resolves.toContain('小船缓慢');

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.body));
    expect(body.messages[0].content).toContain('画幅 9:16');
    expect(body.messages[0].content).toContain('时长 10 秒');
    expect(body.messages[0].content).toContain('风格参考图');
    expect(body.messages[1].content).toBe('一只纸船在海面漂浮');
  });

  it('规则明确要求保持用户原意且不假装识别图片', () => {
    const spec = buildVideoPromptSpec({ referenceMode: 'first_frame' });
    expect(spec).toContain('不能替换主体');
    expect(spec).toContain('不要声称识别或看到了图片的具体内容');
    expect(spec).toContain('如提供参考图片');
    expect(spec).not.toContain('连接图片');
  });

  it('保留简短英文视频提示词，不套用图片优化的最小词数门槛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'A cat runs across the grass.' } }],
    }), { status: 200 })));
    await expect(optimizeVideoPrompt(chatProfile, { prompt: 'A cat runs' })).resolves.toContain('A cat runs');
  });
});
