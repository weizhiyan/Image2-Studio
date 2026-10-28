import { describe, expect, it } from 'vitest';
import {
  NODE_TOOLBAR_GAP,
  NODE_TOOLBAR_HEIGHT,
  placeNodeToolbar,
} from '@/lib/nodeOverlayPlacement';

const baseOptions = {
  containerWidth: 1200,
  topSafe: 72,
  toolbarWidth: 360,
};

describe('节点工具栏定位', () => {
  it('上方空间足够时贴在节点上方', () => {
    const placement = placeNodeToolbar({ left: 400, top: 300, width: 320, height: 240 }, baseOptions);
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(300 - NODE_TOOLBAR_HEIGHT - NODE_TOOLBAR_GAP);
  });

  it('靠近顶部时完整翻到节点下方，不再压进卡片', () => {
    const node = { left: 400, top: 84, width: 320, height: 320 };
    const placement = placeNodeToolbar(node, baseOptions);
    expect(placement.side).toBe('below');
    expect(placement.top).toBe(node.top + node.height + NODE_TOOLBAR_GAP);
    expect(placement.top).toBeGreaterThan(node.top + node.height);
  });

  it('浮层不会与卡片矩形相交', () => {
    const node = { left: 120, top: 96, width: 280, height: 480 };
    const placement = placeNodeToolbar(node, { ...baseOptions, toolbarWidth: 174 });
    const overlapsVertically = placement.top < node.top + node.height
      && placement.top + NODE_TOOLBAR_HEIGHT > node.top;
    expect(overlapsVertically).toBe(false);
  });

  it('窄容器内横向收边，不溢出左右安全边距', () => {
    const placement = placeNodeToolbar(
      { left: 0, top: 300, width: 900, height: 200 },
      { ...baseOptions, containerWidth: 320, toolbarWidth: 174 },
    );
    expect(placement.left).toBeGreaterThanOrEqual(174 / 2 + 12);
    expect(placement.left).toBeLessThanOrEqual(320 - 174 / 2 - 12);
  });
});
