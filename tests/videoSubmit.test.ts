import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitVideoTask } from '../src/lib/bridge';

afterEach(() => vi.unstubAllGlobals());

describe('视频提交结果', () => {
  it('本地连接中断时标记结果未知，避免无提示重发', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection reset'); }));

    await expect(submitVideoTask({ nodeId: 'node', canvasId: 'canvas', prompt: 'a video' })).resolves.toMatchObject({
      ok: false,
      submissionUnknown: true,
      error: expect.stringContaining('避免重复提交'),
    });
  });

  it('明确的客户端错误不误报为未知受理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ msg: '图床未配置' }), { status: 400 })));

    await expect(submitVideoTask({ nodeId: 'node', canvasId: 'canvas', prompt: 'a video' })).resolves.toMatchObject({
      ok: false,
      submissionUnknown: false,
      error: '图床未配置',
    });
  });

  it('图床在视频提交前返回 502 时按明确失败处理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ msg: '图片上传图床失败' }), { status: 502 })));

    await expect(submitVideoTask({ nodeId: 'node', canvasId: 'canvas', prompt: 'a video' })).resolves.toMatchObject({
      ok: false,
      submissionUnknown: false,
      error: '图片上传图床失败',
    });
  });
});
