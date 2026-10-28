import { describe, expect, it } from 'vitest';
import { protectVideoTerminalNodes } from '@/stores/canvasStore';
import type { CanvasDoc } from '@/types';

function doc(updatedAt: string, data: Record<string, unknown>): CanvasDoc {
  return {
    id: 'c1',
    name: '测试',
    updatedAt,
    nodes: [{ id: 'v1', type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'video', ...data } }],
    edges: [],
  } as unknown as CanvasDoc;
}

describe('前端画布合并的视频终态保护', () => {
  it('胜出的旧快照缺 videoUrl 时，从另一份补回已完成视频', () => {
    const stale = doc('2026-10-25T00:40:00.000Z', {
      videoStatus: 'running',
      videoUrl: '',
      createdAt: '2026-10-25T00:31:00.000Z',
    });
    const done = doc('2026-10-25T00:37:00.000Z', {
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      videoFileName: 'v.mp4',
      createdAt: '2026-10-25T00:31:00.000Z',
      finishedAt: '2026-10-25T00:36:00.000Z',
    });

    const merged = protectVideoTerminalNodes(stale, done);
    expect(merged.nodes[0].data).toMatchObject({
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      videoFileName: 'v.mp4',
    });
  });

  it('用户开了新一轮时不清空保护', () => {
    const stale = doc('2026-10-25T00:40:00.000Z', {
      videoStatus: 'running',
      videoUrl: '',
      createdAt: '2026-10-25T00:40:00.000Z',
    });
    const done = doc('2026-10-25T00:37:00.000Z', {
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      createdAt: '2026-10-25T00:31:00.000Z',
      finishedAt: '2026-10-25T00:36:00.000Z',
    });

    const merged = protectVideoTerminalNodes(stale, done);
    expect(merged.nodes[0].data).toMatchObject({ videoStatus: 'running', videoUrl: '' });
  });
});
