import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NodeConnectionMenu from '@/components/canvas/NodeConnectionMenu';
import type { CanvasNode } from '@/types';

function node(id: string, kind: string, label: string): CanvasNode {
  return {
    id,
    type: 'flow-image',
    position: { x: 0, y: 0 },
    data: { kind, label, prompt: '' },
  } as CanvasNode;
}

describe('节点连接菜单', () => {
  it('从图片节点右侧菜单可以选择视频节点作为下游', () => {
    const html = renderToStaticMarkup(
      <NodeConnectionMenu
        x={0}
        y={0}
        sourceId="image"
        direction="source"
        nodes={[node('image', 'image', '参考图片'), node('video', 'video', '视频生成')]}
        edges={[]}
        onClose={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(html).toContain('视频生成');
    expect(html).toContain('连接到这个节点');
  });

  it('已连接的视频节点不再作为重复连接目标出现', () => {
    const html = renderToStaticMarkup(
      <NodeConnectionMenu
        x={0}
        y={0}
        sourceId="image"
        direction="source"
        nodes={[node('image', 'image', '参考图片'), node('video', 'video', '视频生成')]}
        edges={[{ id: 'e1', source: 'image', target: 'video' }]}
        onClose={() => undefined}
        onConnect={() => undefined}
      />,
    );

    expect(html).not.toContain('视频生成');
    expect(html).toContain('没有可连接的节点');
  });
});
