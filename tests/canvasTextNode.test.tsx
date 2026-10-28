import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import CanvasTextNode from '@/components/canvas/CanvasTextNode';
import type { CanvasNodeData } from '@/types';

const CSS = readFileSync(
  fileURLToPath(new URL('../src/components/canvas/CanvasTextNode.css', import.meta.url)),
  'utf8',
);
const CANVAS_PAGE_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/pages/CanvasPage.tsx', import.meta.url)),
  'utf8',
);

function renderTextNode(extra: Partial<CanvasNodeData> = {}): string {
  const data = {
    kind: 'text',
    label: '文本',
    textContent: '# 提示词',
    cardWidth: 320,
    nodeHeight: 240,
    ...extra,
  } as CanvasNodeData;
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <CanvasTextNode
        id="text_1"
        data={data as never}
        selected={false}
        type="canvas-text"
        draggable
        dragging={false}
        zIndex={0}
        selectable
        deletable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </ReactFlowProvider> as never,
  );
}

describe('文本节点视觉结构', () => {
  it('复用图像节点外壳和顶部类型标识', () => {
    const html = renderTextNode();
    expect(html).toContain('image-flow-node');
    expect(html).toContain('image-node-composer-shell');
    expect(html).toContain('image-node-kind-label');
    expect(html).toContain('>文本</span>');
    expect(html).not.toContain('canvas-text-node-head');
  });

  it('文本节点连接手柄沿用画布节点的交互命中区', () => {
    const html = renderTextNode();
    expect(html).toContain('image-node-connect-add text');
    expect(html).toContain('aria-label="作为提示词连到下游"');
  });

  it('预览区域不移动节点，右下角手柄用于调整宽高', () => {
    const preview = renderTextNode();
    expect(preview).toContain('class="canvas-text-node-preview nodrag nowheel nopan"');
    expect(preview).toContain('class="image-node-resize-handle nodrag nowheel"');
    expect(preview).toContain('aria-label="拖拽调整文本节点宽高"');
    expect(preview).not.toContain('canvas-text-node-edit');

    const editing = renderTextNode({ textEditing: true });
    expect(editing).toContain('class="canvas-text-node-input nodrag nowheel nopan"');
    expect(editing).toContain('class="image-node-resize-handle nodrag nowheel"');
  });

  it('始终渲染 Markdown 文档，不显示编辑入口或空态提示', () => {
    const html = renderTextNode();
    const empty = renderTextNode({ textContent: '' });

    expect(html).toContain('hb-chat-text');
    expect(html).toContain('<strong>提示词</strong>');
    expect(html).not.toContain('>编辑</button>');
    expect(html).not.toContain('>预览</button>');
    expect(empty).not.toContain('canvas-text-node-empty');
    expect(empty).not.toContain('双击或点');
  });

  it('右下角提供图标加文字的润色入口，并复用现有提示词优化事件', () => {
    const html = renderTextNode();
    const empty = renderTextNode({ textContent: '' });

    expect(html).toContain('class="canvas-text-node-actions"');
    expect(html).toContain('class="canvas-text-node-polish nodrag nowheel nopan"');
    expect(html).toContain('<span>润色</span>');
    expect(empty).toMatch(/class="canvas-text-node-polish[^"]*"[^>]*disabled/);
    expect(CSS).toMatch(/\.canvas-text-node-actions\s*\{[^}]*justify-content: flex-end/s);
    expect(CANVAS_PAGE_SOURCE).toContain('NODE_EVENTS.textOptimize');
    expect(CANVAS_PAGE_SOURCE).toContain('enhancePromptApi({ prompt: text, profileId: textProfile.id })');
    expect(CANVAS_PAGE_SOURCE).toContain('NODE_EVENTS.textOptimizeResult');
  });
});
