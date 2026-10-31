/** 推送总线：定位请求必须广播到所有标签页（定位常是跨画布操作），并按画布过滤推图。 */
import { describe, expect, it, vi } from 'vitest';
import { ackPendingLocate, addSseClient, countOpenTabs, peekPendingLocate, pushCanvasUpdated, pushImage, pushLocate, pushVideo, setBroadcastForwardBase } from '../bridge/hub';

function fakeRes() {
  const written: string[] = [];
  return {
    written,
    res: { write: (chunk: string) => { written.push(chunk); return true; } },
  };
}

describe('SSE hub', () => {
  it('pushLocate 广播给所有连接（含停在别的画布上的）', () => {
    const a = fakeRes();
    const b = fakeRes();
    const disposeA = addSseClient(a.res as never, 'canvas_1');
    const disposeB = addSseClient(b.res as never, 'canvas_2');
    pushLocate({ type: 'locate', canvasId: 'canvas_2', nodeId: 'n1', at: '2026-10-29T12:00:00.000Z' });
    expect(a.written.join('')).toContain('event: locate');
    expect(a.written.join('')).toContain('canvas_2');
    expect(b.written.join('')).toContain('event: locate');
    disposeA();
    disposeB();
    ackPendingLocate('2026-10-29T12:00:00.000Z');
  });

  it('定位请求会被保留，等页面挂载后补处理；ack 后清空', () => {
    ackPendingLocate();
    const at = new Date().toISOString();
    pushLocate({ type: 'locate', canvasId: 'canvas_2', nodeId: 'n-late', at, onlyIfOffscreen: true });
    expect(peekPendingLocate()).toMatchObject({ canvasId: 'canvas_2', nodeId: 'n-late', at });
    // 旧请求的确认不能清掉新的定位
    ackPendingLocate('2020-01-01T00:00:00.000Z');
    expect(peekPendingLocate()?.nodeId).toBe('n-late');
    ackPendingLocate(at);
    expect(peekPendingLocate()).toBeNull();
  });

  it('过期定位不再补发，避免打开旧页面突然跳镜头', () => {
    ackPendingLocate();
    pushLocate({
      type: 'locate',
      canvasId: 'canvas_2',
      nodeId: 'n-old',
      at: new Date(Date.now() - 11 * 60_000).toISOString(),
    });
    expect(peekPendingLocate()).toBeNull();
  });

  it('拿不到 HTTP 端口的 MCP 进程把推图和定位转发给真正的 bridge', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setBroadcastForwardBase('http://127.0.0.1:3788');
    try {
      pushLocate({ type: 'locate', canvasId: 'c1', nodeId: 'n1', at: new Date().toISOString() });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:3788/api/internal/broadcast',
        expect.objectContaining({ method: 'POST' }),
      );
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body).toMatchObject({ kind: 'locate', payload: { canvasId: 'c1', nodeId: 'n1' } });
    } finally {
      setBroadcastForwardBase('');
      vi.unstubAllGlobals();
      ackPendingLocate();
    }
  });

  it.each([
    ['image', () => pushImage({ type: 'image', canvasId: 'c1', nodeId: 'n1', prompt: 'p', fileName: 'f', url: '/api/files/f', jobId: 'j' })],
    ['locate', () => pushLocate({ type: 'locate', canvasId: 'c1', nodeId: 'n1', at: new Date().toISOString() })],
    ['video', () => pushVideo({ type: 'video', phase: 'done', canvasId: 'c1', nodeId: 'n1', taskId: 't1' })],
    ['canvas-updated', () => pushCanvasUpdated({ type: 'canvas-updated', canvasId: 'c1', updatedAt: new Date().toISOString() })],
  ] as const)('%s 转发等待确认并传播 HTTP/网络失败', async (_kind, push) => {
    let confirm!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { confirm = resolve; })));
    setBroadcastForwardBase('http://127.0.0.1:3788');
    try {
      let settled = false;
      const pending = Promise.resolve(push()).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      confirm(new Response('{}', { status: 200 }));
      await pending;
      vi.stubGlobal('fetch', vi.fn(async () => new Response('bridge unavailable', { status: 503 })));
      await expect(Promise.resolve(push())).rejects.toThrow(/503/);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
      await expect(Promise.resolve(push())).rejects.toThrow(/connection refused/);
    } finally {
      setBroadcastForwardBase('');
      vi.unstubAllGlobals();
      ackPendingLocate();
    }
  });

  it('pushImage 只推给订阅了该画布的连接', () => {
    const mine = fakeRes();
    const other = fakeRes();
    const disposeMine = addSseClient(mine.res as never, 'canvas_1');
    const disposeOther = addSseClient(other.res as never, 'canvas_2');
    pushImage({ type: 'image', canvasId: 'canvas_1', nodeId: 'n1', prompt: 'p', fileName: 'f', url: '/api/files/f', jobId: 'j' });
    expect(mine.written.join('')).toContain('event: image');
    expect(other.written).toHaveLength(0);
    disposeMine();
    disposeOther();
  });

  it('断开的连接不再计入在线标签页', () => {
    const before = countOpenTabs();
    const fake = fakeRes();
    const dispose = addSseClient(fake.res as never, null);
    expect(countOpenTabs()).toBe(before + 1);
    dispose();
    expect(countOpenTabs()).toBe(before);
  });

  it('pushVideo 按画布过滤，四种 phase 都能推', () => {
    const mine = fakeRes();
    const other = fakeRes();
    const disposeMine = addSseClient(mine.res as never, 'canvas_1');
    const disposeOther = addSseClient(other.res as never, 'canvas_2');
    const phases = ['submitted', 'progress', 'done', 'failed'] as const;
    for (const phase of phases) {
      pushVideo({ type: 'video', phase, canvasId: 'canvas_1', nodeId: 'n1', taskId: 't1' });
    }
    const text = mine.written.join('');
    expect(text).toContain('event: video');
    for (const phase of phases) expect(text).toContain(phase);
    expect(other.written).toHaveLength(0);
    disposeMine();
    disposeOther();
  });
});
