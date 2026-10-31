import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { themeRevealRadius } from '@/lib/theme';

function readSource(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const TOKENS = readSource('../src/styles/tokens.css');
const ANIMATIONS = readSource('../src/styles/animations.css');
const CONTROLS = readSource('../src/components/canvas/CanvasControls.css');
const FLOW_EDGE = readSource('../src/components/canvas/FlowEdge.tsx');
const AGENT_CONNECT = readSource('../src/components/AgentConnectDialog.css');
const APP_MODE_TABS = readSource('../src/components/AppModeTabs.tsx');
const THEME = readSource('../src/lib/theme.ts');

describe('浅色模式细节', () => {
  it('画布工具激活态只保留底色，不再叠加外环', () => {
    const activeRule = CONTROLS.match(
      /\.canvas-rail-tool\.is-active,[\s\S]*?\{([\s\S]*?)\}/,
    )?.[1];

    expect(activeRule).toContain('background: var(--canvas-rail-tool-active-bg)');
    expect(activeRule).toContain('box-shadow: none');
    expect(TOKENS).not.toContain('--canvas-rail-tool-active-ring');
  });

  it('浅色 AI 对话悬浮按钮使用更轻的描边', () => {
    const borders = [...TOKENS.matchAll(
      /--chat-fab-border:\s*color-mix\(in srgb, var\(--color-shadow\) (\d+)%, transparent\);/g,
    )].map((match) => Number(match[1]));

    expect(borders).toEqual([20, 10]);
  });

  it('浅色参数滑块形成浅轨道、深填充与白滑块三层关系', () => {
    const track = [...TOKENS.matchAll(/--parameter-slider-track-bg:\s*([^;]+);/g)]
      .map((match) => match[1].trim());
    const fill = [...TOKENS.matchAll(/--parameter-slider-fill-bg:\s*([^;]+);/g)]
      .map((match) => match[1].trim());
    const thumb = [...TOKENS.matchAll(/--parameter-slider-thumb-bg:\s*([^;]+);/g)]
      .map((match) => match[1].trim());

    expect(track[1]).toBe('var(--color-bg-base)');
    expect(fill[1]).toBe('var(--color-ui-control-active)');
    expect(thumb[1]).toBe('var(--color-paper)');
  });

  it('浅色连线高光改为纯白，基础连线仍保持灰色', () => {
    const highlights = [...TOKENS.matchAll(
      /--color-edge-beam-highlight:\s*([^;]+);/g,
    )].map((match) => match[1].trim());

    expect(highlights).toEqual([
      'var(--color-text-primary)',
      'var(--color-paper)',
    ]);
    expect(FLOW_EDGE).toContain('stopColor="var(--color-edge-beam-highlight)"');
    expect(FLOW_EDGE).toContain('stopColor="var(--color-text-secondary)"');
  });
});

describe('浅色 Agent 连接弹窗', () => {
  it('弹窗用纯白模态面，卡片用更深一层的浅灰色', () => {
    const cardBackgrounds = [...TOKENS.matchAll(
      /--agent-connect-card-bg:\s*([^;]+);/g,
    )].map((match) => match[1].trim());

    expect(cardBackgrounds).toEqual([
      'var(--control-bg)',
      'var(--color-ui-control-panel)',
    ]);
    expect(AGENT_CONNECT).toMatch(
      /\.agent-connect-dialog\s*\{[^}]*background:\s*var\(--surface-modal-bg\)/s,
    );
    expect(AGENT_CONNECT).toMatch(
      /\.agent-connect-agent\s*\{[^}]*background:\s*var\(--agent-connect-card-bg\)/s,
    );
  });
});

describe('主题圆形扩散', () => {
  it('半径覆盖触发点到最远视口角', () => {
    expect(themeRevealRadius({ x: 0, y: 0 }, 300, 400)).toBe(500);
    expect(themeRevealRadius({ x: 150, y: 200 }, 300, 400)).toBe(250);
    expect(themeRevealRadius({ x: 10, y: 20 }, 300, 400)).toBe(479);
  });

  it('从 Logo 中心触发，并保留 API 与减少动效降级', () => {
    expect(APP_MODE_TABS).toContain('triggerRef.current?.getBoundingClientRect()');
    expect(APP_MODE_TABS).toContain('applyTheme(nextTheme, {');
    expect(THEME).toContain('themeRevealRadius');
    expect(THEME).toContain('document.startViewTransition(commitTheme)');
    expect(THEME).toContain("prefers-reduced-motion: reduce");
    expect(THEME).toContain('root.classList.add(THEME_TRANSITION_CLASS)');
    expect(THEME).toContain("root.style.removeProperty('--theme-reveal-radius')");
  });

  it('跟随系统时监听 prefers-color-scheme 并清理旧监听', () => {
    expect(THEME).toContain("const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)'");
    expect(THEME).toContain("query.addEventListener('change', listener)");
    expect(THEME).toContain(
      "systemThemeQuery.removeEventListener('change', systemThemeListener)",
    );
    expect(THEME).toContain(
      "document.documentElement.dataset.theme = event.matches ? 'dark' : 'light'",
    );
  });

  it('圆形 reveal 复用统一动效 Token，并避免快照拍到中间帧', () => {
    expect(ANIMATIONS).toContain('::view-transition-old(root)');
    expect(ANIMATIONS).toContain('::view-transition-new(root)');
    expect(ANIMATIONS).toContain(
      'animation: theme-reveal var(--motion-theme-switch) var(--ease-out) both;',
    );
    expect(TOKENS).toContain('--motion-theme-switch: 480ms;');
    expect(ANIMATIONS).toMatch(
      /@keyframes theme-reveal[\s\S]*circle\([\s\S]*var\(--theme-reveal-radius, 0px\)/,
    );
    expect(ANIMATIONS).toContain('html.is-theme-transitioning');
  });
});
