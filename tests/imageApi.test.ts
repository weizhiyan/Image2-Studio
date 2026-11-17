import fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImages, imageOutputFormatOf, IMAGE_GENERATION_TIMEOUT_MS, normalizeImageSize } from '../bridge/imageApi';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('生图连接失败诊断', () => {
  it.each(['images', 'responses'] as const)('%s 连接中断后不重复提交可能已受理的付费请求', async (apiMode) => {
    const failure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateImages(profile, { prompt: 'test', apiMode })).rejects.toThrow('无法确认上游是否已完成（ECONNRESET）');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ cause: { code: 'UND_ERR_SOCKET' } }, { code: 'UND_ERR_SOCKET' }])('图片下载中断分别报告且不被外层覆盖：%j', async (details) => {
    const failure = Object.assign(new TypeError('terminated'), details);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ url: 'https://images.test/output.png' }] }) })
      .mockRejectedValueOnce(failure);
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateImages(profile, { prompt: 'test', apiMode: 'images' })).rejects.toThrow('上游已返回图片地址，但下载图片时连接中断（UND_ERR_SOCKET）');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].signal).toBe(fetchMock.mock.calls[0][1].signal);
  });
});

describe('normalizeImageSize', () => {
  it('拒绝非法格式，缺省不改动已有请求', () => {
    expect(imageOutputFormatOf(undefined)).toBeUndefined();
    expect(imageOutputFormatOf('gif')).toBe('gif');
    expect(() => imageOutputFormatOf('html')).toThrow('输出格式只支持');
  });

  it.each(['gif', 'svg'] as const)('文生图请求 %s 并保存原始格式及尺寸', async (outputFormat) => {
    const buffer = outputFormat === 'svg'
      ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"></svg>')
      : Buffer.from('R0lGODlhgALgAQ==', 'base64');
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ data: [{ b64_json: buffer.toString('base64') }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const [image] = await generateImages(profile, { prompt: 'test', outputFormat });
    try {
      expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/generations');
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toMatchObject({ output_format: outputFormat });
      expect(image.fileName).toMatch(new RegExp(`\\.${outputFormat}$`));
      expect(image).toMatchObject({ width: 640, height: 480 });
      expect(await fs.readFile(image.filePath)).toEqual(buffer);
    } finally { await fs.unlink(image.filePath); }
  });

  it('编辑请求传递 output_format，保留 SVG 引用的 MIME 类型', async () => {
    const svg = '<svg viewBox="0 0 1600 900"></svg>';
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ data: [{ b64_json: Buffer.from(svg).toString('base64') }] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const [image] = await generateImages(profile, {
      prompt: '修改颜色', outputFormat: 'svg',
      referenceDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    });
    try {
      expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/v1/images/edits');
      const form = fetchMock.mock.calls[0][1].body as FormData;
      expect(form.get('output_format')).toBe('svg');
      expect((form.get('image') as File).type).toBe('image/svg+xml');
      expect(image.fileName).toMatch(/\.svg$/);
      expect(image).toMatchObject({ width: 1600, height: 900 });
    } finally { await fs.unlink(image.filePath); }
  });

  it('下载 URL 即使后缀为 PNG 也按实际 SVG 内容保存', async () => {
    const svg = '<svg viewBox="0 0 900 1600"></svg>';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ url: 'https://example.test/result.png' }] }) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => Buffer.from(svg) });
    vi.stubGlobal('fetch', fetchMock);
    const [image] = await generateImages(profile, { prompt: 'test', outputFormat: 'svg' });
    try {
      expect(image.fileName).toMatch(/\.svg$/);
      expect(image).toMatchObject({ width: 900, height: 1600 });
    } finally { await fs.unlink(image.filePath); }
  });

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

  it('保存生成图时记录真实位图尺寸，而不是请求尺寸', async () => {
    const png = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(1024, 16);
    png.writeUInt32BE(1536, 20);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: png.toString('base64') }] }),
    })));
    const [image] = await generateImages(
      { ...profile, imageApiMode: 'images' },
      { prompt: '一只猫', size: '1536x1536', apiMode: 'images' },
    );
    expect(image).toMatchObject({ width: 1024, height: 1536 });
    await fs.unlink(image.filePath);
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

  it('图像模型列表不否定同一供应商独立配置的 Responses 主模型', async () => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({
        id: 'resp_model', output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }],
      }) };
    }));
    const [image] = await generateImages({ ...profile, models: [profile.model] }, { prompt: '一只猫' });
    try {
      expect(body.model).toBe('gpt-5.5');
      expect(body.tools[0].model).toBe('gpt-image-2.5-sunburst');
      expect(image.responseModel).toBe('gpt-5.5');
    } finally { await fs.unlink(image.filePath); }
  });

  it.each([
    { references: ['data:image/png;base64,QUJD'], reusePreviousImage: undefined },
    { references: ['data:image/png;base64,QUJD', 'data:image/png;base64,REVG'], reusePreviousImage: undefined },
    { references: ['data:image/png;base64,QUJD', 'data:image/png;base64,REVG'], reusePreviousImage: true },
  ])('续接遇到未确认的参考集合时完整上传并断链：$references', async ({ references, reusePreviousImage }) => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return { ok: true, status: 200, json: async () => ({
        id: 'resp_refs', output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }],
      }) };
    }));
    const [image] = await generateImages(profile, {
      prompt: '保留基准构图，使用新参考图的颜色', previousResponseId: 'resp_old',
      referenceDataUrls: references, reusePreviousImage,
    });
    try {
      expect(body.previous_response_id).toBeUndefined();
      expect(body.input[0].content.filter((part: any) => part.type === 'input_image')
        .map((part: any) => part.image_url)).toEqual(references);
    } finally { await fs.unlink(image.filePath); }
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
      reusePreviousImage: true,
      referenceDataUrls: ['data:image/png;base64,QUJD'],
    });
    expect(body?.previous_response_id).toBe('resp_prev');
    const input = body?.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0].content.some((part) => part.type === 'input_image')).toBe(false);
    const tool = (body?.tools as Array<Record<string, unknown>>)[0];
    expect(tool.action).toBe('edit');
    await fs.unlink(image.filePath);
  });

  it('生成卡住超过 5 分钟会主动报错，不再无限等待', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      if (init.signal?.aborted) {
        abort();
        return;
      }
      init.signal?.addEventListener('abort', abort, { once: true });
    })));

    const pending = expect(generateImages(profile, { prompt: '超时测试', n: 1 }))
      .rejects.toThrow('超过 5 分钟没有返回结果');
    await vi.advanceTimersByTimeAsync(IMAGE_GENERATION_TIMEOUT_MS);
    await pending;
  });
});
