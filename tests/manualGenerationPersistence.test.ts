import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-manual-generation-'));
process.env.HUIBAN_DATA_ROOT = root;

const mocks = vi.hoisted(() => ({
  generateImages: vi.fn(),
  enhancePromptDetailed: vi.fn(),
}));

vi.mock('../bridge/textApi.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../bridge/textApi')>(),
  enhancePromptDetailed: mocks.enhancePromptDetailed,
}));

vi.mock('../bridge/imageApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bridge/imageApi')>();
  return { ...actual, generateImages: mocks.generateImages };
});

const { createHttpServer } = await import('../bridge/http');
const { MEDIA_DIR } = await import('../bridge/paths');
const server = createHttpServer();
let base = '';

const settingsFile = path.join(root, 'settings.json');
const registryFile = path.join(root, 'canvases.json');
const docsFile = path.join(root, 'canvas-docs.json');

const readDocs = async () => JSON.parse(await fs.readFile(docsFile, 'utf8'));

beforeAll(async () => {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  base = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  mocks.generateImages.mockReset();
  mocks.enhancePromptDetailed.mockReset();
  await fs.writeFile(settingsFile, JSON.stringify({
    profiles: [{
      id: 'image-profile',
      name: 'Mock Image',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'sk-test',
      model: 'gpt-image-1',
      defaultSize: '1024x1024',
      models: ['gpt-image-1'],
      enabledModels: ['gpt-image-1'],
      kind: 'image',
      textFormat: 'auto',
      imageApiMode: 'images',
    }],
    activeProfileId: 'image-profile',
    direct: true,
    promptOptimizationEnabled: false,
    textProfileId: '',
    enhanceLevel: 'balanced',
  }));
  await fs.writeFile(registryFile, JSON.stringify({ c1: '画布' }));
  await fs.writeFile(docsFile, JSON.stringify({
    c1: {
      name: '画布',
      nodes: [{
        id: 'manual',
        type: 'flow-image',
        position: { x: 0, y: 0 },
        data: { kind: 'composer', source: 'browser', status: 'running', prompt: '测试' },
      }],
      edges: [],
    },
  }));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

describe('浏览器手动生图持久化', () => {
  it('自动优化返回的比例进入实际生成请求和落盘记录', async () => {
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    settings.profiles.push({ ...settings.profiles[0], id: 'text-profile', kind: 'text', model: 'text-model' });
    settings.textProfileId = 'text-profile';
    await fs.writeFile(settingsFile, JSON.stringify(settings));
    mocks.enhancePromptDetailed.mockResolvedValue({ prompt: '竖版2:3开业海报，主标题突出，活动区域分组。', aspectRatio: '2:3', usage: 'style' });
    const enhanced = await fetch(`${base}/api/enhance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '做张开业海报', size: '1024x1024', aspectRatio: 'auto', referenceSize: '1536x1024' }),
    });
    expect(enhanced.status).toBe(200);
    const result = (await enhanced.json()).data;
    expect(result.aspectRatio).toBe('2:3');
    expect(mocks.enhancePromptDetailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aspectRatio: 'auto', referenceSize: '1536x1024' }));
    const { planImageGeneration, resolvePlannedImageSize } = await import('../src/lib/imageGenerationPlan');
    const plan = planImageGeneration({ prompt: '做张开业海报', ratio: 'auto', optimize: true, defaultSize: '1024x1024' });
    const size = resolvePlannedImageSize(plan, result);
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/planned.png', fileName: 'planned.png' }]);
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: result.prompt, originalPrompt: '做张开业海报', size, canvasId: 'c1', nodeId: 'manual' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ size, prompt: result.prompt }));
    const node = (await readDocs()).c1.nodes.find((item: { id: string }) => item.id === 'manual');
    expect(node.data.size).toBe(size);
    expect(node.data.enhancedPrompt).toBe(result.prompt);
  });

  it('传递 SVG 输出格式并按真实宽高保存到画布', async () => {
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/manual.svg', fileName: 'manual.svg', width: 1600, height: 900 }]);
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '测试矢量图', canvasId: 'c1', nodeId: 'manual', outputFormat: 'svg' }),
    });
    expect(response.status).toBe(200);
    expect(mocks.generateImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outputFormat: 'svg' }));
    const node = (await readDocs()).c1.nodes.find((item: { id: string }) => item.id === 'manual');
    expect(node.data).toMatchObject({ status: 'done', fileName: 'manual.svg', outputFormat: 'svg', width: 1600, height: 900 });
  });

  it('SVG 以正确 MIME 和隔离策略返回，保留矢量源文件', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="red"/></svg>';
    await fs.writeFile(path.join(MEDIA_DIR, 'test.svg'), source);
    const response = await fetch(`${base}/api/files/test.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(source);
  });

  it('手动 Responses 请求使用图像供应商独立配置的主模型并传递纯基准续接标记', async () => {
    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    settings.direct = false;
    settings.profiles[0].imageApiMode = 'responses';
    settings.profiles[0].responsesModel = 'same-provider-reasoner';
    await fs.writeFile(settingsFile, JSON.stringify(settings));
    mocks.generateImages.mockResolvedValue([{ url: '/api/files/manual.png', fileName: 'manual.png' }]);
    const response = await fetch(`${base}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '只把背景改蓝', apiMode: 'responses', canvasId: 'c1', nodeId: 'manual',
        profileId: 'image-profile', model: 'gpt-image-1',
        previousResponseId: 'resp_base', previousImageGenerationCallId: 'ig_base',
        reusePreviousImage: true, referenceDataUrls: ['data:image/png;base64,QUJD'],
        referenceUsage: 'edit',
      }),
    });
    expect(response.status).toBe(200);
    expect(mocks.generateImages.mock.calls[0][1]).toMatchObject({
      model: 'gpt-image-1', responseModel: 'same-provider-reasoner',
      previousResponseId: 'resp_base', reusePreviousImage: true,
    });
  });

  it('客户端刷新断开后，bridge 仍把结果写回原节点', async () => {
    mocks.generateImages.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [{ url: '/api/files/manual.png', fileName: 'manual.png', width: 1024, height: 1536 }];
    });

    const controller = new AbortController();
    const request = fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: '测试',
        canvasId: 'c1',
        nodeId: 'manual',
        profileId: 'image-profile',
        model: 'gpt-image-1',
        size: '1024x1024',
      }),
      signal: controller.signal,
    }).catch(() => null);

    await vi.waitFor(() => expect(mocks.generateImages).toHaveBeenCalledOnce());
    controller.abort();
    await request;

    await vi.waitFor(async () => {
      const node = (await readDocs()).c1.nodes.find((item: { id: string }) => item.id === 'manual');
      expect(node?.data).toMatchObject({
        kind: 'image',
        status: 'done',
        source: 'browser',
        imageUrl: '/api/files/manual.png',
        fileName: 'manual.png',
        size: '1024x1536',
        width: 1024,
        height: 1536,
        activeVersionId: expect.stringMatching(/^ver_job_/),
      });
      expect(node?.data.versions).toHaveLength(1);
      expect(node?.data.versions[0]).toMatchObject({
        size: '1024x1536',
        width: 1024,
        height: 1536,
      });
    }, { timeout: 1_000, interval: 20 });
  });
});
