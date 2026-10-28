import { describe, expect, it } from 'vitest';
import type { CanvasNodeData, CanvasNodeVersion } from '@/types';
import { applyMediaRemap, collectMediaUrls, orphanCopiedUrls } from '@/lib/mediaFiles';

function nodeData(extra: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return { kind: 'image', label: '图', status: 'idle', ...extra } as CanvasNodeData;
}

function ver(id: string, imageUrl: string): CanvasNodeVersion {
  return { id, imageUrl, fileName: '', prompt: '', model: '', size: '', createdAt: '', finishedAt: '' };
}

describe('媒体引用收集（删节点按这个清单真删文件）', () => {
  it('只收 /api/files 服务端文件，dataURL 内嵌引用不收', () => {
    const urls = collectMediaUrls(nodeData({
      imageUrl: '/api/files/a.png',
      referenceDataUrl: 'data:image/png;base64,AAAA',
      versions: [ver('v1', '/api/files/b.png'), ver('v2', '')],
    }));
    expect(urls).toEqual(['/api/files/a.png', '/api/files/b.png']);
  });

  it('视频节点的成品也进清理清单（视频文件更大，漏删更疼）', () => {
    const urls = collectMediaUrls(nodeData({
      kind: 'video',
      videoUrl: '/api/files/vid_1.mp4',
      videoFileName: 'vid_1.mp4',
    }));
    expect(urls).toEqual(['/api/files/vid_1.mp4']);
  });

  it('视频节点同时带图（首帧来源）时两个都收', () => {
    const urls = collectMediaUrls(nodeData({
      kind: 'video',
      imageUrl: '/api/files/first.png',
      videoUrl: '/api/files/vid_2.mp4',
    }));
    expect(urls).toEqual(['/api/files/first.png', '/api/files/vid_2.mp4']);
  });
});

describe('粘贴副本媒体改写（副本与原件各占一个文件）', () => {
  it('主图与各版本引用都换成复制出来的那份', () => {
    const data = nodeData({
      imageUrl: '/api/files/a.png',
      versions: [ver('v1', '/api/files/a.png'), ver('v2', '/api/files/b.png')],
    });
    applyMediaRemap(data, new Map([['/api/files/a.png', '/api/files/copy1.png']]));
    expect(data.imageUrl).toBe('/api/files/copy1.png');
    expect(data.versions?.[0].imageUrl).toBe('/api/files/copy1.png');
    // 没进改写表的引用原地不动（复制失败的降级路径：仍共享，但图还在）
    expect(data.versions?.[1].imageUrl).toBe('/api/files/b.png');
  });

  it('改写表为空时什么都不动', () => {
    const data = nodeData({ imageUrl: '/api/files/a.png' });
    applyMediaRemap(data, new Map());
    expect(data.imageUrl).toBe('/api/files/a.png');
  });
});

describe('撤回粘贴后的副本清场（只删没人再引用的）', () => {
  it('复制出来的文件还被节点引用着就不删', () => {
    const kept = ['/api/files/copy1.png'];
    const nodes = [
      { data: nodeData({ imageUrl: '/api/files/copy1.png' }) },
      { data: nodeData({ kind: 'composer', references: [{ id: 'x', url: '/api/files/copy1.png', title: 't', kind: 'image', text: '' }] }) },
    ];
    expect(orphanCopiedUrls(kept, nodes)).toEqual([]);
  });

  it('粘贴节点已整组撤掉、旁边也没节点再引的副本才删', () => {
    const nodes = [{ data: nodeData({ imageUrl: '/api/files/a.png' }) }];
    expect(orphanCopiedUrls(['/api/files/copy1.png', '/api/files/copy2.png'], nodes))
      .toEqual(['/api/files/copy1.png', '/api/files/copy2.png']);
  });
});
