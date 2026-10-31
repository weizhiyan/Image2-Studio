import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const canvasPageSource = readFileSync(new URL('../src/pages/CanvasPage.tsx', import.meta.url), 'utf8');

describe('canvas node deletion persistence', () => {
  it('locks out remote snapshots from the start of the exit animation', () => {
    const deletionGuard = canvasPageSource.match(/onBeforeDelete=\{async \(\{ nodes: nodesToRemove \}\) => \{([\s\S]*?)\n          \}\}/)?.[1] || '';

    expect(deletionGuard).toContain('localWritePendingRef.current = true;');
    expect(deletionGuard).toContain('remoteSyncRevisionRef.current += 1;');
    expect(deletionGuard.indexOf('localWritePendingRef.current = true;'))
      .toBeLessThan(deletionGuard.indexOf('await new Promise'));
  });

  it('writes the post-delete node and edge snapshot immediately', () => {
    const changeHandler = canvasPageSource.match(/const onNodesChange = useCallback\(\(changes: NodeChange<FlowNode>\[\]\) => \{([\s\S]*?)\n  \}, \[pushGraphUndo/)?.[1] || '';

    expect(changeHandler).toContain('localWritePendingRef.current = true;');
    expect(changeHandler).toContain('window.clearTimeout(persistTimerRef.current);');
    expect(changeHandler).toContain('setGraph(stripNodeRuntimeFlags(next) as CanvasNode[], nextEdges as CanvasEdge[]);');
  });
});
