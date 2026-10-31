import { describe, expect, it } from 'vitest';
import { mergeCanvasGraphChanges, mergeCanvasSnapshot, protectVideoTerminalNodes } from '../bridge/http';
import { canvasGraphChanges, hasCanvasGraphChanges } from '../src/lib/bridge';
import type { CanvasDoc } from '../src/types';

const node = (id: string, source?: string, createdAt?: string) => ({
  id,
  data: { source, createdAt },
});

const videoNode = (id: string, data: Record<string, unknown>) => ({
  id,
  data: { kind: 'video', ...data },
});

const canvasDoc = (overrides: Record<string, unknown>): CanvasDoc => ({
  id: 'c1',
  name: '测试',
  nodes: [],
  edges: [],
  updatedAt: '2026-10-22T10:00:00.000Z',
  ...overrides,
} as unknown as CanvasDoc);

describe('画布变更集合并', () => {
  it('合并不同标签页对各自节点的修改', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'a', data: { text: 'A2' } }, { id: 'b', data: { text: 'B1' } }],
      edges: [],
      updatedAt: '2026-10-22T10:00:00.000Z',
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [{ id: 'b', data: { text: 'B2' } }],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:00:00.000Z', '2026-10-22T10:01:00.000Z');

    expect(merged.nodes).toEqual([
      { id: 'a', data: { text: 'A2' } },
      { id: 'b', data: { text: 'B2' } },
    ]);
  });

  it('基线早于另一标签页的删除时，不把已删节点带回来', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'b', data: {} }],
      edges: [],
      updatedAt: '2026-10-22T10:02:00.000Z',
      deletedNodeIds: { a: '2026-10-22T10:02:00.000Z' },
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [{ id: 'a', data: { text: '旧快照' } }],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:01:00.000Z', '2026-10-22T10:03:00.000Z');

    expect((merged.nodes as Array<{ id: string }>).map((item) => item.id)).toEqual(['b']);
  });

  it('客户端已经看到删除后主动恢复节点时允许重新加入', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'b', data: {} }],
      edges: [],
      updatedAt: '2026-10-22T10:02:00.000Z',
      deletedNodeIds: { a: '2026-10-22T10:02:00.000Z' },
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [{ id: 'a', data: { text: '撤销恢复' } }],
      nodeDeletes: [],
      edgeUpserts: [],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:03:00.000Z', '2026-10-22T10:04:00.000Z');

    expect((merged.nodes as Array<{ id: string }>).map((item) => item.id)).toEqual(['b', 'a']);
    expect(merged.deletedNodeIds?.a).toBeUndefined();
  });

  it('删除节点时同时清理依赖连线', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'a', data: {} }, { id: 'b', data: {} }],
      edges: [{ id: 'ab', source: 'a', target: 'b' }],
      updatedAt: '2026-10-22T10:00:00.000Z',
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [],
      nodeDeletes: ['a'],
      edgeUpserts: [],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:00:00.000Z', '2026-10-22T10:01:00.000Z');

    expect((merged.nodes as Array<{ id: string }>).map((item) => item.id)).toEqual(['b']);
    expect(merged.edges).toEqual([]);
  });

  it('新增连线只接到仍存在的节点上', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'a', data: {} }],
      edges: [],
      updatedAt: '2026-10-22T10:00:00.000Z',
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [],
      nodeDeletes: [],
      edgeUpserts: [{ id: 'x', source: 'a', target: 'gone' }],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:00:00.000Z', '2026-10-22T10:01:00.000Z');

    expect(merged.edges).toEqual([]);
  });

  it('旧标签页的连线更新不会复活另一标签页已删的连线', () => {
    const previous = {
      name: '测试',
      nodes: [{ id: 'a', data: {} }, { id: 'b', data: {} }],
      edges: [],
      updatedAt: '2026-10-22T10:02:00.000Z',
      deletedEdgeIds: { ab: '2026-10-22T10:02:00.000Z' },
    };

    const merged = mergeCanvasGraphChanges(previous, {
      nodeUpserts: [],
      nodeDeletes: [],
      edgeUpserts: [{ id: 'ab', source: 'a', target: 'b' }],
      edgeDeletes: [],
    }, '测试', '2026-10-22T10:01:00.000Z', '2026-10-22T10:03:00.000Z');

    expect(merged.edges).toEqual([]);
  });
});

describe('客户端画布变更集', () => {
  it('只发送相对基线发生变化的节点和连线', () => {
    const baseline = canvasDoc({
      nodes: [
        { id: 'a', type: 'x', position: { x: 0, y: 0 }, data: { text: 'A' } },
        { id: 'b', type: 'x', position: { x: 0, y: 0 }, data: { text: 'B' } },
      ],
      edges: [{ id: 'ab', source: 'a', target: 'b' }],
    });
    const incoming = canvasDoc({
      nodes: [
        { id: 'a', type: 'x', position: { x: 0, y: 0 }, data: { text: 'A' } },
        { id: 'b', type: 'x', position: { x: 0, y: 0 }, data: { text: 'B2' } },
        { id: 'c', type: 'x', position: { x: 0, y: 0 }, data: { text: 'C' } },
      ],
      edges: [],
    });

    const changes = canvasGraphChanges(baseline, incoming);

    expect(changes.nodeUpserts.map((item) => item.id)).toEqual(['b', 'c']);
    expect(changes.nodeDeletes).toEqual([]);
    expect(changes.edgeDeletes).toEqual(['ab']);
    expect(hasCanvasGraphChanges(changes)).toBe(true);
  });

  it('基线为空时把本地内容全部作为新增发送', () => {
    const incoming = canvasDoc({
      nodes: [{ id: 'a', type: 'x', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    const changes = canvasGraphChanges(undefined, incoming);

    expect(changes.nodeUpserts.map((item) => item.id)).toEqual(['a']);
    expect(changes.nodeDeletes).toEqual([]);
    expect(changes.name).toBe('测试');
  });

  it('内容没有变化时变更集为空', () => {
    const baseline = canvasDoc({
      nodes: [{ id: 'a', type: 'x', position: { x: 0, y: 0 }, data: {} }],
      edges: [],
    });

    const changes = canvasGraphChanges(baseline, baseline);

    expect(hasCanvasGraphChanges(changes)).toBe(false);
  });
});

describe('视频终态保护', () => {
  it('旧快照缺 videoUrl 时，保留已生成的视频', () => {
    const done = videoNode('v1', {
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      videoFileName: 'v.mp4',
      videoTaskId: 't1',
      createdAt: '2026-10-25T00:31:00.000Z',
      finishedAt: '2026-10-25T00:36:00.000Z',
    });
    const stale = videoNode('v1', {
      videoStatus: 'running',
      videoProgress: 30,
      videoUrl: '',
      createdAt: '2026-10-25T00:31:00.000Z',
    });

    const result = protectVideoTerminalNodes([done], [stale]) as Array<{ data: Record<string, unknown> }>;
    expect(result[0].data).toMatchObject({
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      videoFileName: 'v.mp4',
      videoTaskId: 't1',
    });
  });

  it('用户已开始新一轮（createdAt 晚于完成时间）时允许清空', () => {
    const done = videoNode('v1', {
      videoStatus: 'done',
      videoUrl: '/api/files/v.mp4',
      createdAt: '2026-10-25T00:31:00.000Z',
      finishedAt: '2026-10-25T00:36:00.000Z',
    });
    const fresh = videoNode('v1', {
      videoStatus: 'running',
      videoUrl: '',
      createdAt: '2026-10-25T00:40:00.000Z',
    });

    const result = protectVideoTerminalNodes([done], [fresh]) as Array<{ data: Record<string, unknown> }>;
    expect(result[0].data).toMatchObject({ videoStatus: 'running', videoUrl: '' });
  });

  it('两边都是终态时以后到的为准，不额外改写', () => {
    const doneA = videoNode('v1', { videoStatus: 'done', videoUrl: '/a.mp4' });
    const doneB = videoNode('v1', { videoStatus: 'done', videoUrl: '/b.mp4' });
    const result = protectVideoTerminalNodes([doneA], [doneB]) as Array<{ data: Record<string, unknown> }>;
    expect(result[0].data.videoUrl).toBe('/b.mp4');
  });
});

describe('画布快照保存', () => {
  it('删除节点和连线后不会把旧快照中的条目合并回来', () => {
    const image = node('image');
    const video = node('video');
    const result = mergeCanvasSnapshot(
      [image, video],
      [video],
      [],
      '2026-10-22T10:00:00.000Z',
    );

    expect(result.nodes).toEqual([video]);
    expect(result.edges).toEqual([]);
  });

  it('只从较旧的本地快照补回随后由 MCP 新增的节点', () => {
    const local = node('local');
    const external = node('external', 'mcp', '2026-10-22T10:01:00.000Z');
    const result = mergeCanvasSnapshot(
      [local, external],
      [local],
      [],
      '2026-10-22T10:00:00.000Z',
    );

    expect(result.nodes).toEqual([local, external]);
  });

  it('快照时间晚于 MCP 节点时尊重用户删除，不再复活节点', () => {
    const external = node('external', 'mcp', '2026-10-22T10:01:00.000Z');
    const result = mergeCanvasSnapshot(
      [external],
      [],
      [],
      '2026-10-22T10:02:00.000Z',
    );

    expect(result.nodes).toEqual([]);
  });
});
