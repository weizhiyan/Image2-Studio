import { describe, expect, it } from 'vitest';
import { collectHistoryItems } from '../bridge/history';

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
