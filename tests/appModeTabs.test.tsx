import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AppModeTabs from '@/components/AppModeTabs';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/components/AppModeTabs.css', import.meta.url)),
  'utf8',
);
const TOP_BAR_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/TopBar.tsx', import.meta.url)),
  'utf8',
);
const WORKBENCH_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/pages/WorkbenchPage.tsx', import.meta.url)),
  'utf8',
);

describe('AppModeTabs', () => {
  it('在画布与工作台模式之间切换，并标记当前页面', () => {
    const canvas = renderToStaticMarkup(<AppModeTabs mode="canvas" />);
    expect(canvas).toContain('aria-label="工作模式"');
    expect(canvas).toContain('href="/"');
    expect(canvas).toContain('href="/workbench"');
    expect(canvas).toMatch(/href="\/"[^>]*aria-current="page"[^>]*>无限画布<\/a>/);
    expect(canvas).not.toMatch(/href="\/workbench"[^>]*aria-current="page"/);

    const workbench = renderToStaticMarkup(<AppModeTabs mode="workbench" />);
    expect(workbench).toMatch(/href="\/workbench"[^>]*aria-current="page"[^>]*>工作台<\/a>/);
    expect(workbench).not.toMatch(/href="\/"[^>]*aria-current="page"/);
  });

  it('接入画布顶栏和工作台头部', () => {
    expect(TOP_BAR_SOURCE).toContain('<AppModeTabs mode="canvas" />');
    expect(WORKBENCH_SOURCE).toContain('<AppModeTabs mode="workbench" />');
    expect(TOP_BAR_SOURCE.indexOf('<AppModeTabs mode="canvas" />'))
      .toBeLessThan(TOP_BAR_SOURCE.indexOf('<div className="top-nav-workflow-wrap"'));
    expect(WORKBENCH_SOURCE).toContain('<header className="workbench-header hb-topbar">');
    expect(WORKBENCH_SOURCE.indexOf('<AppModeTabs mode="workbench" />'))
      .toBeLessThan(WORKBENCH_SOURCE.indexOf('<div className="hb-topbar-spacer" />'));
    expect(WORKBENCH_SOURCE).not.toContain('className="workbench-brand"');
    expect(WORKBENCH_SOURCE).not.toContain('className="workbench-title"');
  });

  it('工作台顶栏不再提供重复的返回画布入口', () => {
    expect(WORKBENCH_SOURCE).not.toContain('workbench-canvas-link');
  });

  it('复用玻璃、交互和 motion Token', () => {
    expect(CSS).toContain('var(--surface-popover-glass-bg)');
    expect(CSS).toContain('var(--surface-popover-glass-blur)');
    expect(CSS).toContain('var(--control-bg-selected)');
    expect(CSS).toContain('var(--control-fg-selected)');
    expect(CSS).toContain('var(--control-border-focus)');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).not.toMatch(/transition:\s*all/);
  });
});
