import type { ChatImageRef } from '@/types';

export type ChatInlineSegment =
  | { type: 'text'; text: string }
  | { type: 'reference'; reference: ChatImageRef };

export function chatInlineSegments(text: string, references: ChatImageRef[]): ChatInlineSegment[] {
  const content = String(text || '');
  const ordered = references
    .map((reference, index) => ({ reference, index, position: reference.position }))
    .sort((left, right) => (
      (left.position ?? content.length) - (right.position ?? content.length)
      || left.index - right.index
    ));
  const segments: ChatInlineSegment[] = [];
  let cursor = 0;
  for (const { reference, position: rawPosition } of ordered) {
    const position = Math.max(cursor, Math.min(Number.isInteger(rawPosition) ? Number(rawPosition) : content.length, content.length));
    if (position > cursor) segments.push({ type: 'text', text: content.slice(cursor, position) });
    segments.push({ type: 'reference', reference: { ...reference, position } });
    cursor = position;
  }
  if (cursor < content.length || segments.length === 0) {
    segments.push({ type: 'text', text: content.slice(cursor) });
  }
  return segments;
}

export function chatInlineSignature(text: string, references: ChatImageRef[], roleId = ''): string {
  return JSON.stringify([
    text,
    roleId,
    references.map((reference) => [
      reference.nodeId,
      reference.versionId || '',
      reference.position ?? null,
      reference.title || '',
      reference.url || '',
    ]),
  ]);
}

export function chatRoleLabel(name: string): string {
  const characters = Array.from(name.trim());
  return characters.length > 4 ? `${characters.slice(0, 4).join('')}...` : characters.join('');
}
