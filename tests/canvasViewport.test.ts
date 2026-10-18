import { describe, expect, it } from 'vitest';
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clampCanvasZoom,
  canvasSliderPosToZoom,
  canvasZoomToSliderPos,
  isNodeBoxVisible,
  viewportCenterInFlow,
  zoomViewportAroundAnchor,
} from '../src/lib/canvasViewport';

const SIZE = { width: 1000, height: 800 };

describe('滑块锚点缩放', () => {
  it('视口中心＝可见流区间的中点（pan 过之后也必须成立）', () => {
    // 屏幕 x∈[0,1000]、y∈[0,800] 在 {x:-300,y:-120,zoom:0.5} 下映射到流区间
    // x:[600,2600] / y:[240,1840]，中心必须是这两个区间各自的中点。
    // 曾经的实现返回 (700,680)——把视口左上角当成中心再换算，锚点整块偏掉。
    expect(viewportCenterInFlow({ x: -300, y: -120, zoom: 0.5 }, SIZE)).toEqual({ x: 1600, y: 1040 });
  });

  it('无选中节点时滑块缩放：锚点始终落在当前可见区间内', () => {
    // 复现用户实测：832x781 画布、pan 到右下角、25% 低倍率
    const panned = { x: 2155.78, y: 374.767, zoom: 0.253761 };
    const pane = { width: 832, height: 781 };
    const center = viewportCenterInFlow(panned, pane);
    const minX = -panned.x / panned.zoom;
    const maxX = (pane.width - panned.x) / panned.zoom;
    const minY = -panned.y / panned.zoom;
    const maxY = (pane.height - panned.y) / panned.zoom;
    expect(center.x).toBeGreaterThan(minX);
    expect(center.x).toBeLessThan(maxX);
    expect(center.y).toBeGreaterThan(minY);
    expect(center.y).toBeLessThan(maxY);
  });

  it('以视口中心为锚点：缩放后中心点的流坐标不变', () => {
    const center = viewportCenterInFlow({ x: -300, y: -120, zoom: 0.5 }, SIZE);
    const next = zoomViewportAroundAnchor(SIZE, 1, center);
    expect(next.zoom).toBe(1);
    // 中心映射回屏幕后仍应在视口正中
    expect(center.x * next.zoom + next.x).toBeCloseTo(SIZE.width / 2);
    expect(center.y * next.zoom + next.y).toBeCloseTo(SIZE.height / 2);
  });

  it('连续拖滑块：每一帧都从上一帧的视口重新取锚点，中心不漂移', () => {
    let viewport = { x: 2155.78, y: 374.767, zoom: 0.253761 };
    const pane = { width: 832, height: 781 };
    // 滑块一步一次 onChange，每次都该"围着当前看到的中心"放大
    for (const zoom of [0.4, 0.7, 1.2, 3, 6]) {
      const anchor = viewportCenterInFlow(viewport, pane);
      viewport = zoomViewportAroundAnchor(pane, zoom, anchor);
      // 锚点换算回屏幕必须始终是视口正中，误差在一个浮点 ulp 量级
      expect(anchor.x * viewport.zoom + viewport.x).toBeCloseTo(pane.width / 2, 6);
      expect(anchor.y * viewport.zoom + viewport.y).toBeCloseTo(pane.height / 2, 6);
    }
    expect(viewport.zoom).toBe(CANVAS_ZOOM_MAX);
  });

  it('以选中节点中心为锚点：节点中心不被甩走', () => {
    const anchor = { x: 2000, y: 1500 };
    const next = zoomViewportAroundAnchor(SIZE, 2, anchor);
    expect(anchor.x * next.zoom + next.x).toBeCloseTo(SIZE.width / 2);
    expect(anchor.y * next.zoom + next.y).toBeCloseTo(SIZE.height / 2);
  });

  it('缩放倍率仍被夹在统一区间内', () => {
    expect(zoomViewportAroundAnchor(SIZE, 99, { x: 0, y: 0 }).zoom).toBe(CANVAS_ZOOM_MAX);
    expect(zoomViewportAroundAnchor(SIZE, 0.001, { x: 0, y: 0 }).zoom).toBe(CANVAS_ZOOM_MIN);
    expect(clampCanvasZoom(0.15)).toBe(CANVAS_ZOOM_MIN);
  });

  it('滑块行程与倍率互换保持往返一致', () => {
    for (const zoom of [0.2, 0.8, 1, 3.5]) {
      // 滑块是 0–1000 的整数步进，往返误差在一个步进量级内即可
expect(canvasSliderPosToZoom(canvasZoomToSliderPos(zoom))).toBeCloseTo(zoom, 2);
    }
  });
});

describe('isNodeBoxVisible（生成完成定位的免打扰判定）', () => {
  const pane = { width: 1200, height: 800 };
  const node = { position: { x: 100, y: 100 } };
  const box = { width: 320, height: 320 };

  it('节点整块在视口内 → 可见，不挪镜头', () => {
    // 节点左上角落在屏幕 (50,50)：四边都在 8px 余量内
    expect(isNodeBoxVisible(node, box, { x: -50, y: -50, zoom: 1 }, pane)).toBe(true);
  });

  it('节点被滚出屏幕 → 不可见，该归位', () => {
    expect(isNodeBoxVisible({ position: { x: 3000, y: 100 } }, box, { x: -100, y: -100, zoom: 1 }, pane)).toBe(false);
    expect(isNodeBoxVisible({ position: { x: -900, y: 100 } }, box, { x: -100, y: -100, zoom: 1 }, pane)).toBe(false);
  });

  it('只露一半 / 压在边缘余量内 → 仍算不可见（裁掉的图用户看不全）', () => {
    // 右边缘探出 40px：超出 8px 余量，判不可见
    expect(isNodeBoxVisible({ position: { x: 900, y: 100 } }, box, { x: 0, y: 0, zoom: 1 }, pane)).toBe(false);
    // 下边缘探出 10px：超过 8px 余量
    expect(isNodeBoxVisible({ position: { x: 100, y: 478 } }, box, { x: 0, y: 0, zoom: 1 }, pane)).toBe(false);
  });

  it('缩放后同样按屏幕坐标判（缩小后原本离屏的节点也可能落回视口）', () => {
    expect(isNodeBoxVisible({ position: { x: 900, y: 100 } }, box, { x: 0, y: 0, zoom: 0.5 }, pane)).toBe(true);
    expect(isNodeBoxVisible({ position: { x: 100, y: 100 } }, box, { x: 0, y: 0, zoom: 2 }, pane)).toBe(false);
  });
});
