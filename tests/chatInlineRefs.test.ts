import { describe, expect, it } from 'vitest';
import { chatInlineSegments } from '@/lib/chatInlineRefs';

describe('chatInlineSegments', () => {
  it('keeps references between the surrounding text segments', () => {
    const segments = chatInlineSegments('合成这两张图', [
      { canvasId: 'c1', nodeId: 'a', position: 2, title: '图一' },
      { canvasId: 'c1', nodeId: 'b', position: 4, title: '图二' },
    ]);
    expect(segments).toEqual([
      { type: 'text', text: '合成' },
      { type: 'reference', reference: { canvasId: 'c1', nodeId: 'a', position: 2, title: '图一' } },
      { type: 'text', text: '这两' },
      { type: 'reference', reference: { canvasId: 'c1', nodeId: 'b', position: 4, title: '图二' } },
      { type: 'text', text: '张图' },
    ]);
  });

  it('clamps legacy and out-of-range offsets to the text end', () => {
    const segments = chatInlineSegments('abc', [
      { canvasId: 'c1', nodeId: 'legacy' },
      { canvasId: 'c1', nodeId: 'late', position: 30 },
    ]);
    expect(segments.map((segment) => segment.type === 'text' ? segment.text : segment.reference.nodeId))
      .toEqual(['abc', 'legacy', 'late']);
  });
});
