import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeProps } from '@xyflow/react';
import type { CanvasNodeData, CanvasNodeVersion } from '@/types';
import NodeSelectionToolbar from '@/components/canvas/NodeSelectionToolbar';

vi.mock('@xyflow/react', () => ({
  Handle: (props: { className?: string }) => <span className={props.className} />,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const FlowImageNode = (await import('@/components/canvas/FlowImageNode')).default;

const TOOLBAR_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/NodeSelectionToolbar.css', import.meta.url)),
  'utf8',
);
const IMAGE_CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/ImageNodes.css', import.meta.url)),
  'utf8',
);
const CANVAS_PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/pages/CanvasPage.tsx', import.meta.url)),
  'utf8',
);

function cssRule(source: string, selector: string): string {
  const selectorIndex = source.indexOf(`${selector} {`);
  if (selectorIndex < 0) return '';
  const bodyStart = source.indexOf('{', selectorIndex) + 1;
  const bodyEnd = source.indexOf('}', bodyStart);
  return bodyEnd < 0 ? '' : source.slice(bodyStart, bodyEnd);
}

function transitionProperties(rule: string): string[] {
  const transition = rule.match(/transition:\s*([^;]+);/s)?.[1] || '';
  return [...transition.matchAll(
    /(?:^|,)\s*([a-z-]+)\s+(?:\d+(?:\.\d+)?m?s|var\(--motion-[^)]+\))/g,
  )].map((match) => match[1]);
}

function version(id: string, extra: Partial<CanvasNodeVersion> = {}): CanvasNodeVersion {
  return {
    id,
    imageUrl: `/api/files/${id}.png`,
    fileName: `${id}.png`,
    prompt: `prompt-${id}`,
    model: 'test-model',
    size: '1024x1024',
    createdAt: '2026-10-25T00:00:00.000Z',
    finishedAt: '2026-10-25T00:00:01.000Z',
    ...extra,
  };
}

function renderImageNode(data: CanvasNodeData): string {
  const props = { id: 'image_1', data, selected: false } as unknown as NodeProps;
  return renderToStaticMarkup(<FlowImageNode {...props} />);
}

describe('图片节点工具栏', () => {
  it('每个图标按钮都有可访问名称、功能气泡和对应描述关系', () => {
    const html = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit
        onPreview={() => undefined}
        onRedit={() => undefined}
        onRegenerate={() => undefined}
        onAnnotate={() => undefined}
        onOutpaint={() => undefined}
        copyPrompt="一只白色纸船"
        onDelete={() => undefined}
      />,
    );
    const describedBy = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    const tooltipIds = [...html.matchAll(/id="([^"]+)" class="image-selection-toolbar-tooltip"/g)]
      .map((match) => match[1]);

    expect(describedBy.length).toBeGreaterThan(0);
    expect(describedBy).toEqual(tooltipIds);
    expect((html.match(/role="tooltip"/g) || []).length).toBe(describedBy.length);
    expect(html).toContain('aria-label="放大查看图片"');
    expect(html).toContain('aria-label="删除节点"');
    expect(html).toContain('删除节点（可撤销）');
  });

  it('只有传入提示词时才显示复制入口，空白提示词也不显示', () => {
    const withoutPrompt = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
      />,
    );
    const blankPrompt = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
        copyPrompt="   "
      />,
    );
    const withPrompt = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
        copyPrompt="一只白色纸船"
      />,
    );

    expect(withoutPrompt).not.toContain('aria-label="复制提示词"');
    expect(blankPrompt).not.toContain('aria-label="复制提示词"');
    expect(withPrompt).toContain('aria-label="复制提示词"');
  });

  it('删除入口只由页面传入的回调决定', () => {
    const withoutDelete = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
      />,
    );
    const withDelete = renderToStaticMarkup(
      <NodeSelectionToolbar
        showPreview
        showRedit={false}
        onPreview={() => undefined}
        onRedit={() => undefined}
        onDelete={() => undefined}
      />,
    );

    expect(withoutDelete).not.toContain('aria-label="删除节点"');
    expect(withDelete).toContain('aria-label="删除节点"');
  });

  it('CanvasPage 仅给 AI 图片传当前版本提示词，删除只接到图片与参考图', () => {
    const toolbarStart = CANVAS_PAGE_SOURCE.indexOf('<NodeSelectionToolbar');
    const toolbarEnd = CANVAS_PAGE_SOURCE.indexOf('/>', toolbarStart);
    const toolbar = CANVAS_PAGE_SOURCE.slice(toolbarStart, toolbarEnd);

    expect(toolbar).toContain("copyPrompt={selectedImageNode.data.kind === 'image'");
    expect(toolbar).toContain('activePromptOf(selectedImageNode.data)');
    expect(toolbar).toContain(
      "onDelete={selectedImageNode.data.kind === 'image' || selectedImageNode.data.kind === 'reference'",
    );
  });
});

describe('图片节点原始尺寸', () => {
  it('生成图显示原始像素尺寸，并可通过键盘聚焦图片区域', () => {
    const html = renderImageNode({
      kind: 'image',
      label: '生成图',
      prompt: '一只白色纸船',
      imageUrl: '/api/files/generated.png',
      width: 1024,
      height: 768,
    });

    expect(html).toContain('image-node-pixel-size');
    expect(html).toContain('1024 × 768 px');
    expect(html).toContain('tabindex="0"');
  });

  it('上传图同样显示原始像素尺寸', () => {
    const html = renderImageNode({
      kind: 'reference',
      label: '上传图',
      imageUrl: '/api/files/uploaded.png',
      width: 800,
      height: 600,
    });

    expect(html).toContain('image-node-pixel-size');
    expect(html).toContain('800 × 600 px');
    expect(html).toContain('tabindex="0"');
  });

  it('当前版本尺寸优先于节点上的旧尺寸', () => {
    const html = renderImageNode({
      kind: 'image',
      label: '生成图',
      prompt: '一只白色纸船',
      imageUrl: '/api/files/current.png',
      width: 4096,
      height: 4096,
      activeVersionId: 'v1',
      versions: [
        version('v1', { width: 1024, height: 768 }),
        version('v2', { width: 2048, height: 1536 }),
      ],
    });

    expect(html).toContain('1024 × 768 px');
    expect(html).not.toContain('4096 × 4096 px');
  });
});

describe('图片节点标题', () => {
  it('空图片生成节点也显示顶部“图片”类型标题', () => {
    const html = renderImageNode({
      kind: 'composer',
      label: '图片生成',
      prompt: '',
    });

    expect(html).toContain('class="image-node-kind-label"');
    expect(html).toContain('<span>图片</span>');
  });
});

describe('节点悬停动效护栏', () => {
  it('尺寸徽标默认隐藏，hover / 键盘焦点时显示', () => {
    const rule = cssRule(IMAGE_CSS, '.image-node-pixel-size');
    expect(rule).toContain('opacity: 0;');
    expect(IMAGE_CSS).toMatch(
      /\.image-node-media:hover > \.image-node-pixel-size,\s*\.image-node-media:focus-visible > \.image-node-pixel-size\s*\{[^}]*opacity:\s*1;/s,
    );
  });

  it('尺寸徽标和工具栏气泡只过渡 opacity / transform，并尊重减少动态偏好', () => {
    expect(transitionProperties(cssRule(IMAGE_CSS, '.image-node-pixel-size')))
      .toEqual(['opacity', 'transform']);
    expect(transitionProperties(cssRule(TOOLBAR_CSS, '.image-selection-toolbar-tooltip')))
      .toEqual(['opacity', 'transform']);
    expect(IMAGE_CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(TOOLBAR_CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('工具栏气泡默认隐藏，显示时从工具栏内侧轻微上移并淡入', () => {
    const tooltip = cssRule(TOOLBAR_CSS, '.image-selection-toolbar-tooltip');
    const shown = TOOLBAR_CSS.match(
      /\.image-selection-toolbar > button:hover > \.image-selection-toolbar-tooltip,\s*\.image-selection-toolbar > button:focus-visible > \.image-selection-toolbar-tooltip \{([\s\S]*?)\}/,
    )?.[1] || '';

    expect(tooltip).toContain('--tooltip-offset-y: var(--spacing-2);');
    expect(tooltip).toContain('opacity: 0;');
    expect(tooltip).toContain('transform: translate(-50%, var(--tooltip-offset-y));');
    expect(tooltip).toContain(
      'opacity var(--motion-tooltip) var(--ease-tooltip)',
    );
    expect(tooltip).toContain(
      'transform var(--motion-tooltip) var(--ease-tooltip)',
    );
    expect(shown).toContain('opacity: 1;');
    expect(shown).toContain('transform: translate(-50%, 0);');
    expect(TOOLBAR_CSS).not.toContain(
      ':first-of-type > .image-selection-toolbar-tooltip',
    );
    expect(TOOLBAR_CSS).not.toContain(
      ':last-of-type > .image-selection-toolbar-tooltip',
    );
  });

  it('工具栏图标缩小一档，按钮命中区保持原尺寸', () => {
    const largeButton = cssRule(
      TOOLBAR_CSS,
      '.image-selection-toolbar > button.image-selection-toolbar-glyph-lg',
    );
    const largeIcon = cssRule(
      TOOLBAR_CSS,
      '.image-selection-toolbar > button.image-selection-toolbar-glyph-lg svg',
    );
    const smallButton = cssRule(
      TOOLBAR_CSS,
      '.image-selection-toolbar > button.image-selection-toolbar-glyph-sm',
    );
    const smallIcon = cssRule(
      TOOLBAR_CSS,
      '.image-selection-toolbar > button.image-selection-toolbar-glyph-sm svg',
    );

    expect(largeButton).toContain('width: 36px;');
    expect(largeButton).toContain('height: 32px;');
    expect(largeIcon).toContain('var(--icon-glyph-md)');
    expect(smallButton).toContain('width: 32px;');
    expect(smallButton).toContain('height: 32px;');
    expect(smallIcon).toContain('var(--icon-glyph-sm)');
  });

  it('功能气泡允许长文案换行，不横向撑出画布', () => {
    const rule = cssRule(TOOLBAR_CSS, '.image-selection-toolbar-tooltip');
    expect(rule).toContain('white-space: normal;');
    expect(rule).toContain('text-align: center;');
  });
});
