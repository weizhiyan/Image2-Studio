import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyFinalDraggedPositions } from '@/lib/canvasDrag';

const canvasPageSource = readFileSync(new URL('../src/pages/CanvasPage.tsx', import.meta.url), 'utf8');

describe('React Flow drag-stop positions', () => {
  it('commits final positions supplied for dragged nodes without changing other node data', () => {
    const nodes = [
      { id: 'image', position: { x: 0, y: 0 }, dragging: true, data: { label: '图' } },
      { id: 'video', position: { x: 300, y: 0 }, data: { label: '视频' } },
    ];

    expect(applyFinalDraggedPositions(nodes, [
      { id: 'image', position: { x: 96, y: 144 }, dragging: false },
    ])).toEqual([
      { id: 'image', position: { x: 96, y: 144 }, dragging: false, data: { label: '图' } },
      { id: 'video', position: { x: 300, y: 0 }, data: { label: '视频' } },
    ]);
  });

  it('commits every selected node in a group drag', () => {
    const nodes = [
      { id: 'image', position: { x: 0, y: 0 } },
      { id: 'video', position: { x: 300, y: 0 } },
      { id: 'other', position: { x: 600, y: 0 } },
    ];

    expect(applyFinalDraggedPositions(nodes, [
      { id: 'image', position: { x: 24, y: 36 } },
      { id: 'video', position: { x: 324, y: 36 } },
    ])).toMatchObject([
      { id: 'image', position: { x: 24, y: 36 }, dragging: false },
      { id: 'video', position: { x: 324, y: 36 }, dragging: false },
      { id: 'other', position: { x: 600, y: 0 } },
    ]);
  });

  it('persists the final React Flow drag-stop coordinates immediately', () => {
    expect(canvasPageSource).toContain('onNodeDragStop={(_event, _node, draggedNodes) => {');
    expect(canvasPageSource).toContain('applyFinalDraggedPositions(nodesRef.current, draggedNodes)');
    expect(canvasPageSource).toContain('setGraph(stripNodeRuntimeFlags(committedNodes) as CanvasNode[], committedEdges);');
  });
});
