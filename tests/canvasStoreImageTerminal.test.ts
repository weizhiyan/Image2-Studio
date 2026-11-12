import { describe, expect, it } from 'vitest';
import { protectImageTerminalNodes, useCanvasStore } from '@/stores/canvasStore';
import type { CanvasDoc } from '@/types';

function doc(updatedAt: string, data: Record<string, unknown>): CanvasDoc {
  return {
    id: 'c1', name: '测试', updatedAt, edges: [],
    nodes: [{ id: 'image', type: 'flow-image', position: { x: 20, y: 30 }, data: { kind: 'composer', ...data } }],
  } as unknown as CanvasDoc;
}

describe('图片生成状态恢复', () => {
  const createdAt = '2026-11-04T01:00:00.000Z';
  const finishedAt = '2026-11-04T01:02:00.000Z';
  const running = doc('2026-11-04T01:04:00.000Z', { status: 'running', stage: 'generate', runningDirect: true, createdAt });
  const interrupted = doc(finishedAt, {
    status: 'error', error: 'Bridge 已重启', createdAt, finishedAt,
    versions: [{ id: 'v1', imageUrl: '/api/files/previous.png' }],
    activeVersionId: 'v1', reditBaseVersionId: 'v1',
  });

  it('本地快照更新时间较新时，仍采纳 bridge 的同轮终态并保留历史图片', () => {
    const result = protectImageTerminalNodes(running, interrupted);
    expect(result.nodes[0].data).toMatchObject({
      status: 'error', stage: undefined, runningDirect: undefined, finishedAt,
      versions: interrupted.nodes[0].data.versions,
    });
    expect(result.nodes[0].position).toEqual(running.nodes[0].position);
    const previous = useCanvasStore.getState();
    try {
      useCanvasStore.setState({ canvases: [running], activeId: 'c1' });
      useCanvasStore.getState().mergeCanvases([interrupted]);
      expect(useCanvasStore.getState().canvases[0].nodes[0].data.status).toBe('error');
    } finally {
      useCanvasStore.setState(previous);
    }
  });

  it('用户重试的新一轮不会被上次错误覆盖，刷新在途任务也不会凭空判失败', () => {
    const retry = doc('2026-11-04T01:04:00.000Z', { status: 'running', createdAt: '2026-11-04T01:03:00.000Z' });
    expect(protectImageTerminalNodes(retry, interrupted)).toBe(retry);
    expect(protectImageTerminalNodes(running, running)).toBe(running);
  });
});
