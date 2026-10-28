import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetVideoProtocolCacheForTest, detectVideoProtocol, ensureVideoApiMode } from '../bridge/videoProtocol.js';
import type { ModelProfile } from '../bridge/settings.js';

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'video-profile',
    name: '视频模型',
    baseUrl: 'https://relay.example.com',
    apiKey: 'sk-test',
    model: 'grok-video-1.0',
    defaultSize: '',
    models: [],
    enabledModels: [],
    kind: 'video',
    textFormat: 'auto',
    imageApiMode: 'images',
    responsesModel: 'gpt-5.5',
    videoApiMode: 'auto',
    enabled: true,
    ...overrides,
  } as ModelProfile;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('视频协议探测', () => {
  beforeEach(() => {
    __resetVideoProtocolCacheForTest();
    vi.unstubAllGlobals();
  });

  it('配置里显式指定协议时直接采用，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const detection = await detectVideoProtocol(profile({ videoApiMode: 'media-v1' }));
    expect(detection).toMatchObject({ mode: 'media-v1', confidence: 'high' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Base URL 里粘了完整 endpoint 时按路径识别，不发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const detection = await detectVideoProtocol(profile({ baseUrl: 'https://relay.example.com/v1/videos' }));
    expect(detection.mode).toBe('openai-videos');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('xAI 官方域名与完整 Grok generations endpoint 识别为 xai-videos', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const fromHost = await detectVideoProtocol(profile({ baseUrl: 'https://api.x.ai' }));
    const fromPath = await detectVideoProtocol(profile({ baseUrl: 'https://relay.example.com/v1/videos/generations' }));
    expect(fromHost.mode).toBe('xai-videos');
    expect(fromPath.mode).toBe('xai-videos');
    expect((await detectVideoProtocol(profile({ baseUrl: 'https://api.x.ai/v1/videos' }))).mode)
      .toBe('xai-videos');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('/skills/models?type=video 有模型时识别为 media-v1', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/skills/models?type=video')) {
        return jsonResponse({ models: [{ name: 'wan2.6' }, { name: 'seedance-2.0' }] });
      }
      return jsonResponse({}, 404);
    }));
    const detection = await detectVideoProtocol(profile({ baseUrl: 'https://free.kk0606.com' }));
    expect(detection).toMatchObject({ mode: 'media-v1', confidence: 'high' });
    expect(detection.models).toEqual(['wan2.6', 'seedance-2.0']);
  });

  it('/models 里有视频家族模型时识别为 openai-videos', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/skills/models')) return jsonResponse({}, 404);
      if (url.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'gpt-image-1' }, { id: 'grok-video-1.5' }] });
      }
      return jsonResponse({}, 404);
    }));
    const detection = await detectVideoProtocol(profile({ baseUrl: 'https://api.manxiaobai.online' }));
    expect(detection).toMatchObject({ mode: 'openai-videos', confidence: 'high' });
    expect(detection.models).toEqual(['grok-video-1.5']);
  });

  it('什么都探测不到时回退 openai-videos 并明确低置信度', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    const detection = await detectVideoProtocol(profile());
    expect(detection).toMatchObject({ mode: 'openai-videos', confidence: 'low' });
    expect(detection.evidence).toContain('OpenAI Videos');
  });

  it('探测结果有缓存，force 才重新探测', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/skills/models')) return jsonResponse({}, 404);
      if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'veo-3.1' }] });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    await detectVideoProtocol(profile());
    const afterFirst = fetchMock.mock.calls.length;
    await detectVideoProtocol(profile());
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    await detectVideoProtocol(profile(), { force: true });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('ensureVideoApiMode 返回落成确定协议的 profile 副本', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/skills/models')) return jsonResponse({ models: [{ name: 'wan2.6' }] });
      return jsonResponse({}, 404);
    }));
    const source = profile({ baseUrl: 'https://free.kk0606.com' });
    const runtime = await ensureVideoApiMode(source);
    expect(runtime.videoApiMode).toBe('media-v1');
    expect(source.videoApiMode).toBe('auto');
    expect(runtime).not.toBe(source);
  });
});
