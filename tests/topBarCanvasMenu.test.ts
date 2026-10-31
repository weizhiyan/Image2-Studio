import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOP_BAR_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/components/TopBar.tsx', import.meta.url)),
  'utf8',
);
const PAGE_CSS = readFileSync(
  fileURLToPath(new URL('../src/pages/canvas-page.css', import.meta.url)),
  'utf8',
);

describe('画布下拉列表', () => {
  it('每个画布标题左侧展示最近生成图的 1:1 缩略图', () => {
    expect(TOP_BAR_SOURCE).toContain("import { latestCanvasImageUrl } from '@/lib/canvasThumbnails';");
    expect(TOP_BAR_SOURCE).toContain('className={`workflow-menu-item-thumb');
    expect(TOP_BAR_SOURCE).toContain('className="workflow-menu-item-name"');
    expect(PAGE_CSS).toMatch(/\.workflow-menu-item-thumb\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/s);
    expect(PAGE_CSS).toMatch(/\.workflow-menu-item-thumb img\s*\{[^}]*object-fit:\s*cover/s);
  });

  it('行内只保留删除，重命名继续由顶栏标题承担', () => {
    expect(TOP_BAR_SOURCE).not.toContain('EditIcon');
    expect(TOP_BAR_SOURCE).not.toContain('menuEditingId');
    expect(TOP_BAR_SOURCE).not.toContain('workflow-menu-edit');
    expect(TOP_BAR_SOURCE).toContain('title="重命名画布"');
    expect(TOP_BAR_SOURCE).toContain('className="workflow-menu-delete"');
  });

  it('下拉箭头旋转，菜单只做透明度淡入', () => {
    expect(PAGE_CSS).toMatch(/\.top-nav-workflow-menu-btn svg\s*\{[^}]*transition:\s*transform/s);
    expect(PAGE_CSS).toMatch(/\.top-nav-workflow-menu-btn\.open svg\s*\{[^}]*rotate\(180deg\)/s);
    expect(PAGE_CSS).toMatch(/\.workflow-menu\s*\{[^}]*animation:\s*fade-in var\(--motion-slow\) var\(--ease-out\)/s);
    expect(PAGE_CSS).not.toMatch(/\.workflow-menu\s*\{[^}]*grid-template-rows/s);
    expect(TOP_BAR_SOURCE).not.toContain('className="workflow-menu-reveal"');
    expect(PAGE_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.workflow-menu-list\s*\{[^}]*animation:\s*none/s);
  });

  it('删除确认遮罩与 Agent 弹窗使用同一层 scrim', () => {
    expect(PAGE_CSS).toMatch(/\.canvas-delete-confirm-overlay\s*\{[^}]*background:\s*var\(--dialog-scrim\)/s);
    expect(PAGE_CSS).toMatch(/\.canvas-delete-confirm-overlay\s*\{[^}]*backdrop-filter:\s*var\(--surface-modal-backdrop-blur\)/s);
  });
});
