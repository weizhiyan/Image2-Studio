import { describe, expect, it } from 'vitest';
import { collectHistoryItems, removeHistoryTargetFromCanvas, stripChatMediaReferences } from '../bridge/history';

describe('collectHistoryItems', () => {
  it('includes completed videos alongside image versions', () => {
    const items = collectHistoryItems({
      canvasA: {
        name: '测试画布',
        nodes: [
          {
            id: 'image-1',
            data: {
              kind: 'image',
              versions: [{ id: 'v1', imageUrl: '/api/files/a.png', prompt: '图像提示词', finishedAt: '2026-10-20T10:00:00Z' }],
            },
          },
          {
            id: 'video-1',
            data: {
              kind: 'video',
              videoStatus: 'done',
              videoUrl: '/api/files/a.mp4',
              videoFileName: 'a.mp4',
              videoModel: 'video-model',
              videoSeconds: 5,
              videoResolution: '720p',
              videoRatio: '16:9',
              videoAudio: false,
              prompt: '视频提示词',
              createdAt: '2026-10-20T10:01:00Z',
              finishedAt: '2026-10-20T10:02:00Z',
            },
          },
          { id: 'pending-video', data: { kind: 'video', videoStatus: 'running', videoUrl: '/api/files/pending.mp4' } },
        ],
      },
    }, {});

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      mediaType: 'video',
      url: '/api/files/a.mp4',
      prompt: '视频提示词',
      startedAt: '2026-10-20T10:01:00Z',
      finishedAt: '2026-10-20T10:02:00Z',
      videoSeconds: 5,
      videoResolution: '720p',
      videoRatio: '16:9',
      videoAudio: false,
    });
    expect(items[1]).toMatchObject({ mediaType: 'image', versionId: 'v1', versionIndex: 1 });
  });
});

describe('removeHistoryTargetFromCanvas', () => {
  it('只删除命中的版本，保留节点并切到剩余版本', () => {
    const doc = {
      nodes: [{
        id: 'image-1',
        data: {
          kind: 'image',
          activeVersionId: 'v2',
          imageUrl: '/api/files/b.png',
          fileName: 'b.png',
          versions: [
            { id: 'v1', imageUrl: '/api/files/a.png', fileName: 'a.png', prompt: '第一版' },
            { id: 'v2', imageUrl: '/api/files/b.png', fileName: 'b.png', prompt: '第二版' },
          ],
        },
      }],
      edges: [],
    };

    const result = removeHistoryTargetFromCanvas(doc, {
      canvasId: 'canvas-a',
      nodeId: 'image-1',
      versionId: 'v1',
      mediaType: 'image',
      fileName: 'a.png',
    }, '2026-10-31T00:00:00.000Z');

    expect(result).toMatchObject({ changed: true, nodeDeleted: false, removedFileNames: ['a.png'] });
    expect(doc.nodes).toHaveLength(1);
    const data = doc.nodes[0].data as Record<string, unknown>;
    expect((data.versions as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(['v2']);
    expect(data.activeVersionId).toBe('v2');
    expect(data.imageUrl).toBe('/api/files/b.png');
  });

  it('删除最后一个版本时移除节点、连线和其他节点的引用', () => {
    const doc = {
      nodes: [
        {
          id: 'image-1',
          data: {
            kind: 'image',
            versions: [{ id: 'v1', imageUrl: '/api/files/a.png', fileName: 'a.png' }],
          },
        },
        {
          id: 'composer-1',
          data: {
            kind: 'composer',
            references: [{ id: 'image-1', url: '/api/files/a.png' }],
            referenceOrder: ['image-1'],
          },
        },
      ],
      edges: [{ id: 'e1', source: 'image-1', target: 'composer-1' }],
    };

    const result = removeHistoryTargetFromCanvas(doc, {
      canvasId: 'canvas-a',
      nodeId: 'image-1',
      versionId: 'v1',
      mediaType: 'image',
      fileName: 'a.png',
    }, '2026-10-31T00:00:00.000Z');

    expect(result).toMatchObject({ changed: true, nodeDeleted: true });
    expect(doc.nodes.map((item) => item.id)).toEqual(['composer-1']);
    expect(doc.edges).toEqual([]);
    const data = doc.nodes[0].data as Record<string, unknown>;
    expect(data.references).toEqual([]);
    expect(data.referenceOrder).toEqual([]);
  });

  it('版本号失效时不误删仍然存在的节点', () => {
    const doc = {
      nodes: [{
        id: 'image-1',
        data: {
          kind: 'image',
          activeVersionId: 'v2',
          imageUrl: '/api/files/b.png',
          fileName: 'b.png',
          versions: [{ id: 'v2', imageUrl: '/api/files/b.png', fileName: 'b.png' }],
        },
      }],
      edges: [],
    };

    const result = removeHistoryTargetFromCanvas(doc, {
      canvasId: 'canvas-a',
      nodeId: 'image-1',
      versionId: 'v1',
      mediaType: 'image',
      fileName: 'b.png',
    }, '2026-10-31T00:00:00.000Z');

    expect(result).toMatchObject({ changed: false, nodeDeleted: false });
    expect(doc.nodes).toHaveLength(1);
  });

  it('删除视频时直接移除视频节点', () => {
    const doc = {
      nodes: [{
        id: 'video-1',
        data: { kind: 'video', videoUrl: '/api/files/a.mp4', videoFileName: 'a.mp4' },
      }],
      edges: [],
    };

    const result = removeHistoryTargetFromCanvas(doc, {
      canvasId: 'canvas-a',
      nodeId: 'video-1',
      mediaType: 'video',
      fileName: 'a.mp4',
    }, '2026-10-31T00:00:00.000Z');

    expect(result).toMatchObject({ changed: true, nodeDeleted: true, removedFileNames: ['a.mp4'] });
    expect(doc.nodes).toEqual([]);
  });
});

describe('stripChatMediaReferences', () => {
  it('清理消息媒体、重试引用与视觉记忆里的目标版本', () => {
    const thread = {
      id: 'thread-1',
      messages: [{
        id: 'm1',
        media: [
          { nodeId: 'image-1', versionId: 'v1', url: '/api/files/a.png' },
          { nodeId: 'image-1', versionId: 'v2', url: '/api/files/b.png' },
        ],
        attachments: [{ nodeId: 'image-1', versionId: 'v1', url: '/api/files/a.png' }],
        retrySource: {
          content: '继续',
          attachments: [{ nodeId: 'image-1', versionId: 'v1', url: '/api/files/a.png' }],
        },
      }],
      memory: {
        visualWorkingSet: {
          base: { nodeId: 'image-1', versionId: 'v1', url: '/api/files/a.png' },
          references: [{ nodeId: 'image-1', versionId: 'v1', url: '/api/files/a.png' }],
          recentOutputs: [{ nodeId: 'image-1', versionId: 'v2', url: '/api/files/b.png' }],
        },
      },
    };

    const result = stripChatMediaReferences(thread, [{
      canvasId: 'canvas-a',
      nodeId: 'image-1',
      versionId: 'v1',
      mediaType: 'image',
      url: '/api/files/a.png',
    }]);

    expect(result.changed).toBe(true);
    const message = result.thread.messages[0] as Record<string, unknown>;
    expect((message.media as Array<Record<string, unknown>>).map((item) => item.versionId)).toEqual(['v2']);
    expect(message.attachments).toEqual([]);
    expect((message.retrySource as Record<string, unknown>).attachments).toEqual([]);
    const workingSet = (result.thread.memory as Record<string, unknown>).visualWorkingSet as Record<string, unknown>;
    expect(workingSet.base).toBeUndefined();
    expect(workingSet.references).toEqual([]);
    expect((workingSet.recentOutputs as Array<Record<string, unknown>>).map((item) => item.versionId)).toEqual(['v2']);
  });
});
