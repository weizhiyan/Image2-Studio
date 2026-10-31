import { describe, expect, it } from 'vitest';
import { chatResultConnectFrom, estimateCanvasBox, layoutChatResultPositions } from '../bridge/runs';

describe('聊天结果与参考图的关系', () => {
  it('继续编辑上一版时连到上一版节点；显式引用优先', () => {
    expect(chatResultConnectFrom([], 'edit', 'base-1')).toEqual(['base-1']);
    expect(chatResultConnectFrom(['ref-1', 'ref-2'], 'edit', 'base-1')).toEqual(['ref-1', 'ref-2']);
    expect(chatResultConnectFrom([], 'style', 'base-1')).toEqual([]);
    expect(chatResultConnectFrom(['ref-1', 'ref-1'], 'edit', 'base-1')).toEqual(['ref-1']);
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

  it('没有锚点时保持旧的右侧错开行为', () => {
    const rightmost = { x: 1000, y: 50, width: 320, height: 320 };
    const positions = layoutChatResultPositions({ anchor: null, count: 2, size: '1024x1024', existing: [rightmost] });
    expect(positions).toEqual([{ x: 1420, y: 50 }, { x: 1460, y: 90 }]);
  });

  it('节点盒子按前端同口径估算：竖幅收窄、横幅放宽、文本节点用存储尺寸', () => {
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1024x1024' } })).toMatchObject({ width: 320, height: 320 });
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1024x1536' } })).toMatchObject({ width: 280, height: 420 });
    expect(estimateCanvasBox({ position: { x: 0, y: 0 }, data: { size: '1920x1080' } })).toMatchObject({ width: 400, height: 225 });
    expect(estimateCanvasBox({ position: { x: 10, y: 20 }, data: { kind: 'text', cardWidth: 500, nodeHeight: 300 } })).toEqual({ x: 10, y: 20, width: 500, height: 300 });
  });
});
