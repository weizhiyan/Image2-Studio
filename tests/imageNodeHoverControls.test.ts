import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const IMAGE_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/ImageNodes.css', import.meta.url)),
  'utf8',
);

function cssRule(source: string, selector: string): string {
  const lineSelector = `\n${selector} {`;
  const lineIndex = source.indexOf(lineSelector);
  const selectorIndex = lineIndex >= 0 ? lineIndex + 1 : 0;
  if (lineIndex < 0 && !source.startsWith(`${selector} {`)) return '';
  const bodyStart = source.indexOf('{', selectorIndex) + 1;
  const bodyEnd = source.indexOf('}', bodyStart);
  return bodyEnd < 0 ? '' : source.slice(bodyStart, bodyEnd);
}

function transitionProperties(rule: string): string[] {
  const transition = rule.match(/transition:\s*([^;]+);/s)?.[1] || '';
  return [...transition.matchAll(/([a-z-]+)\s+(?:\d+ms|var\(--motion-)/g)].map(
    (match) => match[1],
  );
}

const HIDDEN_TOOLS = [
  '.image-node-composer-foot',
  '.image-node-result-meta',
  '.image-node-version-actions',
  '.image-node-video-controls',
  '.image-node-video .image-node-meta-badges',
];

describe('canvas node hover controls', () => {
  it('keeps image, video, upload and composer tools hidden with opacity-only motion', () => {
    for (const selector of HIDDEN_TOOLS) {
      const rule = cssRule(IMAGE_CSS, selector);

      expect(rule, selector).toContain('opacity: 0;');
      expect(rule, selector).toContain('pointer-events: none;');
      expect(rule, selector).not.toContain('transform:');
      expect(rule, selector).not.toContain('animation:');
      expect(rule, selector).toContain(
        'transition: opacity var(--motion-tooltip) var(--ease-tooltip);',
      );
      expect(transitionProperties(rule), selector).toEqual(['opacity']);
    }

    expect(IMAGE_CSS).not.toContain('.image-flow-node.selected .image-node-composer-foot');
  });

  it('reveals each tool on pointer hover and keyboard focus without layout properties', () => {
    const revealRules = [
      /\.image-node-media:hover \.image-node-result-meta,\s*\.image-node-media:focus-within \.image-node-result-meta\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
      /\.image-node-version:hover \.image-node-version-actions,\s*\.image-node-version:focus-within \.image-node-version-actions\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
      /\.image-flow-node:hover \.image-node-composer-foot,\s*\.image-node-composer-shell:focus-within \.image-node-composer-foot\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
      /\.image-node-video \.image-node-media:hover \.image-node-video-controls,\s*\.image-node-video \.image-node-media:focus-within \.image-node-video-controls\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
      /\.image-node-video \.image-node-media:hover \.image-node-meta-badges,\s*\.image-node-video \.image-node-media:focus-within \.image-node-meta-badges\s*\{[^}]*opacity: 1;[^}]*pointer-events: auto;/s,
    ];

    for (const rule of revealRules) expect(IMAGE_CSS).toMatch(rule);
  });

  it('keeps controls reachable on hoverless devices', () => {
    const hoverless = IMAGE_CSS.match(/@media \(hover: none\) \{([\s\S]*?)\n\}/)?.[1] || '';

    expect(hoverless).toContain('.image-node-composer-foot,');
    expect(hoverless).toContain('.image-node-result-meta');
    expect(hoverless).toContain('.image-node-version-actions');
    expect(hoverless).toContain('.image-node-video .image-node-video-controls');
    expect(hoverless).toContain('.image-node-video .image-node-meta-badges');
    expect(hoverless).not.toContain('transform:');
  });

  it('removes tool transitions when reduced motion is requested', () => {
    const reducedMotionBlocks = [...IMAGE_CSS.matchAll(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
    )].map((match) => match[1]);
    const toolMotion = reducedMotionBlocks.find((block) => block.includes('.image-node-composer-foot'));

    expect(toolMotion).toBeTruthy();
    for (const selector of HIDDEN_TOOLS) expect(toolMotion).toContain(selector);
    expect(toolMotion).toContain('transition: none;');
  });
});
