import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImages, normalizeImageSize } from '../bridge/imageApi';
import type { ModelProfile } from '../bridge/settings';

const profile: ModelProfile = {
  id: 'image-responses',
  name: 'Responses 测试',
  baseUrl: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'gpt-image-2.5-sunburst',
  defaultSize: '1024x1024',
  models: [],
  enabledModels: [],
  kind: 'image',
  textFormat: 'auto',
  imageApiMode: 'responses',
  responsesModel: 'gpt-5.5',
};

afterEach(() => vi.unstubAllGlobals());

describe('normalizeImageSize', () => {
  it('保留 auto 并回落非法输入', () => {
    expect(normalizeImageSize('auto')).toBe('auto');
    expect(normalizeImageSize('not-a-size')).toBe('1024x1024');
  });

  it('把超出官方边长与总像素限制的 4K 方图收敛到合法尺寸', () => {
    const value = normalizeImageSize('4096x4096');
    const [width, height] = value.split('x').map(Number);
    expect(width).toBe(2880);
    expect(height).toBe(2880);
    expect(width % 16).toBe(0);
    expect(width * height).toBeLessThanOrEqual(8_294_400);
  });

  it('补足过小尺寸的最小像素面积', () => {
    const [width, height] = normalizeImageSize('256x256').split('x').map(Number);
    expect(width * height).toBeGreaterThanOrEqual(655_360);
  });

  it('Responses 生成发送独立主模型、图像工具模型与质量，并回收上下文 id', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp_123',
          output: [{ type: 'image_generation_call', id: 'ig_123', result: 'aGVsbG8=', revised_prompt: 'revised' }],
        }),
      };
    }));
    const [image] = await generateImages(profile, { prompt: '一只猫', size: '1024x1024', quality: 'high', n: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/v1/responses');
    expect(calls[0].body.model).toBe('gpt-5.5');
    expect((calls[0].body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2.5-sunburst',
      quality: 'high',
      size: '1024x1024',
    });
    expect(image.responseId).toBe('resp_123');
    expect(image.imageGenerationCallId).toBe('ig_123');
    expect(image.responseModel).toBe('gpt-5.5');
    await fs.unlink(image.filePath);
  });

  it('Responses 路由不支持时回退 Image API，而不是重复重试同一路', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 404, text: async () => '{"error":{"message":"not found"}}' };
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }) };
    }));
    const [image] = await generateImages(profile, { prompt: '一只猫', n: 1 });
    expect(calls).toEqual(['https://example.com/v1/responses', 'https://example.com/v1/images/generations']);
    await fs.unlink(image.filePath);
  });

  it('本次 apiMode=images 会覆盖 profile 的旧 Responses 配置', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }) };
    }));
    const [image] = await generateImages(profile, { prompt: '一只猫', imagesPrompt: '一只猫\n不要照抄参考图主体', apiMode: 'images' });
    expect(calls.map((call) => call.url)).toEqual(['https://example.com/v1/images/generations']);
    expect(calls[0].body.prompt).toBe('一只猫\n不要照抄参考图主体');
    await fs.unlink(image.filePath);
  });

  it('本次 apiMode=responses 会覆盖 profile 的旧 Image API 配置', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_override', output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }] }),
      };
    }));
    const [image] = await generateImages({ ...profile, imageApiMode: 'images' }, { prompt: '一只猫', apiMode: 'responses' });
    expect(calls).toEqual(['https://example.com/v1/responses']);
    expect(image.responseId).toBe('resp_override');
    await fs.unlink(image.filePath);
  });

  it('连续编辑带 previous_response_id 时不重复上传参考图', async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resp_next', output: [{ type: 'image_generation_call', id: 'ig_next', result: 'aGVsbG8=' }] }),
      };
    }));
    const [image] = await generateImages(profile, {
      prompt: '把天空改成黄昏',
      previousResponseId: 'resp_prev',
      referenceDataUrls: ['data:image/png;base64,QUJD'],
    });
    expect(body?.previous_response_id).toBe('resp_prev');
    const input = body?.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0].content.some((part) => part.type === 'input_image')).toBe(false);
    const tool = (body?.tools as Array<Record<string, unknown>>)[0];
    expect(tool.action).toBe('edit');
    await fs.unlink(image.filePath);
  });
});
