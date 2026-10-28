export interface ChatPanelResizeFrame {
  shellWidth: number;
  contentOpacity: number;
  collapseOffset: number;
  shellOpacity: number;
  contentHidden: boolean;
  collapsed: boolean;
}

const CONTENT_FADE_DISTANCE = 12;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getChatPanelResizeFrame(width: number, minWidth: number): ChatPanelResizeFrame {
  const collapseWidth = minWidth / 2;
  const safeWidth = Number.isFinite(width) ? width : minWidth;
  const contentFadeStart = minWidth - CONTENT_FADE_DISTANCE;

  return {
    shellWidth: Math.max(collapseWidth, safeWidth),
    contentOpacity: clamp01((safeWidth - contentFadeStart) / CONTENT_FADE_DISTANCE),
    collapseOffset: Math.max(0, collapseWidth - safeWidth),
    shellOpacity: clamp01(safeWidth / collapseWidth),
    contentHidden: safeWidth < minWidth,
    collapsed: safeWidth <= collapseWidth,
  };
}
