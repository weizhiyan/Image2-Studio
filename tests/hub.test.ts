/** 推送总线：定位请求必须广播到所有标签页（定位常是跨画布操作），并按画布过滤推图。 */
import { describe, expect, it } from 'vitest';
import { addSseClient, countOpenTabs, pushImage, pushLocate, pushVideo } from '../bridge/hub';

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
    pushLocate({ type: 'locate', canvasId: 'canvas_2', nodeId: 'n1', at: 'now' });
    expect(a.written.join('')).toContain('event: locate');
    expect(a.written.join('')).toContain('canvas_2');
    expect(b.written.join('')).toContain('event: locate');
    disposeA();
    disposeB();
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
