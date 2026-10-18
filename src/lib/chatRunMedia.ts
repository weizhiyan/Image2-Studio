import type { ChatMessageMedia } from '@/types';

/** Merge live SSE results idempotently; reconnecting to a run replays buffered events. */
export function mergeChatRunMedia(
  current: ChatMessageMedia[] = [],
  incoming: ChatMessageMedia,
): ChatMessageMedia[] {
  const keyOf = (item: ChatMessageMedia) => String(item.versionId || item.nodeId || item.url || '');
  const key = keyOf(incoming);
  if (current.some((item) => keyOf(item) === key)) return current;
  return [...current, incoming];
}
