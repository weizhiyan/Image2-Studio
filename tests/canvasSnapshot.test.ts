import { describe, expect, it } from 'vitest';
import { mergeCanvasSnapshot, protectVideoTerminalNodes } from '../bridge/http';

const node = (id: string, source?: string, createdAt?: string) => ({
  id,
  data: { source, createdAt },
});

const videoNode = (id: string, data: Record<string, unknown>) => ({
  id,
  data: { kind: 'video', ...data },
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
