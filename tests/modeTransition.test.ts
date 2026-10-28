import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8');
const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/mode-transition.css', import.meta.url)),
  'utf8',
);
const CANVAS = readFileSync(fileURLToPath(new URL('../src/pages/CanvasPage.tsx', import.meta.url)), 'utf8');
const IMAGE_NODES = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/ImageNodes.css', import.meta.url)),
  'utf8',
);

describe('mode transition', () => {
  it('keeps the outgoing page mounted until the exit finishes', () => {
    expect(APP).toContain('const EXIT_MS = 360');
    expect(APP).toContain("phase: 'exit'");
    expect(APP).toContain("phase: 'enter'");
    expect(APP).toContain('outgoing === target');
    expect(APP).toContain('is-mounted');
    expect(APP).not.toContain('ModeDotsTransition');
  });

  it('uses a plain fade instead of the matrix convergence overlay', () => {
    expect(CSS).not.toContain('app-mode-dots');
    expect(CSS).not.toContain('app-mode-stage-in');
    expect(CSS).toContain('.app-mode-layer.is-outgoing[data-mode="canvas"] .react-flow__background');
    expect(CSS).toContain('.app-mode-layer.is-outgoing[data-mode="canvas"] .react-flow__node');
  });

  it('slides the workbench composer in and fades the results', () => {
    expect(CSS).toContain('app-mode-composer-in');
    expect(CSS).toContain('app-mode-composer-out');
    expect(CSS).toContain('--mode-enter: 560ms');
    expect(CSS).toContain('app-mode-fade-in');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('starts the canvas ripple as soon as the canvas mounts', () => {
    expect(APP).toContain('<CanvasPage />');
    expect(CANVAS).not.toContain('suppressEntry');
    expect(CANVAS).toContain('playEntry();');
    expect(CANVAS).toContain('const minimumRingHalfWidth = 72');
    expect(IMAGE_NODES).toContain('--image-canvas-enter-delay: 480ms');
    expect(IMAGE_NODES).toContain('--image-canvas-enter-delay: 840ms');
  });
});
