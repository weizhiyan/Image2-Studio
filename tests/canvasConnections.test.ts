import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import {
  appendUniqueCanvasConnection,
  canConnectCanvasNodeKinds,
  connectionForNewNode,
  hasCanvasConnection,
  menuClientPoint,
} from '@/lib/canvasConnections';

describe('画布连接', () => {
  it('允许图片、参考图连到视频节点，同时拒绝视频节点作为图片输入源', () => {
    expect(canConnectCanvasNodeKinds('image', 'video')).toBe(true);
    expect(canConnectCanvasNodeKinds('reference', 'video')).toBe(true);
    expect(canConnectCanvasNodeKinds('video', 'video')).toBe(false);
  });

  it('允许 Markdown 文本连到图像与视频生成节点', () => {
    expect(canConnectCanvasNodeKinds('text', 'composer')).toBe(true);
    expect(canConnectCanvasNodeKinds('text', 'video')).toBe(true);
    expect(canConnectCanvasNodeKinds('video', 'text')).toBe(false);
  });

  it('按连接菜单方向生成正确的边', () => {
    expect(connectionForNewNode('image-1', 'source', 'composer-1')).toMatchObject({
      source: 'image-1', target: 'composer-1', sourceHandle: 'out', targetHandle: 'in',
    });
    expect(connectionForNewNode('image-1', 'target', 'composer-1')).toMatchObject({
      source: 'composer-1', target: 'image-1', sourceHandle: 'out', targetHandle: 'in',
    });
  });

  it('同一对节点最多保留一条边，不受 handle 差异影响', () => {
    const edges = [{ id: 'edge-1', source: 'image-1', target: 'composer-1', sourceHandle: 'out', targetHandle: 'in' }] as Edge[];
    const duplicate = { source: 'image-1', target: 'composer-1', sourceHandle: null, targetHandle: null };
    expect(hasCanvasConnection(edges, duplicate)).toBe(true);
    expect(appendUniqueCanvasConnection(edges, duplicate, 'edge-2')).toBe(edges);
  });

  it('忽略正在改接的边，并拒绝自连接', () => {
    const edges = [{ id: 'edge-1', source: 'a', target: 'b' }] as Edge[];
    expect(hasCanvasConnection(edges, { source: 'a', target: 'b' }, 'edge-1')).toBe(false);
    expect(appendUniqueCanvasConnection(edges, { source: 'a', target: 'a', sourceHandle: null, targetHandle: null }, 'edge-2')).toBe(edges);
  });
});

describe('画布菜单定位', () => {
  it('把包裹层内坐标还原为屏幕坐标', () => {
    expect(menuClientPoint({ left: 120, top: 48 }, { x: 32, y: 64 })).toEqual({ x: 152, y: 112 });
  });

  it('没有包裹层时按视口坐标处理', () => {
    expect(menuClientPoint(null, { x: 32, y: 64 })).toEqual({ x: 32, y: 64 });
  });
});
