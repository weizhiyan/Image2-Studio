import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasDoc } from '@/types';

function doc(id: string, name: string, withNode = false): CanvasDoc {
  return {
    id,
    name,
    updatedAt: '2026-11-02T00:00:00.000Z',
    nodes: withNode ? [{
      id: `${id}-node`,
      type: 'flow-image',
      position: { x: 0, y: 0 },
      data: { kind: 'image', label: '图片' },
    }] : [],
    edges: [],
  };
}

describe('空画布草稿不进入历史', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      canvases: [doc('empty', '默认画布')],
      activeId: 'empty',
      cursor: { x: 80, y: 80 },
    });
  });

  it('新建画布时替换掉上一张没有节点的草稿', () => {
    const id = useCanvasStore.getState().createCanvas('新画布');
    const state = useCanvasStore.getState();
    expect(state.activeId).toBe(id);
    expect(state.canvases.map((canvas) => canvas.id)).toEqual([id]);
    expect(state.canvases[0].nodes).toHaveLength(0);
  });

  it('切到有内容的画布时丢弃当前空草稿', () => {
    useCanvasStore.setState({
      canvases: [doc('empty', '默认画布'), doc('filled', '有内容', true)],
      activeId: 'empty',
    });
    useCanvasStore.getState().setActive('filled');
    expect(useCanvasStore.getState().canvases.map((canvas) => canvas.id)).toEqual(['filled']);
    expect(useCanvasStore.getState().activeId).toBe('filled');
  });

  it('有内容的画布切换时不会被误删', () => {
    useCanvasStore.setState({
      canvases: [doc('filled', '有内容', true), doc('next', '下一张')],
      activeId: 'filled',
    });
    useCanvasStore.getState().setActive('next');
    expect(useCanvasStore.getState().canvases.map((canvas) => canvas.id)).toEqual(['filled', 'next']);
  });
});
