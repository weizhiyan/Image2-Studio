/**
 * 报错必须在卡片里可读：发送按钮下方单独一排，红色高亮，按失败原因给原文。
 * 只认 toast 的话，错误 3 秒后就没了，画布上看不出哪张图为什么失败。
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NodeProps } from '@xyflow/react';

// Handle / Position 在 ReactFlow 容器外用不了，这里替成等价静态标签
vi.mock('@xyflow/react', () => ({
  Handle: (props: { className?: string }) => <span className={props.className} />,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const FlowImageNode = (await import('@/components/canvas/FlowImageNode')).default;

function renderComposer(data: Record<string, unknown>): string {
  const props = { id: 'composer_1', data, selected: true } as unknown as NodeProps;
  return renderToStaticMarkup(<FlowImageNode {...props} />);
}

function imageReference(id: string): Record<string, string> {
  return { id, url: `/api/files/${id}.png`, title: '参考图', kind: 'image', text: '' };
}

describe('FlowImageNode 报错行', () => {
  const base = { kind: 'composer', prompt: '一只柴犬', cardWidth: 320 };

  it('接口失败：错误文案在发送按钮那一排之后单独成排', () => {
    const html = renderComposer({ ...base, status: 'error', error: 'API Key 无效（401）' });
    expect(html).toContain('API Key 无效（401）');
    const errorIndex = html.indexOf('API Key 无效（401）');
    const sendIndex = html.indexOf('image-node-composer-send');
    expect(sendIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeGreaterThan(sendIndex);
    expect(html).toContain('image-node-composer-error');
    expect(html).toContain('role="alert"');
  });

  it('没写原因时给兜底文案，不出现空白一行', () => {
    const html = renderComposer({ ...base, status: 'error' });
    expect(html).toContain('生成失败，请重新发送');
  });

  it('成功态不渲染报错行', () => {
    const html = renderComposer({ ...base, status: 'idle' });
    expect(html).not.toContain('image-node-composer-error');
  });

  it('生成中的软提示（整理失败按原文直出）也占同一排，但不冒充致命错误', () => {
    const html = renderComposer({ ...base, status: 'running', error: '提示词优化失败，已按原文生图' });
    expect(html).toContain('提示词优化失败，已按原文生图');
    expect(html).toContain('image-node-composer-error is-pending');
    expect(html).not.toContain('role="alert"');
  });
});

describe('FlowImageNode 生成态动效', () => {
  const base = { kind: 'composer', prompt: '一只柴犬', cardWidth: 320, status: 'running' };

  it('直连生成显示白色旋转描边和灵枢点阵动画', () => {
    const html = renderComposer({ ...base, runningDirect: true });
    expect(html).toContain('image-node-running-dots');
    expect(html).toContain('image-node-running-glow is-running-direct');
    expect(html).toContain('image-node-running-glow');
    expect(html).toContain('image-node-running-border is-running-direct');
  });

  it('智能生成使用独立的随机感点阵，并保留紫色旋转描边', () => {
    const html = renderComposer({ ...base, runningDirect: false, stage: 'enhance' });
    expect(html).toContain('running-matrix is-inline');
    expect(html).not.toContain('image-node-running-glow is-running-enhanced');
    expect(html).toContain('image-node-running-border is-running-enhanced');
  });
});

/** 上游文案节点连着时，输入框空着也该能发送（文案会并进提示词）。 */
describe('FlowImageNode 空输入发送', () => {
  const base = { kind: 'composer', cardWidth: 320 };

  function sendButton(html: string): string {
    const match = html.match(/<button[^>]*image-node-composer-send[^>]*>/);
    return match ? match[0] : '';
  }

  it('连着文案引用 → 发送按钮可用，标题说明按文案生成', () => {
    const html = renderComposer({
      ...base,
      references: [{ id: 't1', url: '', title: '文本引用', kind: 'text', text: '1: 碳晶板饰面' }],
    });
    const button = sendButton(html);
    expect(button).toBeTruthy();
    expect(button).not.toContain('disabled');
    expect(button).toContain('按连接的文案生成');
  });

  it('既没文案也没提示词 → 发送按钮保持禁用', () => {
    const html = renderComposer({ ...base });
    expect(sendButton(html)).toContain('disabled');
  });

  it('只有图片引用（没有文案）→ 仍然要手写提示词', () => {
    const html = renderComposer({
      ...base,
      references: [{ id: 'i1', url: '/api/files/a.png', title: '参考图', kind: 'image', text: '' }],
    });
    expect(sendButton(html)).toContain('disabled');
  });
});

describe('FlowImageNode 二次编辑基准图编号', () => {
  it('基准图只显示基准图标签，外部参考图从图1开始', () => {
    const html = renderComposer({
      kind: 'composer',
      cardWidth: 320,
      prompt: '把背景换成雪山',
      reditBaseVersionId: 'v1',
      activeVersionId: 'v1',
      versions: [{
        id: 'v1',
        imageUrl: '/api/files/base.png',
        fileName: 'base.png',
        prompt: '原图',
        model: 'test',
        size: '1024x1024',
        createdAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:00.000Z',
      }],
      references: [imageReference('r1'), imageReference('r2')],
    });
    expect(html).toContain('二次编辑基准图：上次生成结果，不计入图1、图2编号');
    expect(html).toContain('基准图');
    expect((html.match(/image-node-composer-ref-index/g) || []).length).toBe(2);
    expect(html).not.toContain('is-redit-base"><span class="image-node-composer-ref-index"');
  });
});
