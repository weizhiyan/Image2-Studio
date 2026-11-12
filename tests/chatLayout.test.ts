import { describe, expect, it } from 'vitest';
import { chatResultConnectFrom, estimateCanvasBox, layoutChatResultPositions } from '../bridge/runs';

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box, padding = 0): boolean {
  return a.x < b.x + b.width + padding
    && a.x + a.width + padding > b.x
    && a.y < b.y + b.height + padding
    && a.y + a.height + padding > b.y;
}

describe('聊天结果与参考图的关系', () => {
  it('继续编辑上一版时连到上一版节点；显式引用优先', () => {
    expect(chatResultConnectFrom([], 'edit', 'base-1')).toEqual(['base-1']);
    expect(chatResultConnectFrom(['ref-1', 'ref-2'], 'edit', 'base-1')).toEqual(['ref-1', 'ref-2']);
    expect(chatResultConnectFrom([], 'style', 'base-1')).toEqual([]);
    expect(chatResultConnectFrom(['ref-1', 'ref-1'], 'edit', 'base-1')).toEqual(['ref-1']);
  });

  it('没有显式引用时优先沿用当前任务原图锚点', () => {
    expect(chatResultConnectFrom([], 'edit', 'base-1', 'anchor-1')).toEqual(['anchor-1']);
    expect(chatResultConnectFrom([], 'style', 'base-1', 'anchor-1')).toEqual(['anchor-1']);
    expect(chatResultConnectFrom(['ref-1'], 'edit', 'base-1', 'anchor-1')).toEqual(['ref-1']);
  });

  it('新结果放在参考图右侧一列，多张向下排', () => {
    const anchor = { x: 100, y: 100, width: 320, height: 320 };
    const positions = layoutChatResultPositions({ anchor, count: 2, size: '1024x1024', existing: [anchor] });
    expect(positions).toEqual([{ x: 540, y: 100 }, { x: 540, y: 468 }]);
  });

  it('锚点右侧已有节点时整列下移避让', () => {
    const anchor = { x: 100, y: 100, width: 320, height: 320 };
    const blocker = { x: 540, y: 100, width: 320, height: 320 };
    const positions = layoutChatResultPositions({ anchor, count: 1, size: '1024x1024', existing: [anchor, blocker] });
    expect(positions).toEqual([{ x: 540, y: 468 }]);
  });

  it('没有锚点时向右另起一列，并纵向排开而不是斜向叠放', () => {
    const rightmost = { x: 1000, y: 50, width: 320, height: 320 };
    const positions = layoutChatResultPositions({ anchor: null, count: 2, size: '1024x1024', existing: [rightmost] });
    expect(positions).toEqual([{ x: 1440, y: 50 }, { x: 1440, y: 418 }]);
  });

  it('没有锚点时按最右边缘避让，宽节点不会压住新结果', () => {
    const wide = { x: 1000, y: 50, width: 400, height: 300 };
    const narrowButFurtherRight = { x: 1100, y: 500, width: 200, height: 200 };
    const positions = layoutChatResultPositions({
      anchor: null,
      count: 1,
      size: '1024x1024',
      existing: [wide, narrowButFurtherRight],
    });
    expect(positions).toEqual([{ x: 1520, y: 50 }]);
  });

  it('多张真实尺寸不同时按各自盒子向下排列，互不重叠', () => {
    const anchor = { x: 100, y: 100, width: 320, height: 320 };
    const positions = layoutChatResultPositions({
      anchor,
      count: 2,
      size: '1536x1536',
      sizes: ['1024x1536', '1536x1024'],
      existing: [anchor],
    });
    const boxes = [
      { ...positions[0], width: 280, height: 420 },
      { ...positions[1], width: 320, height: 213 },
    ];
    expect(positions).toEqual([{ x: 540, y: 100 }, { x: 540, y: 568 }]);
    expect(overlaps(boxes[0], boxes[1], 24)).toBe(false);
    expect(boxes.every((box) => !overlaps(box, anchor, 24))).toBe(true);
  });

  it('结果列遇到不同尺寸的已有节点时继续向下避让，最终都不重叠', () => {
    const anchor = { x: 100, y: 100, width: 320, height: 320 };
    const existing = [
      anchor,
      { x: 540, y: 100, width: 280, height: 420 },
      { x: 540, y: 568, width: 320, height: 213 },
      { x: 540, y: 829, width: 280, height: 420 },
    ];
    const positions = layoutChatResultPositions({
      anchor,
      count: 2,
      size: '1536x1536',
      sizes: ['1024x1536', '1536x1024'],
      existing,
    });
    const resultBoxes = [
      { ...positions[0], width: 280, height: 420 },
      { ...positions[1], width: 320, height: 213 },
    ];
    for (const result of resultBoxes) {
      expect(existing.every((box) => !overlaps(result, box, 24))).toBe(true);
    }
    expect(overlaps(resultBoxes[0], resultBoxes[1], 24)).toBe(false);
  });

  it('节点盒子按前端同口径估算：竖幅收窄、横幅放宽、文本节点用存储尺寸', () => {
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1024x1024' } })).toMatchObject({ width: 320, height: 320 });
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1024x1536' } })).toMatchObject({ width: 280, height: 420 });
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1920x1080' } })).toMatchObject({ width: 400, height: 225 });
    expect(estimateCanvasBox({ position: { x: 10, y: 20 }, data: { kind: 'text', cardWidth: 500, nodeHeight: 300 } })).toEqual({ x: 10, y: 20, width: 500, height: 300 });
  });
});
