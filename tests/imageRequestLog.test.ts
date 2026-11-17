import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../bridge/settings';

const originalRoot = process.env.HUIBAN_DATA_ROOT;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-image-log-'));
process.env.HUIBAN_DATA_ROOT = root;
const { describeImageRequest, fetchImageRequest, IMAGE_REQUEST_LOG_PATH, IMAGE_REQUEST_LOG_LIMIT } = await import('../bridge/imageRequestLog');
const { generateImages } = await import('../bridge/imageApi');
const profile: ModelProfile = {
  id: 'test', name: 'test provider', baseUrl: 'https://example.com/v1', apiKey: 'private-api-key',
  model: 'test-image', defaultSize: '1024x1024', models: [], enabledModels: [],
  kind: 'image', textFormat: 'auto', imageApiMode: 'images', responsesModel: 'test-text',
};
const records = async () => (await fs.readFile(IMAGE_REQUEST_LOG_PATH, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

beforeEach(async () => {
  await fs.mkdir(path.join(root, 'media'), { recursive: true });
  await fs.rm(path.dirname(IMAGE_REQUEST_LOG_PATH), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
  else process.env.HUIBAN_DATA_ROOT = originalRoot;
  await fs.rm(root, { recursive: true, force: true });
});

describe('实际生图请求记录', () => {
  it.each(['设计一个黑白Logo，不要阴影', '只把文字颜色改成蓝色，保留图1的人物', 'A flat icon without natural lighting'])('直连发送原文且日志与请求一致：%s', async prompt => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] })));
    vi.stubGlobal('fetch', fetchMock);
    await generateImages(profile, { prompt, originalPrompt: prompt, size: '1024x1536' });
    const actual = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    const logged = (await records()).find(item => item.event === 'request');
    expect(actual.prompt).toBe(prompt);
    expect(logged.actualProviderPrompt).toBe(actual.prompt);
    expect(logged.parameters.size).toBe(actual.size);
    expect(logged.parameters.quality).toBeNull();
  });

  it('记录实际编辑图片的顺序和摘要，不记录密钥、图片内容或URL查询参数', async () => {
    const form = new FormData();
    form.set('model', 'test-image');
    form.set('prompt', '图1是主体，图2是版式');
    form.set('size', '1024x1024');
    form.set('n', '2');
    form.set('input_fidelity', 'high');
    form.append('image[]', new Blob(['first-image'], { type: 'image/png' }));
    form.append('image[]', new Blob(['second-image'], { type: 'image/png' }));
    const detail = await describeImageRequest(profile, { originalPrompt: '原始需求', optimizedPrompt: '整理后需求' },
      'https://user:password@example.com/v1/images/edits?api_key=secret', { body: form, headers: { Authorization: 'Bearer private-api-key' } });
    expect(detail).toMatchObject({ originalPrompt: '原始需求', optimizedPrompt: '整理后需求', actualProviderPrompt: '图1是主体，图2是版式', parameters: { count: 2, inputFidelity: 'high' } });
    expect(detail.referenceImages.map(item => item.index)).toEqual([1, 2]);
    expect(detail.referenceImages[0].sha256).not.toBe(detail.referenceImages[1].sha256);
    expect(JSON.stringify(detail)).not.toMatch(/private-api-key|password|secret|first-image|second-image/);
  });

  it('Responses回退记录两次实际提示词与参数，不把参考图继承误记成重新上传', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }] })));
    vi.stubGlobal('fetch', fetchMock);
    await generateImages(profile, {
      apiMode: 'responses', prompt: '继续修改', imagesPrompt: '完整回退提示词',
      originalPrompt: '用户原文', optimizedPrompt: '模型方案', quality: 'high',
      previousResponseId: 'resp_base', reusePreviousImage: true,
      referenceDataUrls: ['data:image/png;base64,QUJD'], inputFidelity: 'high',
      requestContext: { source: 'chat', canvasId: 'canvas', nodeId: 'node', runId: 'run' },
    });
    const requests = (await records()).filter(item => item.event === 'request');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ actualProviderPrompt: '继续修改', modelId: 'test-image', responseModel: 'test-text', parameters: { action: 'edit', previousResponseId: 'resp_base', inputFidelity: null, quality: 'high' }, referenceImages: [] });
    expect(requests[1]).toMatchObject({ actualProviderPrompt: '完整回退提示词', parameters: { inputFidelity: 'high', quality: 'high' }, context: { nodeId: 'node', runId: 'run' } });
    expect(requests[1].referenceImages).toHaveLength(1);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    expect((await records()).filter(item => item.event === 'response').map(item => item.status)).toEqual([404, 200]);
  });

  it('诊断文件写入失败不影响请求，也不输出可能含密钥的磁盘错误', async () => {
    const write = vi.spyOn(fs, 'appendFile').mockRejectedValue(new Error('private-api-key'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const response = await fetchImageRequest(profile, {}, 'https://example.com/v1/images/generations', { body: JSON.stringify({ model: 'test-image', prompt: '原文' }) });
    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-api-key');
  });

  it('网络错误仅记录错误码并保留原异常，不重新提交请求', async () => {
    const failure = Object.assign(new TypeError('secret response text'), { cause: { code: 'ECONNRESET' } });
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchImageRequest(profile, {}, 'https://example.com/v1/images/generations', { body: JSON.stringify({ prompt: '原文' }) })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await records()).at(-1)).toMatchObject({ event: 'error', code: 'ECONNRESET' });
    expect(await fs.readFile(IMAGE_REQUEST_LOG_PATH, 'utf8')).not.toContain('secret response text');
  });

  it('超过大小限制轮换日志，只保留一个旧文件', async () => {
    await fs.mkdir(path.dirname(IMAGE_REQUEST_LOG_PATH), { recursive: true });
    await fs.writeFile(IMAGE_REQUEST_LOG_PATH, Buffer.alloc(IMAGE_REQUEST_LOG_LIMIT, ' '));
    await fs.writeFile(`${IMAGE_REQUEST_LOG_PATH}.1`, 'older log');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    await fetchImageRequest(profile, {}, 'https://example.com/v1/images/generations', { body: JSON.stringify({ prompt: '原文' }) });
    expect((await records()).map(item => item.event)).toEqual(['request', 'response']);
    expect((await fs.stat(`${IMAGE_REQUEST_LOG_PATH}.1`)).size).toBe(IMAGE_REQUEST_LOG_LIMIT);
  });
});
