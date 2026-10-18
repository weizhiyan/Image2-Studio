import type { Viewport } from '@xyflow/react';

/** 画布统一缩放区间：下限 15% 看得全貌，上限 6 倍细看像素（绘画 / 节点两个画布共用） */
export const CANVAS_ZOOM_MIN = 0.15;
export const CANVAS_ZOOM_MAX = 6;
/** 滑块行程 0–1000 按对数映射到 0.15–6（40 倍行程，线性滑块在低倍率区间几乎不可调） */
export const CANVAS_ZOOM_SLIDER_STEPS = 1000;

/** 两个画布共用的默认视角：40% 是绘画页验证过的"既看得到全貌、节点又不挤"的档位 */
export const DEFAULT_CANVAS_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 0.4 };

export function clampCanvasZoom(zoom: number): number {
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, zoom));
}

export function canvasSliderPosToZoom(sliderPos: number): number {
  return CANVAS_ZOOM_MIN * Math.pow(CANVAS_ZOOM_MAX / CANVAS_ZOOM_MIN, sliderPos / CANVAS_ZOOM_SLIDER_STEPS);
}

export function canvasZoomToSliderPos(zoom: number): number {
  return Math.round(
    Math.log(clampCanvasZoom(zoom) / CANVAS_ZOOM_MIN)
    / Math.log(CANVAS_ZOOM_MAX / CANVAS_ZOOM_MIN)
    * CANVAS_ZOOM_SLIDER_STEPS,
  );
}

/**
 * 以某个流坐标为锚点缩放：缩放后锚点仍停在视口正中。
 * 滑块连续触发时每次 onChange 都走这里——直接改 zoom 不改 x/y 会让画布往左上角漂，
 * 选中节点时把锚点换成节点中心，就是「围着节点放大」；没选中就传当前视口中心。
 */
export function zoomViewportAroundAnchor(
  viewportSize: { width: number; height: number },
  nextZoom: number,
  anchor: { x: number; y: number },
): Viewport {
  const zoom = clampCanvasZoom(nextZoom);
  return {
    x: viewportSize.width / 2 - anchor.x * zoom,
    y: viewportSize.height / 2 - anchor.y * zoom,
    zoom,
  };
}

/** 当前视口正中的流坐标：没选中节点时的缩放锚点 */
export function viewportCenterInFlow(
  viewport: Viewport,
  viewportSize: { width: number; height: number },
): { x: number; y: number } {
  // 变换是 translate(x,y) scale(zoom)：屏幕 0 -> 流 -x/zoom，屏幕 width -> 流 (width-x)/zoom，
  // 取两端**中点**才是视口中心。曾经写成 x + width/2/zoom（"左上角当中心"再换算），
  // 只要 pan 过（x != 0）锚点就整块偏出去，表现为滑块缩放画布猛跳、没按当前视图放大。
  const zoom = Number(viewport.zoom) || 1;
  return {
    x: (viewportSize.width / 2 - viewport.x) / zoom,
    y: (viewportSize.height / 2 - viewport.y) / zoom,
  };
}

/** 两个视角是否等值（x/y/zoom 全对上）：水合时判"store 视角是否就是画布当前这一帧" */
export function isSameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

/** 生成完成定位的免打扰余量：节点整块落在视口内（留 8px）就不挪镜头 */
export const REVEAL_MARGIN = 8;

/**
 * 节点盒子是否已完整落在当前视口里。
 * 生成完成后的定位用它判「要不要归位」：手动生成与 MCP 生成共用——用户正盯着那儿等结果，
 * 节点没跑出屏幕就别平移镜头；被滚出屏幕 / 裁掉一半时才 focusNode。
 */
export function isNodeBoxVisible(
  node: { position: { x: number; y: number } },
  nodeSize: { width: number; height: number },
  viewport: Viewport,
  viewportSize: { width: number; height: number },
  margin: number = REVEAL_MARGIN,
): boolean {
  const zoom = Number(viewport.zoom) || 1;
  const screenX = node.position.x * zoom + viewport.x;
  const screenY = node.position.y * zoom + viewport.y;
  return screenX >= margin && screenY >= margin
    && screenX + nodeSize.width * zoom <= viewportSize.width - margin
    && screenY + nodeSize.height * zoom <= viewportSize.height - margin;
}
