import { afterEach, describe, expect, it, vi } from 'vitest';
import { enhancePrompt } from '../bridge/textApi';
import type { ModelProfile } from '../bridge/settings';

const profile: ModelProfile = {
  id: 't1',
  name: '语言模型',
  baseUrl: 'https://example.com/v1',
  apiKey: 'k-test',
  model: 'gpt-4o-mini',
  defaultSize: '1024x1024',
  models: [],
  enabledModels: [],
  kind: 'text',
  textFormat: 'chat',
};

const A = 'data:image/png;base64,QUJD';
const B = 'data:image/png;base64,REVG';

function mockFetchOk() {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A calm harbor at dusk, soft blue tones, wide composition, cinematic lighting, a distant lighthouse standing over misty water.' } }] }) };
  }));
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('enhancePrompt 多图编号语义', () => {
  it('多图时 user 段写清编号对应，图片按传入顺序原样发出', async () => {
    const calls = mockFetchOk();
    const out = await enhancePrompt(profile, {
      prompt: '图一是结尾页面，图二是首页。根据图二这张插画的风格帮我生成呼应的图片',
      size: '1024x1024',
      referenceDataUrls: [A, B],
      level: 'balanced',
      preferences: [],
    });
    expect(out).toContain('harbor');

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toContain('/chat/completions');
    const messages = call.body.messages as Array<{ role: string; content: unknown }>;
    const userContent = messages[1].content as Array<Record<string, unknown>>;
    const text = userContent.find((part) => part.type === 'text')?.text as string;
    expect(text).toContain('参考图 1 = 第 1 张图');
    expect(text).toContain('参考图 2 = 第 2 张图');
    expect(text).toContain('不要按画面内容自行调换');
    expect(text).toContain('风格参考');
    expect(text).toContain('正面描述一个与参考图主体不同的全新场景');

    // 图片分段顺序必须与数组一致：第 1 张 = A（chips 上的图 1）
    const imageParts = userContent.filter((part) => part.type === 'image_url');
    expect(imageParts.map((part) => (part.image_url as { url: string }).url)).toEqual([A, B]);
  });

  it('单图不带编号段（不会混），数组仍按序', async () => {
    const calls = mockFetchOk();
    await enhancePrompt(profile, {
      prompt: '把这张图改成竖构图',
      referenceDataUrls: [A],
      level: 'strict',
      preferences: [],
    });
    const messages = calls[0].body.messages as Array<{ role: string; content: unknown }>;
    const userContent = messages[1].content as Array<Record<string, unknown>>;
    const text = userContent.find((part) => part.type === 'text')?.text as string;
    expect(text).not.toContain('参考图 1 = 第 1 张图');
    expect(text).toContain('另附 1 张参考图');
    expect(text).toContain('风格参考');
    expect(userContent.filter((part) => part.type === 'image_url')).toHaveLength(1);
  });

  it('空图时保持纯文本 user 段', async () => {
    const calls = mockFetchOk();
    await enhancePrompt(profile, { prompt: '一只柴犬', level: 'balanced', preferences: [] });
    const messages = calls[0].body.messages as Array<{ role: string; content: unknown }>;
    expect(typeof messages[1].content).toBe('string');
  });

  it('模型返回 JSON 时只把 prompt 交给生图，并保留用途与参考图角色', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          prompt: 'A new mountain valley in the same muted blue palette, with open space in the upper third for a title.',
          usage: 'style',
          referenceRoles: [{ index: 1, role: 'style' }],
        }) } }] }),
      };
    }));
    const { enhancePromptDetailed } = await import('../bridge/textApi');
    const result = await enhancePromptDetailed(profile, {
      prompt: '根据图一风格做一个新的山谷背景',
      referenceDataUrls: [A],
      level: 'balanced',
      preferences: [],
    });
    expect(result.prompt).toContain('new mountain valley');
    expect(result.prompt).not.toContain('referenceRoles');
    expect(result.usage).toBe('style');
    expect(result.referenceRoles).toEqual([{ index: 1, role: 'style' }]);
    expect(calls).toHaveLength(1);
  });
});
