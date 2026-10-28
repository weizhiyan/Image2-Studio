export interface NodeOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NodeToolbarPlacementOptions {
  containerWidth: number;
  topSafe: number;
  toolbarWidth: number;
  toolbarHeight?: number;
  gap?: number;
  edgeInset?: number;
}

export interface NodeToolbarPlacement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

export const NODE_TOOLBAR_HEIGHT = 40;
export const NODE_TOOLBAR_GAP = 12;
export const NODE_TOOLBAR_EDGE_INSET = 12;

/**
 * 节点浮层只做一次“上/下”判定：上方放得下就贴在上方，否则完整翻到卡片下方。
 * 不再把下方坐标 clamp 回顶部安全线，否则工具栏会重新压进卡片中部。
 */
export function placeNodeToolbar(
  node: NodeOverlayRect,
  {
    containerWidth,
    topSafe,
    toolbarWidth,
    toolbarHeight = NODE_TOOLBAR_HEIGHT,
    gap = NODE_TOOLBAR_GAP,
    edgeInset = NODE_TOOLBAR_EDGE_INSET,
  }: NodeToolbarPlacementOptions,
): NodeToolbarPlacement {
  const aboveTop = node.top - toolbarHeight - gap;
  const side = aboveTop >= topSafe ? 'above' : 'below';
  const top = side === 'above' ? aboveTop : node.top + node.height + gap;
  const centerX = node.left + node.width / 2;
  const halfWidth = Math.max(0, toolbarWidth) / 2;

  if (containerWidth <= toolbarWidth + edgeInset * 2) {
    return { left: containerWidth / 2, top, side };
  }

  const minLeft = edgeInset + halfWidth;
  const maxLeft = containerWidth - edgeInset - halfWidth;
  return {
    left: Math.min(Math.max(centerX, minLeft), maxLeft),
    top,
    side,
  };
}
