import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AppModeTabs from '@/components/AppModeTabs';
import { normalizeTheme, resolveTheme, THEME_STORAGE_KEY } from '@/lib/theme';

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
  it('用品牌 logo 打开另一工作模式的切换项', () => {
    const canvas = renderToStaticMarkup(<AppModeTabs mode="canvas" />);
    expect(canvas).toContain('aria-label="绘板菜单"');
    expect(canvas).toContain('src="/logo.png"');
    expect(canvas).toContain('width="44"');
    expect(canvas).toContain('height="44"');
    expect(canvas).toContain('aria-label="当前为无限画布，打开菜单"');
    expect(canvas).toContain('aria-haspopup="menu"');
    expect(canvas).toContain('aria-expanded="false"');
    expect(canvas).toContain('href="/workbench"');
    expect(canvas).toContain('切换到工作台');
    expect(canvas).toContain('role="menuitemradio"');
    expect(canvas).toContain('aria-checked="true"');
    expect(canvas).toContain('aria-checked="false"');
    expect(canvas.match(/role="menuitemradio"/g)).toHaveLength(3);
    expect(canvas).toContain('跟随系统');
    expect(canvas).toContain('深色');
    expect(canvas).toContain('浅色');
    expect(canvas.indexOf('跟随系统')).toBeLessThan(canvas.indexOf('浅色'));
    expect(canvas.indexOf('浅色')).toBeLessThan(canvas.indexOf('深色'));
    expect(canvas).not.toContain('href="/"');

    const workbench = renderToStaticMarkup(<AppModeTabs mode="workbench" />);
    expect(workbench).toContain('aria-label="当前为工作台，打开菜单"');
    expect(workbench).toContain('href="/"');
    expect(workbench).toContain('切换到无限画布');
    expect(workbench).not.toContain('href="/workbench"');
  });

  it('接入画布顶栏和工作台头部', () => {
    expect(TOP_BAR_SOURCE).toContain('<AppModeTabs mode="canvas" />');
    expect(WORKBENCH_SOURCE).toContain('<AppModeTabs mode="workbench" />');
    expect(TOP_BAR_SOURCE.indexOf('<AppModeTabs mode="canvas" />'))
      .toBeLessThan(TOP_BAR_SOURCE.indexOf('<div className="top-nav-workflow-wrap"'));
    expect(WORKBENCH_SOURCE).toContain('<header className="workbench-header hb-topbar">');
    expect(WORKBENCH_SOURCE.indexOf('<AppModeTabs mode="workbench" />'))
      .toBeLessThan(WORKBENCH_SOURCE.indexOf('<span className="workbench-brand-title">绘板工作台</span>'));
    expect(WORKBENCH_SOURCE.indexOf('<span className="workbench-brand-title">绘板工作台</span>'))
      .toBeLessThan(WORKBENCH_SOURCE.indexOf('<div className="hb-topbar-spacer" />'));
  });

  it('工作台顶栏不再提供重复的返回画布入口', () => {
    expect(WORKBENCH_SOURCE).not.toContain('workbench-canvas-link');
  });

  it('复用玻璃、交互和 motion Token', () => {
    expect(CSS).toContain('var(--surface-popover-glass-bg)');
    expect(CSS).toContain('var(--surface-popover-glass-blur)');
    expect(CSS).toContain('var(--surface-popover-glass-shadow)');
    expect(CSS).toContain('var(--control-bg-hover)');
    expect(CSS).toContain('var(--control-border-focus)');
    expect(CSS).toContain('var(--motion-fast)');
    expect(CSS).toContain('var(--motion-normal)');
    expect(CSS).toContain('var(--segment-track-bg)');
    expect(CSS).toContain('var(--segment-thumb-bg)');
    expect(CSS).toContain('transition: transform var(--motion-slow) var(--ease-out)');
    expect(CSS).toContain('.app-mode-tabs__trigger:hover .app-mode-tabs__logo');
    expect(CSS).toContain('transform: scale(0.8)');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).not.toMatch(/transition:\s*all/);
  });
});

describe('主题设置', () => {
  it('接受 system / light / dark，其余值回落到默认 dark', () => {
    expect(normalizeTheme('system')).toBe('system');
    expect(normalizeTheme('light')).toBe('light');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme(null)).toBe('dark');
    expect(normalizeTheme('')).toBe('dark');
    expect(normalizeTheme('auto')).toBe('dark');
  });

  it('跟随系统时解析为实际深浅主题', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('主题存储键保持稳定', () => {
    expect(THEME_STORAGE_KEY).toBe('huiban:theme');
  });
});
