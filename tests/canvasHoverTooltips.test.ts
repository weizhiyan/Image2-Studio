import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTROL_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/CanvasControls.css', import.meta.url)),
  'utf8',
);
const PAGE_CSS = readFileSync(
  fileURLToPath(new URL('../src/pages/canvas-page.css', import.meta.url)),
  'utf8',
);
const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)),
  'utf8',
);
const CONTROL_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/CanvasControls.tsx', import.meta.url)),
  'utf8',
);
const TOP_BAR_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/TopBar.tsx', import.meta.url)),
  'utf8',
);
const CANVAS_PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/pages/CanvasPage.tsx', import.meta.url)),
  'utf8',
);

function cssRule(source: string, selector: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].split(',').some((item) => item.trim() === selector))
    .map((match) => match[2])
    .join('\n');
}

function transitionProperties(rule: string): string[] {
  const transition = rule.match(/transition:\s*([^;]+);/s)?.[1] || '';
  return [...transition.matchAll(
    /(?:^|,)\s*([a-z-]+)\s+(?:\d+(?:\.\d+)?m?s|var\(--motion-[^)]+\))/g,
  )].map((match) => match[1]);
}

describe('画布控件悬停气泡', () => {
  it('复用可访问名称，默认隐藏且只过渡透明度和位移', () => {
    const selectors = [
      ['.agent-connect-btn::after', PAGE_CSS],
      ['.canvas-dock-btn::after', CONTROL_CSS],
      ['.canvas-rail-btn::after', CONTROL_CSS],
    ] as const;

    for (const [selector, source] of selectors) {
      const rule = cssRule(source, selector);
      expect(rule, selector).toContain('content: attr(aria-label);');
      expect(rule, selector).toContain('opacity: 0;');
      expect(rule, selector).toContain('pointer-events: none;');
      expect(rule, selector).toContain(
        'opacity var(--motion-tooltip) var(--ease-tooltip)',
      );
      expect(rule, selector).toContain(
        'transform var(--motion-tooltip) var(--ease-tooltip)',
      );
      expect(transitionProperties(rule), selector).toEqual([
        'opacity',
        'transform',
      ]);
    }
  });

  it('气泡统一使用 160ms 与指定缓动 Token', () => {
    expect(TOKENS_CSS).toMatch(/--motion-normal:\s*160ms;/);
    expect(TOKENS_CSS).toMatch(
      /--motion-tooltip:\s*var\(--motion-normal\);/,
    );
    expect(TOKENS_CSS).toMatch(
      /--ease-tooltip:\s*cubic-bezier\(0\.42, 0, 1, 1\);/,
    );
  });

  it('按控件所在位置向外展开，并在悬停或键盘焦点时归位', () => {
    const dock = cssRule(CONTROL_CSS, '.canvas-dock-btn::after');
    const rail = cssRule(CONTROL_CSS, '.canvas-rail-btn::after');
    const agent = cssRule(PAGE_CSS, '.agent-connect-btn::after');

    expect(dock).toContain('bottom: calc(100% + var(--spacing-2));');
    expect(dock).toContain('transform: translate(-50%, var(--spacing-1));');
    expect(rail).toContain('left: calc(100% + var(--spacing-2));');
    expect(rail).toContain(
      'transform: translate(calc(0px - var(--spacing-1)), -50%);',
    );
    expect(agent).toContain('top: calc(100% + var(--spacing-2));');
    expect(agent).toContain(
      'transform: translate(-50%, calc(0px - var(--spacing-1)));',
    );

    expect(CONTROL_CSS).toMatch(
      /\.canvas-dock-btn:hover::after,\s*\.canvas-dock-btn:focus-visible::after\s*\{[^}]*opacity: 1;[^}]*transform: translate\(-50%, 0\);/s,
    );
    expect(CONTROL_CSS).toMatch(
      /\.canvas-rail-btn:hover::after,\s*\.canvas-rail-btn:focus-visible::after\s*\{[^}]*opacity: 1;[^}]*transform: translate\(0, -50%\);/s,
    );
    expect(PAGE_CSS).toMatch(
      /\.agent-connect-btn:hover::after,\s*\.agent-connect-btn:focus-visible::after\s*\{[^}]*opacity: 1;[^}]*transform: translate\(-50%, 0\);/s,
    );
  });

  it('移除原生 title，避免与自定义气泡重复出现', () => {
    expect(TOP_BAR_SOURCE).not.toContain('title={agentStatus.connected');
    expect(CONTROL_SOURCE).not.toContain('title={addTitle}');
    expect(CONTROL_SOURCE).not.toContain('title="重置到最佳视角"');
    expect(CONTROL_SOURCE).not.toContain('title="整理画布布局');
    expect(CANVAS_PAGE_SOURCE).not.toContain('title="生成历史"');
  });

  it('减少动态模式下关闭气泡过渡', () => {
    const controlReducedMotion = CONTROL_CSS.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/,
    )?.[1] || '';
    const pageReducedMotion = PAGE_CSS.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/,
    )?.[1] || '';

    expect(controlReducedMotion).toContain('.canvas-dock-btn::after');
    expect(controlReducedMotion).toContain('.canvas-rail-btn::after');
    expect(controlReducedMotion).toContain('transition: none;');
    expect(pageReducedMotion).toContain('.agent-connect-btn::after');
    expect(pageReducedMotion).toContain('transition: none;');
  });
});
