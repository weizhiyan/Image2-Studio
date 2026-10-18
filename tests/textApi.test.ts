import { afterEach, describe, expect, it, vi } from 'vitest';
import { callTextModel, testTextProfile } from '../bridge/textApi';
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
