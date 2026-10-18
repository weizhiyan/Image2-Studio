import { useCallback, useEffect, useRef, useState } from 'react';
import { PanOnScrollMode, SelectionMode, type Edge, type Node, type ReactFlowInstance, type Viewport } from '@xyflow/react';
import {
  CANVAS_ZOOM_MAX,
  CANVAS_ZOOM_MIN,
  clampCanvasZoom,
  isSameViewport,
  viewportCenterInFlow,
  zoomViewportAroundAnchor,
} from '@/lib/canvasViewport';

/** 铺给 ReactFlow 的画布级交互开关：两个画布共用同一套键鼠语义 */
export interface CanvasInteractionProps {
  /** 左键拖拽空白处 = 框选；开启"拖动"工具后左键只平移 */
  selectionOnDrag: boolean;
  selectionMode: SelectionMode.Partial;
  /** Shift 加选；框选只要求与节点相交（Partial），贴边即算选中 */
  multiSelectionKeyCode: 'Shift';
  /** 画布上双击不触发缩放，避免误操作 */
  zoomOnDoubleClick: boolean;
  /** 右键拖拽 = 平移画布；拖动工具开启时左键也平移 */
  panOnDrag: boolean | number[];
  /** 滚轮不缩放：笔记本触摸板双指一拨就是密集 wheel 事件，全按缩放处理等于「碰一下画布就放大」 */
  zoomOnScroll: boolean;
  /** 滚轮改平移（free：横竖双轴都跟手指），与前者互斥 */
  panOnScroll: boolean;
  panOnScrollMode: PanOnScrollMode;
  panOnScrollSpeed: number;
  /** 捏合 / Ctrl+滚轮仍然缩放：触控板缩放手势与鼠标精确缩放都走这条 */
  zoomOnPinch: boolean;
  minZoom: number;
  maxZoom: number;
}

interface UseCanvasViewControlsOptions<FlowNode extends Node, FlowEdge extends Edge> {
  /** 画布实例：泛型透传，绘画页是 Node<ImageNodeData>，节点页是默认 Node */
  rfInstance: ReactFlowInstance<FlowNode, FlowEdge> | null;
  /** store 里的持久化视角：水合 / 切页 / 刷新回来时以它为准 */
  viewport: Viewport;
  /** 写回 store（各页面自己的 setViewport，会标记 dirty 走自动保存） */
  onPersistViewport: (viewport: Viewport) => void;
  /** 拖动工具初始态：节点页以画布浏览为主，默认开启"手"；绘画页默认关（左键用于框选） */
  initialPanTool?: boolean;
}

export interface CanvasViewControls {
  panTool: boolean;
  togglePanTool: () => void;
  /** 画布当前视角（高频变化只进本地 state，不写 store） */
  flowViewport: Viewport;
  /** ReactFlow onMove：只跟本地，避免拖拽中高频写 store */
  setFlowViewport: (nextViewport: Viewport) => void;
  /** 编程式移动视角（带过渡动画），同时写回 store */
  updateCanvasViewport: (nextViewport: Viewport, duration?: number) => void;
  /** ReactFlow onMoveEnd：视角落定，写回 store 并标记已应用 */
  persistCanvasViewport: (nextViewport: Viewport) => void;
  setCanvasZoom: (zoom: number) => void;
  /** 一键到指定倍率：以视口中心为锚点缩放（不改变用户当前看着的位置） */
  zoomToPreferred: (zoom: number) => void;
  resetToBestView: () => void;
  interactionProps: CanvasInteractionProps;
}

/** dock「最佳视角」的默认倍率：80% 是看生图结果最舒服的一档，太小看不清细节 */
export const CANVAS_PREFERRED_ZOOM = 0.8;

/**
 * 选中节点包围盒的流坐标中心；没有选中（或量不到尺寸）时返回 null，
 * 调用方回落到视口中心。多选取整体中心，单选取该节点中心。
 */
function selectedNodesCenter(nodes: Array<Node>): { x: number; y: number } | null {
  const selected = nodes.filter((node) => node.selected);
  if (selected.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of selected) {
    // 节点可能还没被 ReactFlow 量过（measured 缺失）：退回 width/height，再不行按 0 只取位置
    const width = node.measured?.width ?? node.width ?? 0;
    const height = node.measured?.height ?? node.height ?? 0;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * 绘画页 / 节点页共用的画布逻辑：拖动工具、视角持久化、统一缩放区间与键鼠交互。
 * 只包"画布外壳"行为；节点与连线的渲染、增删、校验仍是各页面自己的事情。
 */
export function useCanvasViewControls<
  FlowNode extends Node = Node,
  FlowEdge extends Edge = Edge,
>({
  rfInstance,
  viewport,
  onPersistViewport,
  initialPanTool = false,
}: UseCanvasViewControlsOptions<FlowNode, FlowEdge>): CanvasViewControls {
  const [panTool, setPanTool] = useState(initialPanTool);
  const [flowViewport, setFlowViewport] = useState<Viewport>(viewport);
  /** 已应用到画布实例的 store 视角：避免水合 effect 把用户刚拖好的视角又拽回去 */
  const appliedViewportRef = useRef<Viewport | null>(null);

  const togglePanTool = useCallback(() => setPanTool((active) => !active), []);

  // store 视角晚于首帧从 sidecar 加载完成时同步回画布（水合 / 切页 / 刷新），
  // 否则画布停留在默认视角，"切页回来重置视角"就丢在这里
  // 用等值比较而不是引用比较：store 每次写视角都会换一个新对象（哪怕 x/y/zoom 完全一致），
  // 引用比较会让这个 effect 在每次缩放后都补跑一次 setViewport({duration:0})，
  // 把 updateCanvasViewport 刚起的过渡动画直接拽到终点（视觉上就是"跳一下"）。
  useEffect(() => {
    if (appliedViewportRef.current && isSameViewport(appliedViewportRef.current, viewport)) return;
    appliedViewportRef.current = viewport;
    setFlowViewport(viewport);
    if (rfInstance) void rfInstance.setViewport(viewport, { duration: 0 });
  }, [rfInstance, viewport]);

  const updateCanvasViewport = useCallback((nextViewport: Viewport, duration = 180) => {
    setFlowViewport(nextViewport);
    appliedViewportRef.current = nextViewport;
    onPersistViewport(nextViewport);
    if (rfInstance) {
      void rfInstance.setViewport(nextViewport, { duration });
    }
  }, [rfInstance, onPersistViewport]);

  const persistCanvasViewport = useCallback((nextViewport: Viewport) => {
    setFlowViewport(nextViewport);
    appliedViewportRef.current = nextViewport;
    onPersistViewport(nextViewport);
  }, [onPersistViewport]);

  // 滑块缩放：锚点优先选中节点（多选取包围盒中心），没有选中就以当前视口中心为准。
  // 两种锚点都保证「用户看着的位置不被甩走」；早期直接改 zoom 不改 x/y，画布会往左上角漂
  const setCanvasZoom = useCallback((zoom: number) => {
    if (!rfInstance) return;
    const pane = document.querySelector('.react-flow') as HTMLElement | null;
    const viewportSize = {
      width: pane?.clientWidth || window.innerWidth,
      height: pane?.clientHeight || window.innerHeight,
    };
    const current = rfInstance.getViewport();
    const anchor = selectedNodesCenter(rfInstance.getNodes())
      || viewportCenterInFlow(current, viewportSize);
    updateCanvasViewport(zoomViewportAroundAnchor(viewportSize, zoom, anchor));
  }, [rfInstance, updateCanvasViewport]);

  // 以视口中心为锚点缩放到目标倍率：直接改 zoom 会让画布往左上角漂
  const zoomToPreferred = useCallback((zoom: number) => {
    if (!rfInstance) return;
    const pane = document.querySelector('.react-flow') as HTMLElement | null;
    const width = pane?.clientWidth || window.innerWidth;
    const height = pane?.clientHeight || window.innerHeight;
    const current = rfInstance.getViewport();
    const nextZoom = clampCanvasZoom(zoom);
    updateCanvasViewport(
      zoomViewportAroundAnchor({ width, height }, nextZoom, viewportCenterInFlow(current, { width, height })),
      420,
    );
  }, [rfInstance, updateCanvasViewport]);

  // "重置到最佳视角"：按当前节点包围盒适配视野，比固定倍率更能应对分布很散的画布
  const resetToBestView = useCallback(() => {
    if (!rfInstance) return;
    void rfInstance.fitView({ padding: 0.22, duration: 420 });
    const nextViewport = rfInstance.getViewport();
    setFlowViewport(nextViewport);
    onPersistViewport(nextViewport);
  }, [rfInstance, onPersistViewport]);

  const interactionProps: CanvasInteractionProps = {
    selectionOnDrag: !panTool,
    selectionMode: SelectionMode.Partial,
    multiSelectionKeyCode: 'Shift',
    zoomOnDoubleClick: false,
    // 拖动工具开启时左/右键都平移画布；关闭时右键平移、左键留给框选
    panOnDrag: panTool ? [0, 2] : [2],
    // 键鼠语义对齐 Figma / PS：滚轮（含触摸板双指）＝平移，Ctrl+滚轮 / 捏合＝缩放。
    // 关掉 zoomOnScroll 是必须的——xyflow 的过滤逻辑里 zoomScroll 一旦为真，
    // 触摸板的连续 wheel 事件就全走 d3-zoom 的缩放分支，滚轮平移根本接管不到。
    zoomOnScroll: false,
    panOnScroll: true,
    panOnScrollMode: PanOnScrollMode.Free,
    // 1:1 跟手：触摸板事件是像素级小增量，再乘衰减会让平移比手指慢半拍
    panOnScrollSpeed: 1,
    zoomOnPinch: true,
    minZoom: CANVAS_ZOOM_MIN,
    maxZoom: CANVAS_ZOOM_MAX,
  };

  return {
    panTool,
    togglePanTool,
    flowViewport,
    setFlowViewport,
    updateCanvasViewport,
    persistCanvasViewport,
    setCanvasZoom,
    zoomToPreferred,
    resetToBestView,
    interactionProps,
  };
}
