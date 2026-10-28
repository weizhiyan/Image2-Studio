import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HANDLE_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/NodeHandleMotion.css', import.meta.url)),
  'utf8',
);

function cssRule(source: string, selector: string): string {
  const marker = `\n${selector} {`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return '';
  const bodyStart = source.indexOf('{', markerIndex) + 1;
  const bodyEnd = source.indexOf('}', bodyStart);
  return bodyEnd < 0 ? '' : source.slice(bodyStart, bodyEnd);
}

describe('node connection handle motion', () => {
  it('starts inside the node and settles at the existing outer position', () => {
    const base = cssRule(
      HANDLE_CSS,
      '.image-flow-node .image-node-connect-add.image-node-connect-add',
    );
    const target = cssRule(
      HANDLE_CSS,
      '.image-flow-node .image-node-connect-add.image-handle-target',
    );
    const source = cssRule(
      HANDLE_CSS,
      '.image-flow-node .image-node-connect-add.image-handle-source',
    );
    const revealed = HANDLE_CSS.match(
      /\.image-flow-node:hover \.image-node-connect-add\.image-node-connect-add,\s*\.image-flow-node\.selected \.image-node-connect-add\.image-node-connect-add \{([\s\S]*?)\}/,
    )?.[1] || '';

    expect(base).toContain('translate: var(--hb-handle-offset-x, 0px) 0;');
    expect(target).toContain('--hb-handle-offset-x: var(--spacing-2);');
    expect(source).toContain(
      '--hb-handle-offset-x: calc(0px - var(--spacing-2));',
    );
    expect(revealed).toContain('opacity: 1;');
    expect(revealed).toContain('translate: 0 0;');
    expect(revealed).toContain('animation: none;');
  });

  it('uses reversible opacity and translate transitions', () => {
    const base = cssRule(
      HANDLE_CSS,
      '.image-flow-node .image-node-connect-add.image-node-connect-add',
    );

    expect(base).toContain('opacity 200ms cubic-bezier(0.42, 0, 1, 1)');
    expect(base).toContain('translate 200ms cubic-bezier(0.42, 0, 1, 1)');
    expect(HANDLE_CSS).not.toContain('@keyframes hb-handle-slide-in');
  });

  it('disables handle transitions when reduced motion is requested', () => {
    const reducedMotion = HANDLE_CSS.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/,
    )?.[1] || '';

    expect(reducedMotion).toContain(
      '.image-flow-node .image-node-connect-add.image-node-connect-add',
    );
    expect(reducedMotion).toContain('transition: none !important;');
  });
});
