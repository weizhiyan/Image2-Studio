import { describe, expect, it } from 'vitest';
import type { CanvasDoc, CanvasNode } from '@/types';
import { latestCanvasImageUrl } from '@/lib/canvasThumbnails';

function imageNode(
  id: string,
  versions: Array<{ id: string; imageUrl: string; createdAt?: string; finishedAt?: string }>,
  imageUrl = '',
): CanvasNode {
  return {
    id,
    type: 'flow-image',
    position: { x: 0, y: 0 },
    data: {
      kind: 'image',
      label: id,
      imageUrl,
      versions: versions.map((version) => ({
        ...version,
        fileName: '',
        prompt: '',
        model: '',
        size: '1024x1024',
        createdAt: version.createdAt || '',
        finishedAt: version.finishedAt || '',
      })),
    },
  };
}

function doc(nodes: CanvasNode[]): CanvasDoc {
  return { id: 'canvas', name: 'Canvas', nodes, edges: [], updatedAt: '2026-10-30T00:00:00Z' };
}

describe('latestCanvasImageUrl', () => {
  it('跨节点选取完成时间最新的生成结果', () => {
    const canvas = doc([
      imageNode('older', [
        { id: 'a', imageUrl: '/api/files/a.png', finishedAt: '2026-10-29T10:00:00Z' },
      ]),
      imageNode('newer', [
        { id: 'b', imageUrl: '/api/files/b.png', finishedAt: '2026-10-29T09:00:00Z' },
        { id: 'c', imageUrl: '/api/files/c.png', finishedAt: '2026-10-30T08:00:00Z' },
      ]),
    ]);

    expect(latestCanvasImageUrl(canvas)).toBe('/api/files/c.png');
  });

  it('兼容没有版本链的旧图片节点', () => {
    const canvas = doc([imageNode('legacy', [], '/api/files/legacy.png')]);

    expect(latestCanvasImageUrl(canvas)).toBe('/api/files/legacy.png');
  });

  it('没有生成结果时返回空字符串', () => {
    expect(latestCanvasImageUrl(doc([]))).toBe('');
  });
});
