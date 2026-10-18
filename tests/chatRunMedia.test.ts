import { describe, expect, it } from 'vitest';
import { mergeChatRunMedia } from '@/lib/chatRunMedia';
import type { ChatMessageMedia } from '@/types';

const media = (versionId: string, nodeId = 'node-1'): ChatMessageMedia => ({
  url: `/api/files/${versionId}.png`,
  fileName: `${versionId}.png`,
  nodeId,
  versionId,
  canvasId: 'canvas-1',
  prompt: '生成图片',
  model: 'image-model',
  size: '1024x1024',
});

describe('chat run media', () => {
  it('adds completed images to the message in arrival order', () => {
    expect(mergeChatRunMedia([media('v1')], media('v2', 'node-2')).map((item) => item.versionId))
      .toEqual(['v1', 'v2']);
  });

  it('is idempotent when SSE replays a completed image', () => {
    const existing = [media('v1')];
    expect(mergeChatRunMedia(existing, media('v1'))).toBe(existing);
    expect(mergeChatRunMedia(existing, media('v1'))).toHaveLength(1);
  });
});
