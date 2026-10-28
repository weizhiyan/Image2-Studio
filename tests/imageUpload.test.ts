import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveImageDataUrl } from '../src/lib/bridge';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('本地图片上传', () => {
  it('保存成功返回媒体路径，并清理超时计时器', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { url: '/api/files/upload.png', fileName: 'upload.png' } })));
    vi.stubGlobal('fetch', fetch);
    await expect(saveImageDataUrl('data:image/png;base64,AAAA')).resolves.toEqual({ url: '/api/files/upload.png', fileName: 'upload.png' });
    expect(fetch).toHaveBeenCalledWith('/api/files', expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('排队或响应卡住时中断请求并返回可重试原因', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const pending = expect(saveImageDataUrl('data:image/png;base64,AAAA')).rejects.toThrow('图片保存超时，请重试');
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('保留服务端错误原因，不把所有失败误报成未连接', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ msg: '磁盘写入失败' }), { status: 400 })));
    await expect(saveImageDataUrl('data:image/png;base64,AAAA')).rejects.toThrow('磁盘写入失败');
  });
});
