import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProviderModels, parseProviderModels } from '../bridge/providerApi';

afterEach(() => vi.unstubAllGlobals());

describe('模型列表', () => {
  it('识别 OpenAI 列表、路由器 slug 和嵌套列表，并去重', () => {
    expect(parseProviderModels({ data: [{ id: 'image-a' }, { id: 'image-a' }] })).toEqual(['image-a']);
    expect(parseProviderModels({ models: [{ slug: 'image-b' }] })).toEqual(['image-b']);
    expect(parseProviderModels({ data: { models: ['image-c', { name: 'image-d' }] } })).toEqual(['image-c', 'image-d']);
    expect(parseProviderModels({ data: [], models: [{ id: 'image-e' }] })).toEqual(['image-e']);
    expect(parseProviderModels({ result: { items: [{ model_id: 'image-f' }, { model_name: 'image-g' }] } })).toEqual(['image-f', 'image-g']);
  });

  it('单次请求；未开放列表时提示手动添加', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: 'https://example.test/v1/', apiKey: 'test' }))
      .rejects.toThrow(/手动填写模型名/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/v1/models');
  });

  it('完整操作地址或没有 v1 的地址会尝试对应模型列表路径', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://example.test/images/generations/models') return new Response('', { status: 404 });
      return new Response(JSON.stringify({ data: [{ id: 'image-g' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: 'https://example.test/images/generations', apiKey: 'test' }))
      .resolves.toEqual(['image-g']);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://example.test/models',
    ]);
  });

  it('主机地址在 /models 不存在时回落 /v1/models', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [{ id: 'image-h' }] }), { status: 200 })
        : new Response('', { status: 404 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: 'https://example.test', apiKey: 'test' }))
      .resolves.toEqual(['image-h']);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://example.test/models',
      'https://example.test/v1/models',
    ]);
  });

  it('根路径鉴权失败时仍会尝试 /v1/models', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.endsWith('/v1/models')
        ? new Response(JSON.stringify({ data: [{ id: 'image-i' }] }), { status: 200 })
        : new Response('', { status: 401 })
    ));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: 'https://example.test', apiKey: 'test' }))
      .resolves.toEqual(['image-i']);
  });

  it('已经填写 /models 时不再重复拼接路径', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'image-j' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchProviderModels({ baseUrl: 'https://example.test/models', apiKey: 'test' }))
      .resolves.toEqual(['image-j']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
