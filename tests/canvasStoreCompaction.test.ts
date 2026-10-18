import { describe, expect, it } from 'vitest';
import { compactCanvasPersistedValue } from '@/stores/canvasStore';

const dataUrl = 'data:image/png;base64,AAAA';

describe('画布本地缓存配额兜底', () => {
  it('配额不足时剥掉内嵌图片，保留 /api/files 引用与节点结构', () => {
    const value = JSON.stringify({
      state: {
        canvases: [{
          id: 'c1',
          name: '测试画布',
          updatedAt: '2026-01-01T00:00:00.000Z',
          edges: [],
          nodes: [{
            id: 'n1',
            type: 'flow-image',
            position: { x: 0, y: 0 },
            data: {
              kind: 'image',
              label: '参考图',
              referenceDataUrl: dataUrl,
              imageUrl: '/api/files/keep.png',
              references: [
                { id: 'r1', url: dataUrl, title: '内嵌', kind: 'image' },
                { id: 'r2', url: '/api/files/keep-ref.png', title: '文件', kind: 'image' },
              ],
              versions: [
                { id: 'v1', imageUrl: dataUrl },
                { id: 'v2', imageUrl: '/api/files/keep-version.png' },
              ],
            },
          }],
        }],
        activeId: 'c1',
      },
      version: 2,
    });
    const compact = JSON.parse(compactCanvasPersistedValue(value));
    const data = compact.state.canvases[0].nodes[0].data;
    expect(data.referenceDataUrl).toBe('');
    expect(data.imageUrl).toBe('/api/files/keep.png');
    expect(data.references[0].url).toBe('');
    expect(data.references[1].url).toBe('/api/files/keep-ref.png');
    expect(data.versions[0].imageUrl).toBe('');
    expect(data.versions[1].imageUrl).toBe('/api/files/keep-version.png');
    expect(compact.state.activeId).toBe('c1');
  });

  it('不是预期结构时原样返回，不误伤其他持久化数据', () => {
    expect(compactCanvasPersistedValue('not-json')).toBe('not-json');
    expect(compactCanvasPersistedValue(JSON.stringify({ state: { foo: 1 } }))).toBe(JSON.stringify({ state: { foo: 1 } }));
  });
});
