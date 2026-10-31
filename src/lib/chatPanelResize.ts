export type ChatPanelResizePhase = 'expanded' | 'collapsing' | 'collapsed' | 'expanding';

export function getNextChatPanelResizePhase(
  phase: ChatPanelResizePhase,
  desiredWidth: number,
  minWidth: number,
): ChatPanelResizePhase {
  const safeWidth = Number.isFinite(desiredWidth) ? desiredWidth : minWidth;
  const safeMinimum = Math.max(0, Number.isFinite(minWidth) ? minWidth : 0);
  const collapseWidth = safeMinimum / 2;

  if ((phase === 'expanded' || phase === 'expanding') && safeWidth <= collapseWidth) {
    return 'collapsing';
  }
  if ((phase === 'collapsing' || phase === 'collapsed') && safeWidth >= safeMinimum) {
    return 'expanding';
  }
  return phase;
}

export function getChatPanelResizeWidth(
  desiredWidth: number,
  minWidth: number,
  maxWidth: number,
  phase: ChatPanelResizePhase,
): number {
  const safeMaximum = Math.max(0, Number.isFinite(maxWidth) ? maxWidth : 0);
  const safeMinimum = Math.min(
    safeMaximum,
    Math.max(0, Number.isFinite(minWidth) ? minWidth : 0),
  );
  if (phase === 'collapsing' || phase === 'collapsed') return safeMinimum;

  const safeWidth = Number.isFinite(desiredWidth) ? desiredWidth : safeMinimum;
  return Math.max(safeMinimum, Math.min(safeMaximum, safeWidth));
}
