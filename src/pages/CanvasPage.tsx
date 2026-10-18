import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type SetStateAction } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  applyEdgeChanges,
  applyNodeChanges,
  Position,
  type EdgeProps,
  ReactFlowProvider,
  useInternalNode,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeTypes,
  type NodeChange,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '@/components/canvas/ImageNodes.css';
import FlowImageNode from '@/components/canvas/FlowImageNode';
import FlowEdge from '@/components/canvas/FlowEdge';
import TopBar from '@/components/TopBar';
import SettingsPanel from '@/components/SettingsPanel';
import AddMenu from '@/components/AddMenu';
import NodeConnectionMenu from '@/components/canvas/NodeConnectionMenu';
import { CanvasDock, CanvasRail } from '@/components/canvas/CanvasControls';
import { useCanvasViewControls } from '@/components/canvas/useCanvasViewControls';
import { DEFAULT_CANVAS_VIEWPORT, isNodeBoxVisible } from '@/lib/canvasViewport';
import { useCanvasStore } from '@/stores/canvasStore';
import { activeProfileOf, useSettingsStore } from '@/stores/settingsStore';
import { imageModelOptionsOf } from '@/lib/imageModelOptions';
import { pickTextProfile, resolveDirect, shouldEnhancePrompt } from '@/lib/enhance';
import { createId } from '@/lib/id';
import { tidyLayout, type TidyAvoidRect } from '@/lib/tidyLayout';
import { areCanvasReferencesEqual, buildReferenceNumberingInstruction } from '@/lib/references';
import { applyMediaRemap, collectMediaUrls, orphanCopiedUrls } from '@/lib/mediaFiles';
import { normalizeReferenceDataUrl } from '@/lib/imageData';
import {
  appendUniqueCanvasConnection,
  connectionForNewNode,
  menuClientPoint,
  type CanvasPendingConnection,
} from '@/lib/canvasConnections';

/**
 * composer 的上游引用统一入口：按源节点画布位置（左→右、上→下）稳定排序。
 * chips 上的「图 1 / 图 2」编号、发送给语言/生图模型的图片数组都用这个顺序——三者永远一致，
 * 不随连线画出的先后变化（曾按 edges 顺序排，用户说的「图一」和界面第 2 张对不上）。 */
function buildOrderedReferences(targetId: string, nodes: FlowNode[], edges: Edge[]): CanvasReference[] {
  // 手动拖拽过的顺序优先（chips 上「图一 / 图二」编号与发送给模型的图片数组共用这份顺序）：
  // referenceOrder 命中的引用按它排，没命中的（拖完之后新连上的）排到后面再按位置稳定排序。
  // 缺 referenceOrder 时行为与从前完全一致。
  const target = nodes.find((node) => node.id === targetId);
  const manualOrder = new Map<string, number>(
    (Array.isArray(target?.data.referenceOrder) ? target!.data.referenceOrder : [])
      .map((id, index) => [String(id), index] as [string, number]),
  );
  const orderOf = (pair: { reference: CanvasReference }): number => {
    const key = String(pair.reference.id || pair.reference.url || '');
    return manualOrder.has(key) ? (manualOrder.get(key) as number) : Number.MAX_SAFE_INTEGER;
  };
  return edges
    .filter((edge) => edge.target === targetId)
    .map((edge) => nodes.find((candidate) => candidate.id === edge.source))
    .map((source) => ({ source, reference: buildCanvasReference(source) }))
    .filter((pair): pair is { source: FlowNode; reference: CanvasReference } => Boolean(pair.reference))
    .sort((left, right) => (
      orderOf(left) - orderOf(right)
      || (left.source.position?.x ?? 0) - (right.source.position?.x ?? 0)
      || (left.source.position?.y ?? 0) - (right.source.position?.y ?? 0)
    ))
    .map((pair) => pair.reference);
}
import {
  DEFAULT_COMPOSER_NODE_WIDTH,
  MAX_COMPOSER_NODE_HEIGHT,
  MAX_COMPOSER_NODE_WIDTH,
  MIN_COMPOSER_NODE_HEIGHT,
  MIN_COMPOSER_NODE_WIDTH,
  composerWidthForRatio,
  detectPromptRatio,
  imageNodeFlowBox,
  nodeBoxFor,
  nodeWidthFor,
  parseSizeRatio,
  pickSizeForResolution,
  clampImageCount,
  resolveAutoRatio,
  ratioToNumber,
  AUTO_RATIO,
} from '@/lib/aspect';
import { activeVersionOf, normalizeVersions, versionIndexOf, versionLabel } from '@/lib/versions';
import { mergeChatRunMedia } from '@/lib/chatRunMedia';
import { answerChatRun, deleteCanvasDoc, deleteImageIfUnused, enhancePromptApi, fetchImageAsReference, generate, getCanvases, getChatThreads, getHistory, putCanvasDoc, saveImageDataUrl, startChatRun, stopChatRun, subscribeCanvasLocate, subscribeCanvasUpdated, subscribeChatRunEvents, subscribePushedImages, type ChatRunEvent } from '@/lib/bridge';
import { emitEvent, onEvent, NODE_ANIMATION_EVENTS, NODE_EVENTS, type NodeAnimationDoneDetail, type NodeConnectDetail, type NodeFocusDetail, type NodePreviewDetail, type NodePromptDetail, type NodeReditCancelDetail, type NodeReditDetail, type NodeReferenceRemoveDetail, type NodeRunDetail, type NodeUploadDetail, type NodeVersionsExpandDetail, type NodeVersionSetMainDetail, type NodeVersionsFitDetail, type NodeReferenceReorderDetail } from '@/lib/events';
import NodeGenerationToolbar from '@/components/canvas/NodeGenerationToolbar';
import NodeSelectionToolbar from '@/components/canvas/NodeSelectionToolbar';
import ImagePreviewLightbox, { type ImagePreviewItem } from '@/components/canvas/ImagePreviewLightbox';
import ImageAnnotator from '@/components/canvas/ImageAnnotator';
import HistoryPanel from '@/components/canvas/HistoryPanel';
import ChatPanel from '@/components/chat/ChatPanel';
import { draftKeyOf, useChatStore } from '@/stores/chatStore';
import type { CanvasDoc, CanvasNode, CanvasNodeData, CanvasNodeVersion, CanvasReference, ChatAskResponseSummary, ChatImageRef, ChatMessage, ChatMessageContext, ChatModelSelection, HistoryItem } from '@/types';
import './canvas-page.css';

type FlowNode = Node<CanvasNodeData, 'flow-image'>;

/** 生成主链路的结果：对话面板靠它把出图 / 失败 / 上下文续接情况写回消息。 */
interface ComposerRunResult {
  ok: boolean;
  error?: string;
  /** 本轮生成的版本 id（按发送顺序，一次多张时多个）。 */
  versionIds?: string[];
  /** 本轮实际续接上的上下文：对话消息徽标用。 */
  context?: ChatMessageContext;
}

/** 在全画布范围内按版本 id 找版本：对话的上下文链要能指到任何节点上的某一版。 */
function findVersionOnCanvas(nodes: FlowNode[], versionId: string): CanvasNodeVersion | undefined {
  const target = String(versionId || '');
  if (!target) return undefined;
  for (const node of nodes) {
    const version = normalizeVersions(node.data).find((item) => item.id === target);
    if (version) return version;
  }
  return undefined;
}

interface CanvasMenuState {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  connection: CanvasPendingConnection | null;
}

interface MenuUploadContext {
  point: { x: number; y: number };
  connection: CanvasPendingConnection | null;
}

/**
 * 节点复制剪贴板：故意放模块级变量而不是组件 state——用户要的场景是
 * 「复制节点 → 顶栏切到另一张画布 → 粘贴」，模块级连组件重挂都不怕
 * （页面不 reload 就一直在）。data 里可能带 dataURL（参考图），
 * 进出都走 JSON 深拷贝：和落盘同一套序列化，也杜绝与文档对象共享引用。
 */
interface NodeClipboard {
  /** 复制来源画布：同画布粘贴 = 原位错开（原地复制手感）；跨画布粘贴 = 落到当前视口中心 */
  canvasId: string;
  nodes: FlowNode[];
  /** 两端都在复制集里的边才跟得上：跨画布粘贴后拓扑保持不变 */
  edges: { id: string; source: string; target: string }[];
  /** 连续粘贴计数：每粘一次整体错开一截，连粘几个不会全叠在一起分不清 */
  pastes: number;
}
let nodeClipboard: NodeClipboard | null = null;

/** 画布编辑撤回栈（Ctrl+Z）的一条记录：整理只记被挪动节点的原位；粘贴记新节点 id、
 *  跟过来的边 id，外加粘贴时复制出来的媒体 URL（撤回时只清再没有节点引用的那些）。 */
type EditUndoEntry =
  | { kind: 'tidy'; positions: Map<string, { x: number; y: number }> }
  | { kind: 'paste'; nodeIds: string[]; edgeIds: string[]; copiedUrls: string[] }
  | { kind: 'graph'; nodes: FlowNode[]; edges: Edge[]; label: string };

function cloneGraphForUndo(nodes: FlowNode[], edges: Edge[]): { nodes: FlowNode[]; edges: Edge[] } {
  return {
    nodes: JSON.parse(JSON.stringify(stripNodeRuntimeFlags(nodes))) as FlowNode[],
    edges: JSON.parse(JSON.stringify(edges)) as Edge[],
  };
}

/* ── 节点动效节奏（灵枢同款，CSS 侧与之对齐）── */
/** 批量入场的错相步长 / 上限 */
const NODE_ENTER_STAGGER_STEP = 60;
const NODE_ENTER_STAGGER_MAX = 240;
/** onBeforeDelete 让 React Flow 推迟真正移除，把缩小退场这段时间留出来 */
const NODE_EXIT_ANIMATION_MS = 120;
/** 刚出图节点的一次性高亮脉冲时长 */
const FRESH_RESULT_HIGHLIGHT_MS = 3000;
/** 生成节点手动拉伸的高度区间（灵枢同款） */
// 高度上下限与 aspect.ts 共用一份（nodeBoxFor 也按它钳手动高度）

/** 一次生成最多带几张参考图：中转站的 /images/edits 一般就收到这一档，再多也是浪费。 */
const MAX_REFERENCE_IMAGES = 8;

/** 上游节点 → 引用预览：有图给缩略图；只有提示词、还没出图的生成节点给纯文本引用（灵枢同款）。 */
function buildCanvasReference(node: FlowNode | undefined): CanvasReference | null {
  if (!node) return null;
  const imageUrl = String(node.data.imageUrl || node.data.referenceDataUrl || '').trim();
  if (imageUrl) {
    return {
      id: node.id,
      url: imageUrl,
      title: String(node.data.prompt || node.data.label || '参考图'),
      kind: 'image',
      text: '',
      // 原始像素尺寸带着：比例「自动」档按它推导宽高比（缺省时退回 1:1）
      width: Number(node.data.width || 0) || undefined,
      height: Number(node.data.height || 0) || undefined,
    };
  }
  const text = String(node.data.prompt || '').trim();
  if (node.data.kind === 'composer' && text) {
    return { id: node.id, url: '', title: String(node.data.label || '文本引用'), kind: 'text', text };
  }
  return null;
}

/** 收集连入目标节点的纯文本引用提示词：生成时合并进提示词上下文（灵枢同款）。 */
function getGenerationReferenceTexts(
  targetNodeId: string,
  nodes: FlowNode[],
  edges: Edge[],
): string[] {
  const texts: string[] = [];
  for (const edge of edges) {
    if (edge.target !== targetNodeId) continue;
    const source = nodes.find((node) => node.id === edge.source);
    if (!source || source.data.kind !== 'composer') continue;
    if (String(source.data.imageUrl || source.data.referenceDataUrl || '').trim()) continue;
    const text = String(source.data.prompt || '').trim();
    if (text && !texts.includes(text)) texts.push(text);
  }
  return texts;
}

/** 是否画布节点：只保留这三类，其余一律在水合时清掉。 */
function isCanvasNode(node: FlowNode): boolean {
  return node.data.kind === 'composer' || node.data.kind === 'image' || node.data.kind === 'reference';
}

/** 客户端运行态标记不落盘：下次打开不该带着 entering / exiting / fresh 这类一次性 class。 */
function stripNodeRuntimeFlags(nodes: FlowNode[]): FlowNode[] {
  return nodes.map((node) => {
    if (!node.className && node.selected === undefined && node.dragging === undefined) return node;
    const { className: _className, selected: _selected, dragging: _dragging, ...persistent } = node;
    return persistent;
  });
}

/** 把 React Flow 盒子收敛到卡片实测宽：图片 / 参考图节点连高度一起 pin（卡片由 aspect-ratio
    精确撑高），composer 只收敛宽度——它的外壳是内容自适应高度，必须让 React Flow 贴着量。
    历史数据里这些值可能停在 composer 期、上传时的自然尺寸或旧 cardWidth（卡片后来重算过），
    不收敛的话连线端点、命中区、fitView 全按一个比卡片大的盒子算。 */
function normalizeNodeBox(node: FlowNode): FlowNode {
  const box = imageNodeFlowBox(node.data);
  const width = nodeWidthFor(node.data);
  if (box) {
    if (node.width === width && node.height === box.height
      && node.measured?.width === width && node.measured?.height === box.height) return node;
    return { ...node, width, height: box.height, measured: { width, height: box.height } };
  }
  if (node.width === width && (node.measured === undefined || node.measured.width === width)) return node;
  return {
    ...node,
    width,
    measured: node.measured ? { ...node.measured, width } : node.measured,
  };
}

/** 水合时收敛画布：剔除非画布节点、清一次性 class、剪掉指向已删节点的悬空连线。 */
function normalizeCanvasGraph(nodes: FlowNode[], edges: Edge[]) {
  const cleanedNodes = stripNodeRuntimeFlags(nodes.filter(isCanvasNode)).map(normalizeNodeBox);
  const nodeIds = new Set(cleanedNodes.map((node) => node.id));
  const cleanedEdges = edges.filter((edge) => nodeIds.has(String(edge.source)) && nodeIds.has(String(edge.target)));
  const changed = cleanedNodes.length !== nodes.length
    || cleanedEdges.length !== edges.length
    || cleanedNodes.some((node, index) => node !== nodes[index]);
  return { nodes: cleanedNodes, edges: cleanedEdges, changed };
}

/**
 * 入场编排的水波：按当前视角的 16px 点阵从中心荡开一圈，配合 is-entering 的
 * CSS 时间线（画布 660ms → dock/rail 1080ms）把"页面活了"的第一印象补上。
 */
function CanvasEntryWave({
  hostRef,
  viewport,
  onComplete,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  viewport: Viewport;
  onComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const initialViewportRef = useRef(viewport);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onComplete();
      return undefined;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      onComplete();
      return undefined;
    }
    const bounds = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const centerX = width / 2;
    const centerY = height / 2;
    const initialViewport = initialViewportRef.current;
    const gridGap = 16 * initialViewport.zoom;
    const minimumRingHalfWidth = 48;
    const maximumRingHalfWidth = 320;
    const maxRadius = Math.hypot(centerX, centerY) + maximumRingHalfWidth;
    const duration = 2400;
    const dotColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-text-primary').trim() || '#ffffff';
    let animationFrame = 0;
    let completed = false;
    const startedAt = performance.now();

    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.scale(pixelRatio, pixelRatio);
    context.fillStyle = dotColor;

    const finish = () => {
      if (completed) return;
      completed = true;
      window.cancelAnimationFrame(animationFrame);
      onComplete();
    };
    const drawFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const easedProgress = progress * progress * (3 - 2 * progress);
      const radius = easedProgress * maxRadius;
      const ringHalfWidth = minimumRingHalfWidth
        + (maximumRingHalfWidth - minimumRingHalfWidth) * Math.pow(easedProgress, 2);
      // 后半段显著加宽；带内使用缓衰减，让计算宽度真实反映到视觉宽度。
      const waveFade = Math.pow(1 - progress, 0.82);
      context.clearRect(0, 0, width, height);
      const startX = ((initialViewport.x % gridGap) + gridGap) % gridGap;
      const startY = ((initialViewport.y % gridGap) + gridGap) % gridGap;
      for (let y = startY; y <= height; y += gridGap) {
        const deltaY = y - centerY;
        for (let x = startX; x <= width; x += gridGap) {
          const distanceFromRing = Math.abs(Math.hypot(x - centerX, deltaY) - radius);
          if (distanceFromRing > ringHalfWidth) continue;
          const bandStrength = Math.pow(1 - distanceFromRing / ringHalfWidth, 0.6);
          const strength = bandStrength * waveFade;
          if (strength < 0.012) continue;
          context.globalAlpha = 0.42 * strength;
          context.beginPath();
          context.arc(x, y, 1, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;
      if (progress < 1 && document.visibilityState === 'visible') {
        animationFrame = window.requestAnimationFrame(drawFrame);
      } else {
        finish();
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') finish();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    animationFrame = window.requestAnimationFrame(drawFrame);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.cancelAnimationFrame(animationFrame);
    };
  }, [hostRef, onComplete]);

  return <canvas ref={canvasRef} className="image-canvas-entry-wave" aria-hidden="true" />;
}

/** 历史记录图标：左侧功能竖条上的生成历史入口。 */
function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4v3.5H7" />
      <path d="M12 8v4l2.8 1.8" />
    </svg>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      void normalizeReferenceDataUrl(String(reader.result || '')).then(resolve, reject);
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function urlToDataUrl(url: string): Promise<string> {
  return fetch(url)
    .then(async (res) => {
      if (!res.ok) throw new Error(`图片读取失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      const contentType = String(res.headers.get('content-type') || blob.type || '').toLowerCase();
      if (contentType && !contentType.startsWith('image/')) {
        throw new Error('图片资源返回的不是图像格式');
      }
      return blob;
    })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        void normalizeReferenceDataUrl(String(reader.result || '')).then(resolve, reject);
      };
      reader.onerror = () => reject(new Error('图片转换失败'));
      reader.readAsDataURL(blob);
    }));
}

function imageNaturalSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = url;
  });
}

/** 屏幕固定的画布功能条（左侧 rail / 左下角 dock）→ 画布坐标禁入矩形，整理布局时避开。
 *  这两个条锚在屏幕上、不随视口平移缩放，所以必须取当前视口下两个角的流量坐标换算宽高，
 *  只挪左上角会漏掉缩放（用户实测整理完卡片压住图标）。 */
function canvasAvoidRects(rf: Pick<ReactFlowInstance, 'screenToFlowPosition'>): TidyAvoidRect[] {
  const rects: TidyAvoidRect[] = [];
  for (const selector of ['.canvas-rail', '.canvas-dock']) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const topLeft = rf.screenToFlowPosition({ x: box.left, y: box.top });
    const bottomRight = rf.screenToFlowPosition({ x: box.right, y: box.bottom });
    rects.push({
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    });
  }
  return rects;
}

function CanvasWorkspace() {
  const canvases = useCanvasStore((state) => state.canvases);
  const activeId = useCanvasStore((state) => state.activeId);
  const cursor = useCanvasStore((state) => state.cursor);
  const setActive = useCanvasStore((state) => state.setActive);
  const createCanvas = useCanvasStore((state) => state.createCanvas);
  const renameCanvas = useCanvasStore((state) => state.renameCanvas);
  const deleteCanvas = useCanvasStore((state) => state.deleteCanvas);
  const addNode = useCanvasStore((state) => state.addNode);
  const updateNode = useCanvasStore((state) => state.updateNode);
  const setGraph = useCanvasStore((state) => state.setGraph);
  const mergeCanvasNodes = useCanvasStore((state) => state.mergeCanvasNodes);
  const removeNode = useCanvasStore((state) => state.removeNode);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const advanceCursor = useCanvasStore((state) => state.advanceCursor);

  const loadSettings = useSettingsStore((state) => state.load);
  const settings = useSettingsStore((state) => state.settings);
  const setDirect = useSettingsStore((state) => state.setDirect);
  const chatOpen = useChatStore((state) => state.open);
  /** 兼容旧 direct 字段：true = Image API，false = Responses API 智能生成。 */
  const direct = resolveDirect(undefined, settings?.direct);

  const rf = useReactFlow();
  const viewport = useViewport();
  // 画布视角以 store 里持久化的那份为准：切画布 / 刷新回来要还原
  const activeDocForView = canvases.find((doc) => doc.id === activeId) || canvases[0];
  const viewControls = useCanvasViewControls<FlowNode, Edge>({
    rfInstance: rf as unknown as ReactFlowInstance<FlowNode, Edge>,
    viewport: activeDocForView?.viewport || DEFAULT_CANVAS_VIEWPORT,
    onPersistViewport: setViewport,
    // 画布以浏览为主，默认开启"手"：左键拖拽即平移
    initialPanTool: true,
  });
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatPanelWidth, setChatPanelWidth] = useState(360);
  /* 生成历史抽屉：按钮锚点 + 数据 + 加载态，数据每次打开现拉 */
  const [historyOpen, setHistoryOpen] = useState(false);
  // 收起动画播放中：这时面板还挂着，动画结束（HistoryPanel 的 onClosed）才真正卸载
  const [historyClosing, setHistoryClosing] = useState(false);
  const [historyAnchor, setHistoryAnchor] = useState<{ x: number; y: number } | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  /** 历史列表的 ref 镜像：开灯箱时判断要不要兜底拉一次，不必把它加进依赖 */
  const historyItemsRef = useRef<HistoryItem[]>([]);
  const [fileDragging, setFileDragging] = useState(false);
  const [addMenu, setAddMenu] = useState<CanvasMenuState | null>(null);
  /** 把手柄「+」点出来的连接菜单挂在画布坐标上（灵枢 image-connect-menu 同款） */
  const [nodeConnectionMenu, setNodeConnectionMenu] = useState<CanvasMenuState & {
    sourceId: string;
    direction: 'source' | 'target';
  } | null>(null);
  /** 当前可输入的 composer 节点：拖动卡片与编辑提示词不互相打断 */
  const [editingNodeId, setEditingNodeId] = useState('');
  const [selectedId, setSelectedIdState] = useState('');
  const selectedIdRef = useRef('');
  const selectionIntentRef = useRef<{ nodeId: string; expiresAt: number } | null>(null);
  const [previewItem, setPreviewItem] = useState<ImagePreviewItem | null>(null);
  const [annotateNodeId, setAnnotateNodeId] = useState('');
  const [toast, setToast] = useState('');
  const nodesRef = useRef<FlowNode[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const runComposerRef = useRef<((nodeId: string, prompt: string, options?: { previousVersionId?: string }) => Promise<ComposerRunResult>) | null>(null);
  const dragDepthRef = useRef(0);
  const pendingConnectionRef = useRef<CanvasPendingConnection | null>(null);
  /** 端点拖拽是否已成功改接：onReconnect 置真，onReconnectEnd 据此区分「改接」与「拖空断开」 */
  const edgeReconnectedRef = useRef(false);
  /** 这次拖拽是「改接 / 断线」手势：onConnectEnd 对改接也会响，靠它把添加菜单憋回去 */
  const edgeReconnectingRef = useRef(false);
  /** 入场水波宿主：.hb-canvas-wrap 的 ref，动画按它的尺寸与视角铺点阵 */
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const menuFileInputRef = useRef<HTMLInputElement>(null);
  const menuUploadContextRef = useRef<MenuUploadContext | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement>(null);
  const replaceTargetRef = useRef('');
  const persistTimerRef = useRef(0);
  const toastTimerRef = useRef(0);
  /* ── 节点动效三件套（灵枢同款）：入场错相 / 删除退场 / 出图新鲜高亮 ── */
  const [enteringNodeIds, setEnteringNodeIds] = useState<string[]>([]);
  const [exitingNodeIds, setExitingNodeIds] = useState<string[]>([]);
  const [freshResultNodeId, setFreshResultNodeId] = useState('');
  const freshResultTimerRef = useRef(0);
  /** 水合 / 切画布灌入的整批节点不播入场动画，只有用户操作新增的节点才播 */
  const skipEnteringDiffRef = useRef(false);
  const knownNodeIdsRef = useRef<Set<string>>(new Set());
  /** 拖拽中 / 选择态等高频变更不落盘，位置落定与增删才写 */
  const suppressPersistRef = useRef(false);
  const nodeInteractionRef = useRef(false);
  const remoteUpdatePendingRef = useRef(false);
  const interactionReleaseTimerRef = useRef(0);
  const nodePositionProtectionRef = useRef(new Map<string, { x: number; y: number }>());
  const interactionRevisionRef = useRef(0);
  const editUndoRef = useRef<EditUndoEntry[]>([]);
  const nodeDragUndoRef = useRef<{ nodes: FlowNode[]; edges: Edge[] } | null>(null);
  const nodeDeletionRef = useRef(false);
  /** 节点粘贴的时间戳：Ctrl+V 粘完节点后，浏览器紧接着补发的 paste 事件
   *  （图片粘贴那条路）看到它是热乎的就整轮跳过——否则一次按键会同时粘出节点和参考图 */
  const nodePasteGuardRef = useRef(0);

  const nodeTypes = useMemo<NodeTypes>(() => ({ 'flow-image': FlowImageNode }), []);

  /* ── 入场编排（灵枢同款）：根节点挂 is-entering，CSS 按 660ms 起逐层展开 ── */
  const [entering, setEntering] = useState(false);
  const completeEntry = useCallback(() => setEntering(false), []);
  const entryTimerRef = useRef(0);
  /** 重播入场：挂载 / 新建画布 / 切换画布各来一次（水波按当前视角重新荡一圈） */
  const playEntry = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setEntering(false);
      return;
    }
    setEntering(true);
    window.clearTimeout(entryTimerRef.current);
    entryTimerRef.current = window.setTimeout(() => setEntering(false), 2550);
  }, []);
  useLayoutEffect(() => {
    playEntry();
    return () => window.clearTimeout(entryTimerRef.current);
  }, [playEntry]);

  // nodesRef / edgesRef 是画布真源：只在写操作里推进，绝不由渲染回写。
  // （渲染期回写会被高优先级渲染用旧 state 覆盖，连线/同步逻辑就会读不到刚建的节点）

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2600);
  }, []);

  /* 设置弹窗打开时收掉画布浮层：添加菜单（z 1000）/ 连接菜单（z 160）都比弹窗层级高，
     不收起会浮在弹窗上面穿帮（顶栏开关与「未配语言模型」自动拉起都走这里）。 */
  useEffect(() => {
    if (!settingsOpen) return undefined;
    setAddMenu(null);
    setNodeConnectionMenu(null);
  }, [settingsOpen]);

  /* 拉一次历史：抽屉、灯箱左右切图都靠它（同一份数据，按生成顺序倒序返回） */
  const loadHistory = useCallback(() => {
    if (historyLoading) return;
    setHistoryLoading(true);
    setHistoryError('');
    getHistory()
      .then((items) => {
        setHistoryItems(items);
        setHistoryLoading(false);
      })
      .catch((err: unknown) => {
        setHistoryError(err instanceof Error ? err.message : '读取生成历史失败');
        setHistoryLoading(false);
      });
  }, [historyLoading]);

  /* 打开历史抽屉时现拉：关着不请求，每次打开都是最新 */
  const openHistory = useCallback((anchor: { x: number; y: number }) => {
    setHistoryAnchor(anchor);
    setHistoryOpen(true);
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    historyItemsRef.current = historyItems;
  }, [historyItems]);

  /** 历史条目 → 灯箱条目：灯箱左右切图时按同一套字段还原信息栏 */
  const previewItemOfHistory = useCallback((item: HistoryItem): ImagePreviewItem => ({
    url: item.url,
    title: item.prompt || item.canvasName,
    details: {
      prompt: item.prompt,
      enhancedPrompt: item.enhancedPrompt,
      revisedPrompt: item.revisedPrompt,
      model: item.model,
      size: item.size,
      startedAt: item.createdAt,
      createdAt: item.createdAt,
      fileName: item.fileName,
    },
  }), []);

  /* 开灯箱时兜底拉一次历史：没有它左右切图就没有列表可翻 */
  const ensureHistoryForPreview = useCallback(() => {
    const loaded = historyItemsRef.current.length;
    if (loaded === 0) loadHistory();
  }, [loadHistory]);

  /* ── 画布 hydrate / 持久化 ── */
  const setSelectedId = useCallback((next: SetStateAction<string>) => {
    const resolved = typeof next === 'function' ? next(selectedIdRef.current) : next;
    selectedIdRef.current = resolved;
    setSelectedIdState(resolved);
  }, []);

  const hydrateActiveCanvas = useCallback((options: {
    interruptRunning?: boolean;
    preserveSelection?: boolean;
    preservePositions?: Map<string, { x: number; y: number }>;
  } = {}) => {
    const doc = useCanvasStore.getState().activeCanvas();
    const preserveId = options.preserveSelection ? selectedIdRef.current : '';
    // 刷新会中断在途请求：遗留的 running 节点不可能再等到结果，标记为中断而不是永久转圈
    const sourceNodes = (doc?.nodes || []).map((node) => {
      if (options.interruptRunning && node.data.status === 'running') {
        return { ...node, data: { ...node.data, status: 'error' as const, error: '生成已中断，请重新发送' } };
      }
      return node;
    });
    // 规范化只处理可持久化内容；当前选中节点属于本地 React Flow 运行态，
    // 不能写回 store，否则一次远端刷新会把选中态变成新的文档版本并再次广播。
    const normalized = normalizeCanvasGraph(sourceNodes as FlowNode[], doc?.edges || []);
    const renderedNodes = normalized.nodes.map((node) => {
      const protectedPosition = options.preservePositions?.get(node.id);
      const next = protectedPosition
        ? { ...node, position: protectedPosition }
        : node;
      return options.preserveSelection && preserveId
        ? { ...next, selected: next.id === preserveId }
        : next;
    });
    nodesRef.current = renderedNodes;
    edgesRef.current = normalized.edges;
    // 水合灌入的整批节点不播入场动画
    skipEnteringDiffRef.current = true;
    setNodes(renderedNodes);
    setEdges(normalized.edges);
    if (options.preserveSelection && preserveId && !normalized.nodes.some((node) => node.id === preserveId)) {
      setSelectedId('');
    }
    if ((normalized.changed || options.preservePositions?.size) && doc) {
      useCanvasStore.getState().setGraph(stripNodeRuntimeFlags(renderedNodes) as CanvasNode[], normalized.edges);
    }
  }, [setNodes, setEdges, setSelectedId]);

  useEffect(() => {
    hydrateActiveCanvas({ interruptRunning: true });
    // 注意：这里不再调 registerCanvas。每切一次画布就发一次只带 { name } 的 PUT，
    // 对还没建档的画布等于写一张空文档，会把它冲掉；注册由 create / rename 和
    // putCanvasDoc（整文档上桥）负责，仨者都会同步 registry。
    // activeId 变化即换画布；节点编辑不触发 hydrate
  }, [activeId, hydrateActiveCanvas]);

  useEffect(() => () => {
    window.clearTimeout(persistTimerRef.current);
    window.clearTimeout(interactionReleaseTimerRef.current);
  }, []);

  const persistSoon = useCallback(() => {
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      // 落定时再读 ref 而不是拿安排时的快照：粘贴 / 连边这类「同一 tick 里 ref 已
      // 推进、effect 还没来得及跑」的操作，若上一轮定时器还 pending，旧快照会把刚
      // appendNode 进 store 的新节点整批冲掉（克隆节点闪一下消失的根因）
      setGraph(stripNodeRuntimeFlags(nodesRef.current) as CanvasNode[], edgesRef.current);
    }, 250);
  }, [setGraph]);

  const setEdgesBoth = useCallback((next: Edge[]) => {
    edgesRef.current = next;
    setEdges(next);
  }, []);

  const pushGraphUndo = useCallback((label: string, beforeNodes = nodesRef.current, beforeEdges = edgesRef.current) => {
    const snapshot = cloneGraphForUndo(beforeNodes, beforeEdges);
    editUndoRef.current.push({ kind: 'graph', ...snapshot, label });
  }, []);

  const focusNode = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    const { width, height } = nodeBoxFor(node.data);
    const viewportZoom = rf.getViewport?.().zoom || 1;
    window.requestAnimationFrame(() => {
      void rf.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: Math.min(1, Math.max(0.82, viewportZoom)),
        duration: 420,
      });
    });
  }, [rf]);

  /**
   * 生成完成后的定位：**只服务 MCP 路径**（agent 通过 huiban_generate / huiban_locate 触发）。
   * 浏览器里手动发送不调用它——那张卡片用户自己盯着，不该被平移。
   * 规则：结果节点整块落在视口里就不挪镜头（留 8px 余量），被滚出屏幕 / 裁掉一半才归位；
   * agent 显式调 huiban_locate 时 onlyIfOffscreen 为 false，一律归位。
   */
  const revealResultNode = useCallback((nodeId: string, options: { onlyIfOffscreen?: boolean } = {}) => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    if (options.onlyIfOffscreen !== false) {
      const pane = document.querySelector('.react-flow') as HTMLElement | null;
      const viewport = rf.getViewport?.();
      if (pane && viewport && isNodeBoxVisible(node, nodeBoxFor(node.data), viewport, {
        width: pane.clientWidth,
        height: pane.clientHeight,
      })) return;
    }
    focusNode(nodeId);
  }, [rf, focusNode]);

  /* ── 插入位置 ── */
  const insertPosition = useCallback((clientPoint?: { x: number; y: number }) => {
    if (clientPoint) return rf.screenToFlowPosition(clientPoint);
    const bounds = document.querySelector('.hb-canvas-wrap')?.getBoundingClientRect();
    const center = bounds
      ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return rf.screenToFlowPosition(center);
  }, [rf]);

  /* ── 节点操作 ── */
  const appendNode = useCallback((node: FlowNode) => {
    // 新节点自带选中时，先把其他节点的选中摘掉：React Flow 不会因为新增一个
    // selected 节点就替用户清旧选择，不摘的话「重新生成」后老结果节点一直挂着
    // 选中描边，看起来像同时选中了两个节点
    const carried = node.selected
      ? nodesRef.current.map((item) => (item.selected ? { ...item, selected: false } : item))
      : nodesRef.current;
    // ref 先推进：同一 tick 内的连线/同步逻辑要能立刻读到新节点
    nodesRef.current = [...carried, node];
    setNodes(nodesRef.current);
    addNode(node as CanvasNode);
  }, [addNode]);

  /** 节点数据更新：本地 state（ReactFlow 渲染源）与 store（持久化）必须同步改。 */
  const patchNode = useCallback((id: string, patch: Partial<CanvasNodeData>) => {
    nodesRef.current = nodesRef.current.map((node) => (
      node.id === id ? { ...node, data: { ...node.data, ...patch } } : node
    ));
    setNodes(nodesRef.current);
    updateNode(id, patch);
  }, [updateNode]);

  /**
   * 连线变化后把上游引用同步进 composer 的 data：缩略图展示与持久化都读它。
   * 图片引用与纯文本引用（连到还没出图的生成节点）都在这里算，落盘形状与展示一致。
   */
  const syncComposerReferences = useCallback((nextEdges: Edge[]) => {
    const nextNodes = nodesRef.current;
    nextNodes.forEach((node) => {
      if (node.data.kind !== 'composer') return;
      const references = buildOrderedReferences(node.id, nextNodes, nextEdges);
      const patch: Partial<CanvasNodeData> = {};
      if (!areCanvasReferencesEqual(node.data.references, references)) {
        patch.references = references;
      }
      // 连接顺序落库（referenceOrder 就是 chips 上图 1 / 图 2 的排序依据）：
      // 已在册的按原顺序留住，新连接的追加到末尾，断开的自动消失。
      // 之前只按节点位置排序——第二张图连上来时位置靠左就成了「图 1」，先连的被挤成 2。
      const currentOrder = (Array.isArray(node.data.referenceOrder) ? node.data.referenceOrder : []).map(String);
      const ids = references.map((reference) => String(reference.id || reference.url || ''));
      const nextOrder = [
        ...currentOrder.filter((id) => ids.includes(id)),
        ...ids.filter((id) => !currentOrder.includes(id)),
      ];
      const orderChanged = nextOrder.length !== currentOrder.length
        || nextOrder.some((id, index) => id !== currentOrder[index]);
      if (orderChanged) patch.referenceOrder = nextOrder;
      if (Object.keys(patch).length > 0) patchNode(node.id, patch);
    });
  }, [patchNode]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    const removedIds = new Set(
      changes.filter((change) => change.type === 'remove').map((change) => String(change.id)),
    );
    if (removedIds.size > 0) {
      pushGraphUndo('删除节点');
      nodeDeletionRef.current = true;
      window.setTimeout(() => {
        nodeDeletionRef.current = false;
      }, 80);
    }
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    // 拖拽中与选择态不落盘：位置只在落定那一帧写，增删由写操作自己推进 store
    const meaningful = changes.some((change) => (
      change.type !== 'select'
      && change.type !== 'dimensions'
      && !(change.type === 'position' && change.dragging)
    ));
    suppressPersistRef.current = !meaningful;
    // 删除联删关联边：edge 变更不经这里，不同步就留下悬空连线
    if (removedIds.size === 0) return;
    if (selectedId && removedIds.has(selectedId)) setSelectedId('');
    const nextEdges = edgesRef.current.filter(
      (edge) => !removedIds.has(String(edge.source)) && !removedIds.has(String(edge.target)),
    );
    setEdgesBoth(nextEdges);
    syncComposerReferences(nextEdges);
    showToast('已删除节点');
  }, [pushGraphUndo, selectedId, setEdgesBoth, setSelectedId, showToast, syncComposerReferences]);

  useEffect(() => {
    // 拖拽中 / 选择态等高频变更不写盘：只有位置落定与增改才落库
    if (suppressPersistRef.current) {
      suppressPersistRef.current = false;
      return;
    }
    persistSoon();
  }, [nodes, edges, persistSoon]);

  // 删除不依赖 React Flow 当前焦点：AI 面板打开、焦点在画布工具条时也能删除选中节点。
  // 输入框和对话区域保留浏览器原生退格语义。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], .hb-chat-panel')) return;
      if (annotateNodeId) return;
      const selectedNodes = nodesRef.current.filter((node) => node.selected || node.id === selectedId);
      if (selectedNodes.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void rf.deleteElements({ nodes: selectedNodes });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [annotateNodeId, rf, selectedId]);

  /* ── 自动定位 ── */
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (changes.some((change) => change.type === 'remove') && !nodeDeletionRef.current) {
      pushGraphUndo('断开连接');
    }
    if (changes.some((change) => change.type === 'remove')) {
      pendingConnectionRef.current = null;
      edgeReconnectingRef.current = false;
    }
    const next = applyEdgeChanges(changes, edgesRef.current);
    setEdgesBoth(next);
    syncComposerReferences(next);
  }, [pushGraphUndo, setEdgesBoth, syncComposerReferences]);

  const appendConnection = useCallback((connection: Connection) => {
    const next = appendUniqueCanvasConnection(edgesRef.current, connection, createId('edge'));
    if (next === edgesRef.current) return false;
    pushGraphUndo('连接节点');
    setEdgesBoth(next);
    syncComposerReferences(next);
    return true;
  }, [pushGraphUndo, setEdgesBoth, syncComposerReferences]);

  const onConnect = useCallback((connection: Connection) => {
    appendConnection(connection);
    // 手柄对接成功即消耗掉这次拖线，onConnectEnd 不再补边
    pendingConnectionRef.current = null;
  }, [appendConnection]);

  /** 双击空白 / 拖线落空：弹出灵枢同款添加菜单，坐标相对画布包裹层并做边缘收边。 */
  const openAddMenu = useCallback((
    clientPoint?: { x: number; y: number },
    connection?: CanvasPendingConnection | null,
  ) => {
    setSettingsOpen(false);
    const rect = document.querySelector('.hb-canvas-wrap')?.getBoundingClientRect();
    const rawX = clientPoint && rect ? clientPoint.x - rect.left : (rect ? rect.width / 2 : 420);
    const rawY = clientPoint && rect ? clientPoint.y - rect.top : (rect ? rect.height / 2 : 220);
    const maxX = rect ? Math.max(16, rect.width - 192 - 8 - 16) : rawX;
    const maxY = rect ? Math.max(16, rect.height - 132 - 8 - 16) : rawY;
    const x = Math.max(8, Math.min(rawX, maxX));
    const y = Math.max(8, Math.min(rawY, maxY));
    const menuPoint = menuClientPoint(rect || null, { x, y });
    const pending = connection === undefined ? pendingConnectionRef.current : connection;
    pendingConnectionRef.current = pending;
    setNodeConnectionMenu(null);
    setAddMenu({ x, y, clientX: menuPoint.x, clientY: menuPoint.y, connection: pending });
  }, []);

  /** 菜单里新建节点后，把“拖到空白处”的那条线补上（对齐灵枢的自动连接）。 */
  const connectPending = useCallback((nodeId: string, pending = pendingConnectionRef.current) => {
    if (!pending?.sourceId || pending.sourceId === nodeId) {
      pendingConnectionRef.current = null;
      return;
    }
    const connection = connectionForNewNode(pending.sourceId, pending.handleType, nodeId);
    pendingConnectionRef.current = null;
    appendConnection(connection);
  }, [appendConnection]);

  const addComposerNode = useCallback((clientPoint?: { x: number; y: number }) => {
    const position = insertPosition(clientPoint);
    const id = createId('composer');
    // 新建节点就把「当前生效的生图模型 + 自动比例」带上：工具栏因此直接显示模型名和
    // 「自动」（对齐 Figma 2664:1903），不再退化成「选择模型 / 1:1」两个占位文案。
    // 没配好时留空，生成入口仍回落到 activeProfile——行为与改动前一致。
    const active = activeProfileOf(useSettingsStore.getState().settings);
    const defaults = active?.model ? { model: active.model, profileId: active.id } : null;
    appendNode({
      id,
      type: 'flow-image',
      position,
      width: 320,
      // 自带选中：onSelectionChange 才会把 editingNodeId 认下来，不然新建瞬间就被清空
      selected: true,
      data: {
        kind: 'composer',
        label: '输入提示词',
        prompt: '',
        status: 'idle',
        ratio: AUTO_RATIO,
        cardWidth: 320,
        ...defaults,
      },
    } as FlowNode);
    // 灵枢同款：新建即选中并进入输入态——底部工具条（上传 / 发送）跟着浮出
    setSelectedId(id);
    setEditingNodeId(id);
    return id;
  }, [appendNode, insertPosition]);

  /** 清掉画布上的旧选中：结果节点此刻处于选中态，不先摘掉就会被 React Flow 报成“多选”。 */
  const clearNodeSelection = useCallback(() => {
    if (!nodesRef.current.some((node) => node.selected)) return;
    nodesRef.current = nodesRef.current.map((node) => (node.selected ? { ...node, selected: false } : node));
    setNodes(nodesRef.current);
  }, [setNodes]);

  /** 版本链里挑一版当主图时要同步的镜像字段：灯箱、工具栏、落盘都读这些平铺字段。 */
  function mirrorVersionPatch(version: CanvasNodeVersion): Partial<CanvasNodeData> {
    return {
      kind: 'image',
      status: 'done',
      stage: undefined,
      error: '',
      prompt: String(version.prompt || ''),
      imageUrl: version.imageUrl,
      fileName: version.fileName,
      model: version.model,
      size: version.size,
      width: version.width,
      height: version.height,
      enhancedPrompt: version.enhancedPrompt,
      revisedPrompt: version.revisedPrompt,
      responseId: version.responseId,
      imageGenerationCallId: version.imageGenerationCallId,
      responseModel: version.responseModel,
      responseProfileId: version.responseProfileId,
      createdAt: version.createdAt,
      finishedAt: version.finishedAt,
      activeVersionId: version.id,
    };
  }

  /**
   * 二次编辑：就地接着这张结果图再生成一版。
   * 不再另开节点——另开节点会丢掉上一版的上下文，画布也会被迭代产物铺满；
   * 版本全部累在同一个节点上，模型看到的“基准图 + 新提示词”关系也才说得清。
   * 节点转成生成态：基准图钉进输入区（不可移除）、提示词带上原来那句，取消随时退回图片态。
   */
  const prepareRedit = useCallback((nodeId: string): CanvasNodeVersion | null => {
    const source = nodesRef.current.find((item) => item.id === nodeId);
    // AI 结果图和上传参考图都可以在当前节点上再次生成。
    if (!source || (source.data.kind !== 'image' && source.data.kind !== 'reference')) return null;
    let versions = normalizeVersions(source.data);
    const active = activeVersionOf({ ...source.data, versions });
    const imageUrl = String(
      active?.imageUrl || source.data.imageUrl || source.data.referenceDataUrl || '',
    ).trim();
    if (!imageUrl) return null;
    const baseVersion: CanvasNodeVersion = active
      ? { ...active, imageUrl }
      : {
        id: String(source.data.activeVersionId || createId('ver')),
        imageUrl,
        fileName: String(source.data.fileName || ''),
        prompt: String(source.data.prompt || '') || '基于这张参考图生成一张新的图像，保留主体和整体风格。',
        model: String(source.data.model || ''),
        size: String(source.data.size || ''),
        width: source.data.width,
        height: source.data.height,
        createdAt: String(source.data.createdAt || ''),
        finishedAt: String(source.data.finishedAt || source.data.createdAt || ''),
      };
    if (active && active.imageUrl !== imageUrl) {
      versions = versions.map((version) => version.id === active.id ? baseVersion : version);
    } else if (!versions.some((version) => version.id === baseVersion.id)) {
      versions = [...versions, baseVersion];
    }
    clearNodeSelection();
    patchNode(nodeId, {
      kind: 'composer',
      versions,
      activeVersionId: baseVersion.id,
      reditBaseVersionId: baseVersion.id,
      // 位图尺寸留着：卡片宽度与拖拽盒子都按原图比例算，编辑态不会突然变窄
      width: baseVersion.width,
      height: baseVersion.height,
      size: String(baseVersion.size || ''),
      prompt: String(baseVersion.prompt || ''),
      model: String(baseVersion.model || ''),
      composerEditing: true,
      status: 'idle',
      stage: undefined,
      error: '',
      imageUrl: '',
      referenceDataUrl: '',
      fileName: '',
    });
    setSelectedId(nodeId);
    setEditingNodeId(nodeId);
    return baseVersion;
  }, [clearNodeSelection, patchNode, setSelectedId, setEditingNodeId]);

  const startRedit = useCallback((nodeId: string) => {
    if (!prepareRedit(nodeId)) return;
    focusNode(nodeId);
  }, [prepareRedit, focusNode]);

  /** 重新生成沿用当前结果节点和版本链，不额外创建节点或连接线。 */
  const regenerateFromImage = useCallback((nodeId: string) => {
    const source = nodesRef.current.find((item) => item.id === nodeId);
    if (!source || (source.data.kind !== 'image' && source.data.kind !== 'reference')) return;
    const baseVersion = prepareRedit(nodeId);
    if (!baseVersion) return;
    const prompt = String(baseVersion.prompt || source.data.prompt || '').trim()
      || '基于这张参考图生成一张新的图像，保留主体和整体风格。';
    focusNode(nodeId);
    void runComposerRef.current?.(nodeId, prompt);
  }, [prepareRedit, focusNode]);

  /** 标注保存：合成图先落盘成媒体文件，再作为新版本挂回节点，最后直接进二次编辑态接着写描述。 */
  const handleAnnotateSave = useCallback(async (dataUrl: string, generatePrompt?: string) => {
    const nodeId = annotateNodeId;
    if (!nodeId) throw new Error('标注节点不存在，请重新打开标注');
    const source = nodesRef.current.find((item) => item.id === nodeId);
    if (!source) throw new Error('标注节点不存在，请重新打开标注');
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      const body = await res.json().catch(() => null) as { data?: { url: string; fileName: string }; msg?: string } | null;
      if (!res.ok || !body?.data?.url) throw new Error(body?.msg || `标注图保存失败（HTTP ${res.status}）`);
      const versions = normalizeVersions(source.data);
      const active = activeVersionOf({ ...source.data, versions });
      const now = new Date().toISOString();
      const version: CanvasNodeVersion = {
        id: createId('ver'),
        imageUrl: body.data.url,
        fileName: body.data.fileName,
        prompt: String(active?.prompt || source.data.prompt || ''),
        model: String(active?.model || source.data.model || ''),
        size: String(active?.size || source.data.size || ''),
        width: active?.width,
        height: active?.height,
        createdAt: now,
        finishedAt: now,
        enhancedPrompt: String(active?.enhancedPrompt || ''),
        revisedPrompt: String(active?.revisedPrompt || ''),
        baseVersionId: active?.id,
      };
      // patchNode 同步改 nodesRef，紧接着的 startRedit 能读到刚挂上的版本
      patchNode(nodeId, {
        versions: [...versions, version],
        activeVersionId: version.id,
      });
      startRedit(nodeId);
      setAnnotateNodeId('');
      if (generatePrompt !== undefined) {
        const prompt = generatePrompt.trim() || '根据参考图中的标注修改图像，保留未标注区域。';
        patchNode(nodeId, { prompt });
        void runComposerRef.current?.(nodeId, prompt);
      } else {
        showToast('标注已保存，接着补描述就能发送');
      }
    } catch (err) {
      showToast(`标注保存失败：${err instanceof Error ? err.message : '未知错误'}`);
      throw err;
    }
  }, [annotateNodeId, patchNode, startRedit, showToast]);

  /** 取消二次编辑：节点退回图片态，主图仍是进入编辑前那一版。 */
  const cancelRedit = useCallback((nodeId: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    const versions = normalizeVersions(node.data);
    const active = activeVersionOf({ ...node.data, versions });
    if (!active) return;
    patchNode(nodeId, {
      ...mirrorVersionPatch(active),
      versions,
      reditBaseVersionId: undefined,
      composerEditing: undefined,
    });
    setEditingNodeId('');
    emitEvent(NODE_EVENTS.versionsCollapse, { nodeId });
  }, [patchNode]);

  /** 版本宫格里「设为主图」：换主图 + 收起宫格 + 定位回这个节点。 */
  const setVersionMain = useCallback((nodeId: string, versionId: string) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    const versions = normalizeVersions(node.data);
    const target = versions.find((item) => item.id === versionId);
    if (!target) return;
    patchNode(nodeId, { ...mirrorVersionPatch(target), versions });
    emitEvent(NODE_EVENTS.versionsCollapse, { nodeId });
    focusNode(nodeId);
    showToast(`已把 ${versionLabel(versionIndexOf(node.data, versionId))} 设为主图`);
  }, [patchNode, focusNode, showToast]);

  const addReferenceFile = useCallback(async (file: File, clientPoint?: { x: number; y: number }): Promise<string | null> => {
    if (!file.type.startsWith('image/')) {
      showToast('只支持图片文件');
      return null;
    }
    const dataUrl = await fileToDataUrl(file);
    const size = await imageNaturalSize(dataUrl);
    // 先落 bridge 媒体目录：节点只存 /api/files 轻量引用，localStorage 不再被大图撑爆
    let imageUrl = '';
    try {
      imageUrl = (await saveImageDataUrl(dataUrl)).url;
    } catch {
      showToast('本机 Bridge 未连接，图片暂时只保存在当前浏览器');
    }
    const id = createId('reference');
    appendNode({
      id,
      type: 'flow-image',
      position: insertPosition(clientPoint),
      data: {
        kind: 'reference',
        label: file.name.replace(/\.[^.]+$/, '') || '参考图',
        referenceDataUrl: imageUrl ? undefined : dataUrl,
        imageUrl: imageUrl || undefined,
        width: size.width,
        height: size.height,
        cardWidth: Math.min(420, Math.max(220, size.width || 300)),
        source: 'browser',
      },
    } as FlowNode);
    return id;
  }, [appendNode, insertPosition, showToast]);

  /** 链接 / dataURL 图片 → 参考图节点：http(s) 经 bridge 代取落盘，dataURL 直接用。 */
  const addReferenceFromUrl = useCallback(async (rawUrl: string, clientPoint?: { x: number; y: number }): Promise<string | null> => {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return null;
    let referenceDataUrl = '';
    let imageUrl = '';
    if (trimmed.startsWith('data:image/')) {
      try {
        referenceDataUrl = await normalizeReferenceDataUrl(trimmed);
      } catch (error) {
        showToast(error instanceof Error ? error.message : '参考图格式转换失败');
        return null;
      }
      try {
        imageUrl = (await saveImageDataUrl(referenceDataUrl)).url;
        referenceDataUrl = '';
      } catch {
        showToast('本机 Bridge 未连接，图片暂时只保存在当前浏览器');
      }
    } else if (/^https?:\/\//i.test(trimmed)) {
      try {
        imageUrl = await fetchImageAsReference(trimmed);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '图片获取失败');
        return null;
      }
    } else {
      showToast('只支持图片文件或 http(s) 图片链接');
      return null;
    }
    const size = await imageNaturalSize(referenceDataUrl || imageUrl);
    const id = createId('reference');
    appendNode({
      id,
      type: 'flow-image',
      position: insertPosition(clientPoint),
      data: {
        kind: 'reference',
        label: '参考图',
        referenceDataUrl: referenceDataUrl || undefined,
        imageUrl: imageUrl || undefined,
        width: size.width,
        height: size.height,
        cardWidth: Math.min(420, Math.max(220, size.width || 300)),
        source: 'browser',
      },
    } as FlowNode);
    return id;
  }, [appendNode, insertPosition, showToast]);

  /** 刚出图节点的一次性高亮脉冲：帮用户在密集画布上快速定位"当前图片" */
  const markFreshResultNode = useCallback((nodeId: string) => {
    if (!nodeId) return;
    setFreshResultNodeId(nodeId);
    window.clearTimeout(freshResultTimerRef.current);
    freshResultTimerRef.current = window.setTimeout(() => setFreshResultNodeId(''), FRESH_RESULT_HIGHLIGHT_MS);
  }, []);

  /* ── 对话（Agent 运行，方案 §12/§13）──
     发送 = 起一个 bridge run：「语言模型 ⇄ generate_image 工具」循环由 bridge 跑，
     前端经 SSE 收事件回写占位消息；生图节点由 bridge 统一落盘（与 MCP 推图同一条
     写入链），经推图通道渲染，消息只存 nodeId + versionId 引用。 */

  /** 线程里最后一张生成图的版本与落点：默认续接候选。 */
  const lastMediaVersionOf = useCallback((messages: ChatMessage[]): { versionId: string; canvasId?: string } | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && /新需求|另一个|另外做|重新做|全新|从头开始|不基于|换一个方向|另起|新做一个|另外设计/.test(message.content.toLowerCase())) {
        return null;
      }
      if (message.role !== 'assistant') continue;
      const own = message.media && message.media.length > 0 ? message.media : [];
      const fromTools = (message.toolCalls || []).flatMap((call) => call.media || []);
      const last = [...own, ...fromTools].pop();
      if (last?.versionId) return { versionId: last.versionId, canvasId: last.canvasId };
    }
    return null;
  }, []);

  const locateChatRefRef = useRef<((ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => void) | null>(null);

  /** SSE 事件 → 占位消息。终态保护：已完成 / 已停止 / 已失败的消息不被晚到事件覆盖。 */
  const applyChatRunEvent = useCallback((threadId: string, messageId: string, event: ChatRunEvent, runId?: string) => {
    const store = useChatStore.getState();
    const thread = store.threads.find((item) => item.id === threadId);
    const active = store.activeRun;
    const targetMessageId = runId && active?.runId === runId && active.threadId === threadId
      ? active.messageId
      : messageId;
    const message = thread?.messages.find((item) => item.id === targetMessageId);
    const terminal = Boolean(message?.status)
      && message?.status !== 'running'
      && message?.status !== 'awaiting_input';
    // 终态消息不接受晚到事件。bridge 在 error 后仍会补一条 message_done，
    // 这条 done 不能把 error / stopped 改回成功。
    if (terminal) return;
    const clearActiveRunIfCurrent = () => {
      const active = useChatStore.getState().activeRun;
      if (!runId || (active?.runId === runId && active.threadId === threadId && active.messageId === targetMessageId)) {
        store.setActiveRun(null);
      }
    };
    switch (event.type) {
      case 'message_delta':
        store.patchMessage(threadId, targetMessageId, { content: `${message?.content || ''}${event.text}` });
        return;
      case 'clarification_requested': {
        const current = useChatStore.getState().threads
          .find((item) => item.id === threadId)?.messages.find((item) => item.id === targetMessageId);
        store.patchMessage(threadId, targetMessageId, {
          status: 'awaiting_input',
          content: current?.content || '我先确认几个关键信息，再继续处理。',
          clarifications: [
            ...(current?.clarifications || []),
            { callId: event.callId, questions: event.questions, status: 'awaiting_input' },
          ],
        });
        return;
      }
      case 'clarification_answered': {
        const current = useChatStore.getState().threads
          .find((item) => item.id === threadId)?.messages.find((item) => item.id === targetMessageId);
        store.patchMessage(threadId, targetMessageId, {
          status: 'running',
          clarifications: (current?.clarifications || []).map((item) => (
            item.callId === event.callId ? { ...item, answers: event.answers, status: 'answered' } : item
          )),
        });
        return;
      }
      case 'tool_started':
        store.patchMessage(threadId, targetMessageId, {
          toolCalls: [...(message?.toolCalls || []), {
            id: event.callId,
            name: event.name,
            args: event.args,
            status: 'running',
            steps: [],
            model: event.model,
            profileName: event.profileName,
            startedAt: event.startedAt,
          }],
        });
        return;
      case 'tool_progress':
        store.patchMessage(threadId, targetMessageId, {
          toolCalls: (message?.toolCalls || []).map((call) => (
            call.id === event.callId ? { ...call, steps: [...call.steps, event.step] } : call
          )),
        });
        return;
      case 'image_completed':
        {
          const shouldLocate = !message?.media?.length && event.media.nodeId;
          store.patchMessage(threadId, targetMessageId, {
            media: mergeChatRunMedia(message?.media || [], event.media),
            toolCalls: (message?.toolCalls || []).map((call) => (
              call.id === event.callId ? {
                ...call,
                media: mergeChatRunMedia(call.media || [], event.media),
                model: event.media.model || call.model,
                size: event.media.size || call.size,
              } : call
            )),
          });
          if (event.media.canvasId) store.patchThread(threadId, { canvasId: event.media.canvasId });
          if (shouldLocate) {
            locateChatRefRef.current?.({
              canvasId: event.media.canvasId || thread?.canvasId || activeId,
              nodeId: event.media.nodeId,
              versionId: event.media.versionId,
              force: true,
            });
          }
          return;
        }
      case 'context_updated':
        store.patchMessage(threadId, targetMessageId, { context: event.context });
        return;
      case 'memory_updated':
        store.patchThread(threadId, { memory: event.memory });
        return;
      case 'tool_finished':
        store.patchMessage(threadId, targetMessageId, {
          toolCalls: (message?.toolCalls || []).map((call) => (
            call.id === event.callId ? {
              ...call,
              status: event.status,
              error: event.error,
              durationMs: event.durationMs,
              finishedAt: event.finishedAt,
            } : call
          )),
        });
        return;
      case 'message_done':
        store.patchMessage(threadId, targetMessageId, { status: event.status === 'stopped' ? 'stopped' : 'done' });
        clearActiveRunIfCurrent();
        // 收起期间出了结果：FAB 亮未读点
        if (!store.open) store.markUnread();
        return;
      case 'error':
        store.patchMessage(threadId, targetMessageId, { status: 'error', error: event.message });
        clearActiveRunIfCurrent();
        return;
      default:
        return;
    }
  }, [activeId]);

  const chatRunCleanupRef = useRef<(() => void) | null>(null);
  const chatRunStartingRef = useRef(false);
  const [chatRunStarting, setChatRunStarting] = useState(false);

  /** 对话发送：用户消息 + 占位助手消息上屏 → 起 run → SSE 回写。 */
  const startChatRunFlow = useCallback(async (
    prompt: string,
    refs: ChatImageRef[],
    replay: { base?: ChatImageRef | null; previousVersionId?: string; previousCanvasId?: string; modelSelection?: ChatModelSelection } = {},
  ) => {
    if (chatRunStartingRef.current || useChatStore.getState().activeRun) return;
    // 对话面板可能长时间未关闭：发送前刷新 Bridge 配置，避免旧线程继续携带已删除或停用的模型 id。
    await loadSettings();
    // 生成结果必须有画布落点；初始化或切换画布的瞬间没有 activeId 时，自动创建一张工作画布，
    // 避免用户点击发送后静默丢失消息。
    const targetCanvasId = activeId || useCanvasStore.getState().activeId || useCanvasStore.getState().createCanvas('对话结果');
    if (!targetCanvasId) {
      showToast('暂时没有可用画布，请稍后再试');
      return;
    }
    const store = useChatStore.getState();
    // 线程是全局实体；没有活跃线程时才创建，当前画布只决定本次结果落点。
    const current = store.threads.find((item) => item.id === store.activeThreadId);
    const threadId = current
      ? current.id
      : store.createThread(targetCanvasId);
    if (!threadId) return;
    // 「继续编辑」钉的基准图排在本轮引用第一位（图 1），同时作为续接源
    const base = replay.base !== undefined ? replay.base : store.draftBase;
    const effectiveRefs: ChatImageRef[] = base
      ? [base, ...refs.filter((ref) => draftKeyOf(ref) !== draftKeyOf(base))]
      : refs;
    // 用户消息（引用快照：发送后草稿就清了）
    const settingsSnapshot = useSettingsStore.getState().settings;
    const activeImageProfile = activeProfileOf(settingsSnapshot);
    const textProfile = pickTextProfile(settingsSnapshot);
    const requestedSelection = replay.modelSelection;
    const imageProfileIds = new Set((settingsSnapshot?.profiles || [])
      .filter((profile) => profile.kind === 'image' && profile.enabled !== false)
      .map((profile) => profile.id));
    const textProfileIds = new Set((settingsSnapshot?.profiles || [])
      .filter((profile) => profile.kind === 'text' && profile.enabled !== false)
      .map((profile) => profile.id));
    const imageProfileId = requestedSelection?.imageProfileId && imageProfileIds.has(requestedSelection.imageProfileId)
      ? requestedSelection.imageProfileId
      : activeImageProfile?.id;
    const selectedImageProfile = (settingsSnapshot?.profiles || []).find((profile) => profile.id === imageProfileId);
    const modelSelection: ChatModelSelection = {
      imageProfileId,
      imageModel: selectedImageProfile?.enabledModels.includes(String(requestedSelection?.imageModel || ''))
        ? requestedSelection?.imageModel
        : undefined,
      textProfileId: requestedSelection?.textProfileId && textProfileIds.has(requestedSelection.textProfileId)
        ? requestedSelection.textProfileId
        : textProfile?.id,
    };
    store.appendMessage(threadId, {
      role: 'user',
      content: prompt,
      modelSelection,
      attachments: effectiveRefs.map((ref) => ({
        canvasId: ref.canvasId || targetCanvasId,
        nodeId: ref.nodeId,
        versionId: ref.versionId,
        url: ref.url,
        title: ref.title,
        position: ref.position ?? (base && draftKeyOf(ref) === draftKeyOf(base) ? 0 : undefined),
      })),
    });
    // 占位 assistant 消息：running 态，SSE 事件往上补
    const messageId = store.appendMessage(threadId, { role: 'assistant', content: '', status: 'running' });
    const thread = useChatStore.getState().threads.find((item) => item.id === threadId);
    if (!thread) return;
    const previous = base
      ? { versionId: base.versionId || '', canvasId: base.canvasId }
      : replay.previousVersionId
        ? { versionId: replay.previousVersionId, canvasId: replay.previousCanvasId }
        : lastMediaVersionOf(thread.messages.slice(0, -1));
    const previousVersionId = previous?.versionId || '';
    chatRunStartingRef.current = true;
    setChatRunStarting(true);
    try {
      const runId = await startChatRun({
        threadId,
        canvasId: targetCanvasId,
        thread,
        references: effectiveRefs.map((ref) => ({ canvasId: ref.canvasId || targetCanvasId, nodeId: ref.nodeId, versionId: ref.versionId })),
        previousVersionId: previousVersionId || undefined,
        previousCanvasId: previous?.canvasId || undefined,
        assistantMessageId: messageId,
        modelSelection,
      });
      store.setActiveRun({ runId, threadId, messageId });
      chatRunCleanupRef.current?.();
      chatRunCleanupRef.current = subscribeChatRunEvents(runId, (event) => {
        applyChatRunEvent(threadId, messageId, event, runId);
      });
      store.clearDraft();
      store.setDraftBase(null);
    } catch (err) {
      useChatStore.getState().patchMessage(threadId, messageId, {
        status: 'error',
        error: err instanceof Error ? err.message : '启动对话失败',
      });
      showToast('对话启动失败，请检查 bridge 是否在运行');
    } finally {
      chatRunStartingRef.current = false;
      setChatRunStarting(false);
    }
  }, [activeId, applyChatRunEvent, lastMediaVersionOf, loadSettings, showToast]);

  /** 停止运行：中断在途请求，消息置 stopped（终态，晚到事件不覆盖）。 */
  const stopChatRunFlow = useCallback(() => {
    const run = useChatStore.getState().activeRun;
    if (!run) return;
    void stopChatRun(run.runId);
    useChatStore.getState().patchMessage(run.threadId, run.messageId, {
      status: 'stopped',
      toolCalls: (useChatStore.getState().threads.find((item) => item.id === run.threadId)?.messages.find((item) => item.id === run.messageId)?.toolCalls || []).map((call) => (
        call.status === 'running' ? { ...call, status: 'stopped' as const, finishedAt: new Date().toISOString(), durationMs: call.startedAt ? Math.max(0, Date.now() - Date.parse(call.startedAt)) : undefined } : call
      )),
    });
    useChatStore.getState().setActiveRun(null);
    chatRunCleanupRef.current?.();
    chatRunCleanupRef.current = null;
  }, []);

  const answerChatClarification = useCallback(async (
    runId: string,
    callId: string,
    answers: Record<string, string[]> | null,
  ) => {
    const store = useChatStore.getState();
    const activeRun = store.activeRun;
    const thread = activeRun?.runId === runId
      ? store.threads.find((item) => item.id === activeRun.threadId)
      : undefined;
    const pending = thread?.messages
      .flatMap((message) => message.clarifications || [])
      .find((item) => item.callId === callId && item.status === 'awaiting_input');
    const currentAssistantId = activeRun?.messageId || '';
    const response: ChatAskResponseSummary | null = answers && pending ? {
      title: '补充几个信息',
      questions: pending.questions.map((question) => ({
        id: question.id,
        title: question.title,
        answers: (answers[question.id] || []).map((value) => (
          question.options.find((option) => option.value === value)?.label || value
        )),
      })),
    } : null;
    const userMessage = response ? {
      id: createId('msg'),
      role: 'user' as const,
      content: `已回答：${response.title}`,
      askResponse: response,
    } : undefined;
    const assistantMessage = response ? {
      id: createId('msg'),
      role: 'assistant' as const,
      content: '',
      status: 'running' as const,
    } : undefined;
    const accepted = await answerChatRun(runId, callId, answers, response ? {
      userMessage,
      assistantMessage,
    } : undefined);
    if (!accepted) showToast('这个问题已经失效，请重新发送消息');
    if (accepted && answers && activeRun && thread && userMessage && assistantMessage) {
      store.appendMessage(thread.id, userMessage);
      store.appendMessage(thread.id, assistantMessage);
      if (currentAssistantId) store.patchMessage(thread.id, currentAssistantId, { status: 'done' });
      store.setActiveRun({ ...activeRun, messageId: assistantMessage.id });
    }
    return accepted;
  }, [showToast]);

  /** 重试：拿这条助手消息前面最近的一条用户消息重发。 */
  const retryChatMessage = useCallback((messageId: string) => {
    const store = useChatStore.getState();
    const thread = store.threads.find((item) => item.id === store.activeThreadId);
    if (!thread) return;
    const index = thread.messages.findIndex((item) => item.id === messageId);
    if (index < 0) return;
    for (let i = index - 1; i >= 0; i -= 1) {
      const message = thread.messages[i];
      if (message.role === 'user') {
        const context = thread.messages[index]?.context;
        const baseVersionId = String(context?.baseVersionId || '').trim();
        const base = baseVersionId
          ? message.attachments?.find((ref) => ref.versionId === baseVersionId) || null
          : null;
        void startChatRunFlow(message.content, message.attachments || [], {
          base,
          previousVersionId: baseVersionId || undefined,
          previousCanvasId: base?.canvasId,
          modelSelection: message.modelSelection,
        });
        return;
      }
    }
  }, [startChatRunFlow]);

  /** 读取节点当前主图，所有引用入口都锁定到点击当下的版本。 */
  const chatRefForNode = useCallback((nodeId: string): ChatImageRef | null => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node || (node.data.kind !== 'image' && node.data.kind !== 'reference')) return null;
    const versions = normalizeVersions(node.data);
    const active = activeVersionOf({ ...node.data, versions });
    const url = String(active?.imageUrl || node.data.imageUrl || node.data.referenceDataUrl || '').trim();
    if (!url) return null;
    return {
      canvasId: activeId,
      nodeId,
      versionId: active?.id,
      url,
      title: String(node.data.label || active?.prompt || '画布图片'),
    };
  }, [activeId]);

  /** 画布节点单击共用的引用入口：仅在 AI 对话面板打开时由 onNodeClick 触发（不再主动开面板）。 */
  const referenceSelectedInChat = useCallback((nodeId: string) => {
    const ref = chatRefForNode(nodeId);
    if (!ref) {
      showToast('这张图还没有内容，没法引用');
      return;
    }
    const store = useChatStore.getState();
    store.addDraftAttachment(ref);
    showToast('已加到对话输入区，接着写描述就能发送');
  }, [chatRefForNode, showToast]);

  /** 对话定位（方案 §11）：切画布 → 切版本 → 居中 → 高亮一次；面板保持打开。 */
  const locateChatRef = useCallback((ref: { canvasId: string; nodeId: string; versionId?: string; force?: boolean }) => {
    const canvasId = ref.canvasId || activeId;
    const go = () => {
      let frames = 0;
      const focusWhenReady = () => {
        const node = nodesRef.current.find((item) => item.id === ref.nodeId);
        if (node) {
          if (ref.versionId) {
            const versions = normalizeVersions(node.data);
            const target = versions.find((item) => item.id === ref.versionId);
            // 版本级定位：把节点当前展示版本切成消息里那一版（静默，不弹 toast）
            if (target && String(node.data.activeVersionId || '') !== ref.versionId) {
              patchNode(ref.nodeId, { ...mirrorVersionPatch(target), versions });
            }
          }
          revealResultNode(ref.nodeId, { onlyIfOffscreen: ref.force ? false : true });
          markFreshResultNode(ref.nodeId);
          return;
        }
        if (frames++ < 90) window.requestAnimationFrame(focusWhenReady);
      };
      focusWhenReady();
    };
    if (canvasId === activeId) {
      go();
      return;
    }
    // 跨画布：先拉最新文档合并，切过去再聚焦（与 MCP locate 同套路）
    void (async () => {
      try {
        const remote = (await getCanvases()).find((doc) => doc.id === canvasId);
        if (!remote) {
          showToast('定位失败：本地还没有这张画布，刷新页面后再试');
          return;
        }
        if (!useCanvasStore.getState().canvases.some((doc) => doc.id === canvasId)) {
          useCanvasStore.getState().mergeCanvases([remote]);
        } else {
          mergeCanvasNodes(canvasId, remote.nodes as CanvasNode[]);
        }
        setActive(canvasId);
      } catch {
        showToast('定位失败：读不到画布文档');
        return;
      }
      window.requestAnimationFrame(() => window.requestAnimationFrame(go));
    })();
  }, [activeId, patchNode, revealResultNode, markFreshResultNode, mergeCanvasNodes, setActive, showToast]);
  locateChatRefRef.current = locateChatRef;

  // 对话线程跟随画布：切画布 = 切到该画布最近更新的线程
  useEffect(() => {
    useChatStore.getState().setActiveCanvas(activeId);
  }, [activeId]);

  // 刷新恢复：在途 run 重连补发缓冲事件；bridge 重启过则 3 秒内无事件 → 标记「运行状态未知」
  useEffect(() => {
    const run = useChatStore.getState().activeRun;
    if (!run) return undefined;
    let received = false;
    const cleanup = subscribeChatRunEvents(run.runId, (event) => {
      received = true;
      applyChatRunEvent(run.threadId, run.messageId, event, run.runId);
    });
    const timer = window.setTimeout(() => {
      if (received) return;
      useChatStore.getState().patchMessage(run.threadId, run.messageId, { status: 'unknown' });
      useChatStore.getState().setActiveRun(null);
    }, 3000);
    return () => {
      window.clearTimeout(timer);
      cleanup();
    };
  }, [applyChatRunEvent]);

  /* ── 生成主链路 ── */
  const runComposer = useCallback(async (nodeId: string, promptRaw: string, options: { previousVersionId?: string } = {}): Promise<ComposerRunResult> => {
    const prompt = promptRaw.trim();
    const composer = nodesRef.current.find((node) => node.id === nodeId);
    /**
     * 生成失败统一出口：错误写进节点 data，卡片发送按钮下方那排红灯直接把原因摊开
     * （toast 会自己消失，画布上大大小小的错误不该只有 3 秒可读）。
     * 同时把结果返回给调用方——对话面板要把失败原因写进那条消息。
     */
    const fail = (message: string): ComposerRunResult => {
      patchNode(nodeId, { status: 'error', error: message, stage: undefined, runningDirect: undefined });
      showToast(message);
      return { ok: false, error: message };
    };
    if (!composer || composer.data.kind !== 'composer') return { ok: false, error: '节点不存在或不是生成节点' };
    // 上游文案引用（连过来的文案节点）先算出来：输入框空着也允许发送，
    // 文案会以「参考：…」并进这次生成的提示词——文案节点连图像节点的常规用法。
    const referenceTexts = getGenerationReferenceTexts(nodeId, nodesRef.current, edgesRef.current);
    if (!prompt && referenceTexts.length === 0) {
      return fail('先写一句想生成的内容，或连一个文案节点');
    }
    // 发送前再从 bridge 取一次配置：旧标签页可能还留着恢复前的默认模型或失效 Key。
    await loadSettings();
    const settings = useSettingsStore.getState().settings;
    const profile = activeProfileOf(settings);
    if (!profile) {
      setSettingsOpen(true);
      return fail('没有可用的生图配置，请先在「生图设置」里添加并启用模型');
    }
    if (!profile.keyConfigured) {
      setSettingsOpen(true);
      return fail(`「${profile.name}」未配置 API Key，请在「生图设置」里填写并保存`);
    }
    if (!profile.model) {
      setSettingsOpen(true);
      return fail(`「${profile.name}」未选择生图模型，请在「生图设置」里选择模型并保存`);
    }

    // 参考图（图生图）：二次编辑的基准图排第一，后面跟着连到这个节点的 reference / image。
    // 一次可以带多张——生图接口的 /images/edits 收 image[]，模型能同时看几张再画。
    // 图片数组顺序 = chips 编号顺序（buildOrderedReferences 按画布位置排过）。
    // 二次编辑的基准图排在输入数组第一位，但不占用用户描述中的图号；外部参考图从图 1 开始。
    const referenceDataUrls: string[] = [];
    let hasEditingBase = false;
    const baseVersionId = String(composer.data.reditBaseVersionId || '');
    let baseVersion: CanvasNodeVersion | undefined;
    if (baseVersionId) {
      baseVersion = normalizeVersions(composer.data).find((item) => item.id === baseVersionId);
      const baseUrls = [...new Set([
        String(baseVersion?.imageUrl || '').trim(),
        String(composer.data.imageUrl || '').trim(),
      ].filter(Boolean))];
      let baseDataUrl = '';
      let baseReadError = baseUrls.length === 0 ? '版本记录里没有图片地址' : '';
      for (const url of baseUrls) {
        try {
          baseDataUrl = url.toLowerCase().startsWith('data:')
            ? await normalizeReferenceDataUrl(url)
            : await urlToDataUrl(url);
          if (baseDataUrl) break;
        } catch (error) {
          baseReadError = error instanceof Error ? error.message : '图片格式无法读取';
        }
      }
      if (!baseDataUrl) {
        return fail(`基准图读取失败，没法在这张图上二次编辑：${baseReadError}`);
      }
      referenceDataUrls.push(baseDataUrl);
      hasEditingBase = true;
    }
    // 必须走 buildOrderedReferences：data.references 只在连线变化时重算，手动拖 chip 换序后
    // 它是旧序，直接读会导致发给模型的图片顺序和 chips 上「图一 / 图二」编号对不上。
    const orderedReferences = buildOrderedReferences(nodeId, nodesRef.current, edgesRef.current);
    for (const reference of orderedReferences) {
      if (referenceDataUrls.length >= MAX_REFERENCE_IMAGES) break;
      if (reference.kind === 'text' || !String(reference.url || '').trim()) continue;
      const source = nodesRef.current.find((node) => node.id === reference.id);
      if (source?.data.status === 'running') {
        return fail('参考图还在生成中，稍等一下');
      }
      const dataUrl = reference.url.startsWith('data:')
        ? await normalizeReferenceDataUrl(reference.url).catch(() => '')
        : await urlToDataUrl(reference.url).catch(() => '');
      if (!dataUrl) continue;
      if (!referenceDataUrls.includes(dataUrl)) referenceDataUrls.push(dataUrl);
    }
    const referenceDataUrl = referenceDataUrls[0] || '';

    // 把基准图身份与外部图片编号写进提示词，确保直连生图模型和优化链路都能区分两者。
    const externalImageCount = referenceDataUrls.length - (hasEditingBase ? 1 : 0);
    const imageNumbering = buildReferenceNumberingInstruction(externalImageCount, hasEditingBase);
    const composedPrompt = [imageNumbering, prompt, ...referenceTexts.map((text) => `参考：${text}`)]
      .filter((part) => part.trim())
      .join('\n');
    // 空输入 + 上游文案时，合并后的这份才是这次真正发出去的提示词：
    // 存它而不是空串，历史面板、版本链、二次编辑回填才有东西可看
    const effectivePrompt = prompt || composedPrompt;

    // 画幅优先级（对齐灵枢）：提示词里写明 > 工具栏选的预设 > 设置里的默认尺寸
    // 「自动」档：提示词没写时按参考图比例推导，再不行退回 1:1
    const promptRatio = detectPromptRatio(prompt);
    const presetRaw = String(composer.data.ratio || '');
    const presetRatio = presetRaw === AUTO_RATIO
      ? resolveAutoRatio({ prompt, references: orderedReferences })
      : ratioToNumber(presetRaw);
    const ratio = promptRatio > 0 ? promptRatio : (presetRatio > 0 ? presetRatio : parseSizeRatio(profile.defaultSize));
    const size = pickSizeForResolution(ratio, String(composer.data.resolution || '1K'));
    const imageCount = clampImageCount(composer.data.imageCount);
    const createdAt = new Date().toISOString();

    // 节点工具栏单开关：关闭 = Image API；开启 = Responses API。
    // 继续复用旧 direct 字段存储，避免现有画布与设置迁移失效。
    const direct = resolveDirect(
      typeof composer.data.direct === 'boolean' ? composer.data.direct : undefined,
      settings?.direct,
    );
    // 智能生成仍然保留提示词优化，但生图出口尊重当前配置的 imageApiMode。
    // 兼容只支持 Image API 的中转站，避免智能开关把它强行送到 /responses。
    const apiMode = direct || profile.imageApiMode !== 'responses' ? 'images' : 'responses';
    const enhancePrompt = shouldEnhancePrompt(settings, direct);

    // 与灵枢一致：composer 就地转成运行态——动画、尺寸、计时都长在同一张卡片上
    patchNode(nodeId, {
      status: 'running',
      // 本次 API 模式固化进运行态：白 = Image API，紫 = Responses 智能生成。
      runningDirect: direct,
      stage: enhancePrompt ? 'enhance' : 'generate',
      label: direct ? '图片生成' : '智能生成',
      prompt: effectivePrompt,
      model: String(composer.data.model || profile.model),
      size,
      error: '',
      imageUrl: '',
      referenceDataUrl: '',
      fileName: '',
      enhancedPrompt: '',
      enhanceFailed: false,
      revisedPrompt: '',
      createdAt,
      finishedAt: '',
    });

    let usedPrompt = composedPrompt;
    let enhancedPrompt = '';
    let enhanceFailed = false;
    // 整理失败不阻断生成，但原因要留在卡片上（同一排红灯，生成中降一档不刺眼），
    // 用户才知道这一版为什么是原文直出
    let enhanceNote = '';
    let referenceUsage: 'style' | 'edit' | undefined;
    if (enhancePrompt) {
      const selectedTextProfile = pickTextProfile(settings);
      const fallbackTextProfiles = (settings?.profiles || [])
        .filter((item) => item.kind === 'text' && item.keyConfigured && item.model)
        .filter((item) => item.id !== selectedTextProfile?.id);
      const textProfiles = selectedTextProfile ? [selectedTextProfile, ...fallbackTextProfiles] : fallbackTextProfiles;
      if (textProfiles.length === 0) {
        enhanceFailed = true;
        enhanceNote = '提示词优化未配置完整，已按原文生图';
      } else {
        let lastEnhanceError = '未知错误';
        for (const textProfile of textProfiles) {
          try {
            const result = await enhancePromptApi({
              prompt: composedPrompt,
              size,
              referenceDataUrls,
              profileId: textProfile.id,
            });
            usedPrompt = result.prompt;
            enhancedPrompt = result.prompt;
            referenceUsage = result.usage;
            break;
          } catch (error) {
            lastEnhanceError = error instanceof Error ? error.message : '未知错误';
          }
        }
        if (!enhancedPrompt) {
          enhanceFailed = true;
          enhanceNote = `提示词优化失败，已按原文生图：${lastEnhanceError}`;
        }
      }
      if (enhanceNote) showToast(enhanceNote);
      patchNode(nodeId, { stage: 'generate', enhancedPrompt, enhanceFailed, error: enhanceNote });
    }

    // Responses 多轮上下文只复用同一路配置生成的版本，避免把另一路中转站的 response id 误发出去。
    const selectedProfileId = String(composer.data.profileId || profile.id);
    const generationProfile = settings?.profiles.find((item) => item.id === selectedProfileId) || profile;
    // 对话上下文链：上一轮生成结果（可能在别的节点上，由对话消息指过来）的 responseId。
    // 与 redit 同口径：只续同一路配置、同一 Responses 主模型的版本，否则断链并在消息上讲清原因。
    const chatPrevious = options.previousVersionId
      ? findVersionOnCanvas(nodesRef.current, options.previousVersionId)
      : undefined;
    const chainBase = chatPrevious || baseVersion;
    const previousResponseId = chainBase?.responseId
      && apiMode === 'responses'
      && chainBase.responseProfileId === generationProfile.id
      && chainBase.responseModel === generationProfile.responsesModel
      ? chainBase.responseId
      : undefined;
    // 对话消息里的上下文徽标：链上了写 baseVersionId + responseId，断了写原因
    let chainContext: ChatMessageContext | undefined;
    if (chatPrevious) {
      chainContext = previousResponseId
        ? { baseVersionId: chatPrevious.id, responseId: previousResponseId, referenceCount: referenceDataUrls.length }
        : { baseVersionId: chatPrevious.id, referenceCount: referenceDataUrls.length, resetReason: '模型配置或接口模式变了，上下文从这里重新开始' };
    } else if (options.previousVersionId) {
      chainContext = { referenceCount: referenceDataUrls.length, resetReason: '上一轮的结果已不在画布上，上下文从这里重新开始' };
    }

    // 阶段二：生图模型出图
    const outcome = await generate({
      prompt: usedPrompt,
      apiMode,
      originalPrompt: composedPrompt,
      model: String(composer.data.model || profile.model),
      size,
      referenceDataUrl: referenceDataUrl || undefined,
      referenceDataUrls,
      n: imageCount,
      canvasId: activeId,
      nodeId,
      profileId: String(composer.data.profileId || profile.id),
      previousResponseId,
      previousImageGenerationCallId: chainBase?.imageGenerationCallId,
      referenceUsage,
    });

    if (!outcome.ok) {
      return fail(outcome.error);
    }
    const generated = outcome.images.slice(0, 8);
    const first = generated[0];
    if (!first) {
      return fail('接口未返回图片');
    }
    const model = String(composer.data.model || profile.model);
    const finishedAt = new Date().toISOString();
    // 一次多张时每张各成一个版本：数据上就是普通版本链，首张作主图，
    // 版本宫格 / 历史面板的展示与二次编辑全部复用现成机制
    const createdVersions: CanvasNodeVersion[] = [];
    for (const image of generated) {
      const natural = await imageNaturalSize(image.url);
      createdVersions.push({
        id: createId('ver'),
        imageUrl: image.url,
        fileName: image.fileName,
        prompt: effectivePrompt,
        model,
        size,
        width: natural.width || undefined,
        height: natural.height || undefined,
        createdAt,
        finishedAt,
        enhancedPrompt,
        revisedPrompt: String(image.revisedPrompt || ''),
        // 版本链记录「基于哪一版」：二次编辑的基准，或对话里续接的上一轮结果
        baseVersionId: (chatPrevious?.id || baseVersionId) || undefined,
        responseId: image.responseId,
        imageGenerationCallId: image.imageGenerationCallId,
        responseModel: image.responseModel,
        responseProfileId: image.responseId ? generationProfile.id : undefined,
      });
    }
    const version = createdVersions[0];
    // 出图落在同一节点：卡片形状跟着真实位图比例走
    patchNode(nodeId, {
      kind: 'image',
      status: 'done',
      // 出图即清错：上一轮的整理失败提示不能粘在成功卡片上
      error: '',
      runningDirect: undefined,
      versions: [...normalizeVersions(composer.data), ...createdVersions],
      activeVersionId: version.id,
      reditBaseVersionId: undefined,
      composerEditing: undefined,
      imageUrl: first.url,
      fileName: first.fileName,
      size,
      model,
      width: version.width,
      height: version.height,
      stage: undefined,
      enhancedPrompt,
      enhanceFailed,
      revisedPrompt: String(first.revisedPrompt || ''),
      responseId: first.responseId,
      imageGenerationCallId: first.imageGenerationCallId,
      responseModel: first.responseModel,
      responseProfileId: first.responseId ? generationProfile.id : undefined,
      finishedAt,
    });
    // 手动生成不挪镜头：结果就落在用户正看着的那张卡片上，平移反而打断他。
    // 出图后的定位只留给 MCP 路径（生成结束由 bridge 发 locate 事件，见下面订阅）。
    markFreshResultNode(nodeId);
    return {
      ok: true,
      versionIds: createdVersions.map((item) => item.id),
      context: chainContext,
    };
  }, [activeId, loadSettings, markFreshResultNode, patchNode, showToast]);

  runComposerRef.current = runComposer;

  /* ── 事件桥 ── */
  useEffect(() => onEvent<NodePromptDetail>(NODE_EVENTS.prompt, ({ nodeId, prompt }) => {
    patchNode(nodeId, { prompt });
  }), [updateNode]);

  useEffect(() => onEvent<NodeRunDetail>(NODE_EVENTS.run, ({ nodeId, prompt }) => {
    void runComposer(nodeId, prompt);
  }), [runComposer]);

  // 参考图 chips 拖拽换序：组件侧乐观重排完把 order 抛过来，这里落库。
  // buildOrderedReferences 认识这份顺序， chips 编号与发送给模型的图片数组都会跟着变
  useEffect(() => onEvent<NodeReferenceReorderDetail>(NODE_EVENTS.referenceReorder, ({ nodeId, order }) => {
    const ids = (Array.isArray(order) ? order : []).map((id) => String(id)).filter(Boolean);
    if (!nodeId || ids.length === 0) return;
    // references 同步重排：工具栏等不经 flowNodes 的渲染路径读的是 data.references，
    // 只改 referenceOrder 会让它们停在旧序（卡片 chips 已换、工具栏没换）。
    // 排序口径与组件侧 orderedReferences 完全一致：榜外引用保持相对次序垫末位。
    const target = nodesRef.current.find((item) => item.id === nodeId);
    const current = Array.isArray(target?.data.references) ? target!.data.references : [];
    const rank = new Map(ids.map((key, index) => [key, index] as [string, number]));
    const nextReferences = current
      .map((reference, index) => ({ reference, index }))
      .sort((left, right) => {
        const leftRank = rank.get(String(left.reference.id || left.reference.url || ''));
        const rightRank = rank.get(String(right.reference.id || right.reference.url || ''));
        if (leftRank === undefined && rightRank === undefined) return left.index - right.index;
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        return leftRank - rightRank;
      })
      .map((item) => item.reference);
    patchNode(nodeId, { referenceOrder: ids, references: nextReferences });
  }), [patchNode]);

  useEffect(() => onEvent<NodeFocusDetail>(NODE_EVENTS.focus, ({ nodeId }) => focusNode(nodeId)), [focusNode]);

  // 版本宫格摊开：把整片宫格收进视口（不然高缩放下会溢出去）。
  // 两条坑都绕开：① rf.fitView 按 node.measured 算边界，而展开是 class 触发的宽高变化，
  // ResizeObserver 还没回填 measured，fit 出来的是旧盒子，倍率被 maxZoom 夹回原值——表现就是
  // 「点展开没反应」；② 展开态的宫格是溢出节点盒子的（节点盒只有一行高），直接量节点盒子
  // 会漏掉下面几行。所以这里量每张卡的布局位置（offsetLeft/Top 不吃动画 transform）求并集，
  // 自己算中心点。倍率规则：固定 80%——用户实测口径，不足 80% 抬到 80%，
  // 超过（如 fit 出来的 100%）也不上去。
  useEffect(() => onEvent<NodeVersionsFitDetail>(NODE_EVENTS.versionsFit, ({ nodeId }) => {
    if (!nodeId) return;
    /** 卡片可能还没随那次 commit 上屏：跟几帧，最多 200ms，量不到再按节点盒子兜底 */
    const fitWithRetry = (attempt: number) => {
      window.requestAnimationFrame(() => {
        const nodeEl = document.querySelector(`.react-flow__node[data-id="${nodeId}"]`) as HTMLElement | null;
        const paneEl = nodeEl?.closest('.react-flow') as HTMLElement | null;
        const cards = nodeEl ? Array.from(nodeEl.querySelectorAll<HTMLElement>('.image-node-version')) : [];
        if ((!nodeEl || !paneEl || cards.length === 0) && attempt < 12) {
          fitWithRetry(attempt + 1);
          return;
        }
        if (!nodeEl || !paneEl) return;
        const paneRect = paneEl.getBoundingClientRect();
        if (paneRect.width < 1 || paneRect.height < 1) return;

        // 并集从节点盒子起算，再把每张宫格卡按「布局位置 × 祖先链缩放」加进来。
        // offsetParent 的 rect/offset 比值 = 当前画布倍率 ×（选中态 scale 之类的祖先变换），
        // 用它把布局像素折算成屏幕像素，动画飞行中量也是终局位置。
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const grow = (x: number, y: number, w: number, h: number) => {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
        };
        const nodeRect = nodeEl.getBoundingClientRect();
        grow(nodeRect.left, nodeRect.top, nodeRect.width, nodeRect.height);
        for (const card of cards) {
          const host = card.offsetParent as HTMLElement | null;
          if (!host || card.offsetWidth < 1) continue;
          const hostRect = host.getBoundingClientRect();
          const scaleX = hostRect.width / host.offsetWidth || 1;
          const scaleY = hostRect.height / host.offsetHeight || 1;
          grow(
            hostRect.left + card.offsetLeft * scaleX,
            hostRect.top + card.offsetTop * scaleY,
            card.offsetWidth * scaleX,
            card.offsetHeight * scaleY,
          );
        }
        const unionWidth = maxX - minX;
        const unionHeight = maxY - minY;
        if (unionWidth < 1 || unionHeight < 1) return;

        // 倍率固定 80%：以前按留白 fit 常算出 100%，点展开反而放大；按用户口径只取 80% 一档
        const nextZoom = VERSION_FIT_MIN_ZOOM;
        const center = rf.screenToFlowPosition({
          x: minX + unionWidth / 2,
          y: minY + unionHeight / 2,
        });
        void rf.setCenter(center.x, center.y, { zoom: nextZoom, duration: 320 });
      });
    };
    fitWithRetry(0);
  }), [rf]);

  /* ── 点图开灯箱：替代 window.open，in-app 浏览器里才不会白屏 ── */
  useEffect(() => onEvent<NodePreviewDetail>(NODE_EVENTS.preview, ({ nodeId, version }) => {
    const node = nodesRef.current.find((item) => item.id === nodeId);
    if (!node) return;
    const url = String(version?.imageUrl || node.data.imageUrl || node.data.referenceDataUrl || '').trim();
    if (!url) return;
    // 宫格里双击某一版：信息按那一版走，灯箱才知道这是第几版的提示词
    ensureHistoryForPreview();
    setPreviewItem({
      url,
      title: String(version?.prompt || node.data.prompt || node.data.label || '图片预览'),
      details: {
        prompt: String(version?.prompt || node.data.prompt || ''),
        enhancedPrompt: String(version?.enhancedPrompt || node.data.enhancedPrompt || ''),
        enhanceFailed: node.data.enhanceFailed === true,
        revisedPrompt: String(version?.revisedPrompt || node.data.revisedPrompt || ''),
        model: String(version?.model || node.data.model || ''),
        size: String(version?.size || node.data.size || ''),
        startedAt: String(version?.createdAt || node.data.createdAt || ''),
        createdAt: String(version?.finishedAt || node.data.finishedAt || ''),
        fileName: String(version?.fileName || node.data.fileName || ''),
      },
    });
  }), []);

  /**
   * 历史面板「定位」：切到该图所在画布 → 选中节点 → 摊开它的版本宫格。
   * 二次编辑的谱系在画布上才看得全（哪一版由哪一版来、共几版）。
   */
  const locateHistoryItem = useCallback((item: HistoryItem) => {
    const nodeId = String(item.nodeId || '');
    if (!nodeId) {
      showToast('这张图还没有对应的节点');
      return;
    }
    const reveal = () => {
      setSelectedId(nodeId);
      setEditingNodeId('');
      emitEvent<NodeVersionsExpandDetail>(NODE_EVENTS.versionsExpand, { nodeId });
      focusNode(nodeId);
    };
    const store = useCanvasStore.getState();
    if (item.canvasId && item.canvasId !== store.activeId) {
      store.setActive(item.canvasId);
      showToast(`已切换到「${item.canvasName}」`);
      // 换画布会重新 hydrate 节点，等一帧再定位，否则节点还没上屏
      window.setTimeout(reveal, 260);
      return;
    }
    reveal();
  }, [focusNode, showToast]);

  /* ── 上传参考图：composer 脚上的「+」挂新图；参考图节点上的按钮替换原图 ── */
  useEffect(() => onEvent<NodeReditDetail>(NODE_EVENTS.redit, ({ nodeId }) => startRedit(nodeId)), [startRedit]);

  useEffect(() => onEvent<NodeReditCancelDetail>(NODE_EVENTS.reditCancel, ({ nodeId }) => cancelRedit(nodeId)), [cancelRedit]);

  useEffect(() => onEvent<NodeVersionSetMainDetail>(NODE_EVENTS.versionSetMain, ({ nodeId, versionId }) => {
    setVersionMain(nodeId, versionId);
  }), [setVersionMain]);

  useEffect(() => onEvent<NodeUploadDetail>(NODE_EVENTS.upload, ({ nodeId, reference }) => {
    const target = nodesRef.current.find((item) => item.id === nodeId);
    if (!target) return;
    if (reference) {
      pendingConnectionRef.current = { sourceId: nodeId, handleType: 'target' };
    } else {
      replaceTargetRef.current = nodeId;
    }
    composerFileInputRef.current?.click();
  }), []);

  /** 就地替换参考图：dataURL / 自然尺寸 / 卡片宽度一起更新，比例跟着新图走。 */
  const replaceReference = useCallback(async (nodeId: string, file: File) => {
    if (!file.type.startsWith('image/')) {
      showToast('只支持图片文件');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    const size = await imageNaturalSize(dataUrl);
    let imageUrl = '';
    try {
      imageUrl = (await saveImageDataUrl(dataUrl)).url;
    } catch {
      showToast('本机 Bridge 未连接，图片暂时只保存在当前浏览器');
    }
    const target = nodesRef.current.find((item) => item.id === nodeId);
    const persistedUrl = imageUrl || dataUrl;
    // 结果图节点替换后还是结果图，参考图节点也优先走 /api/files 引用
    const isResultNode = target?.data.kind !== 'reference';
    patchNode(nodeId, {
      imageUrl: persistedUrl,
      referenceDataUrl: '',
      label: file.name.replace(/\.[^.]+$/, '') || (isResultNode ? '图片' : '参考图'),
      width: size.width,
      height: size.height,
      cardWidth: Math.min(420, Math.max(220, size.width || 300)),
      fileName: isResultNode ? '' : target?.data.fileName,
      status: 'done',
      error: '',
    });
  }, [patchNode, showToast]);

  useEffect(() => onEvent<NodeReferenceRemoveDetail>(NODE_EVENTS.referenceRemove, ({ nodeId, url, referenceId }) => {
    // 引用 chip 与上游节点同生共死：referenceId 就是上游节点 id，删 chip 即删边不删节点
    const refId = String(referenceId || '');
    const source = refId
      ? nodesRef.current.find((node) => node.id === refId)
      : undefined;
    const legacySource = nodesRef.current.find((node) => String(node.data.referenceDataUrl || node.data.imageUrl || '') === url);
    const match = source || (legacySource?.id === 'self' ? undefined : legacySource);
    const next = edgesRef.current.filter((edge) => !(edge.target === nodeId && (!match || edge.source === match.id)));
    setEdgesBoth(next);
    syncComposerReferences(next);
  }), [syncComposerReferences]);

  /* ── 手柄「+」→ 可连接节点菜单（灵枢同款，替代"只能盲拖"的连接方式）── */
  useEffect(() => onEvent<NodeConnectDetail>(NODE_EVENTS.connect, ({ nodeId, clientX, clientY, direction }) => {
    const rect = document.querySelector('.hb-canvas-wrap')?.getBoundingClientRect();
    const rawX = rect ? clientX - rect.left : clientX;
    const rawY = rect ? clientY - rect.top : clientY;
    const x = Math.max(8, rawX - 130);
    const y = Math.max(8, rawY + 18);
    const menuPoint = menuClientPoint(rect || null, { x, y });
    setNodeConnectionMenu({
      sourceId: nodeId,
      direction,
      x,
      y,
      clientX: menuPoint.x,
      clientY: menuPoint.y,
      connection: null,
    });
    setAddMenu(null);
    pendingConnectionRef.current = null;
  }), []);

  /* ── Codex 推图 ──
     MCP 出的图照样实时落到画布上，但**不自动挪用户的视口**：生成完要不要「带到用户眼前」
     由 agent 显式调 huiban_locate 决定，否则用户正看着别处，图一出来就被拽走。 */
  useEffect(() => {
    if (!activeId) return undefined;
    return subscribePushedImages(activeId, (event) => {
      const existing = event.nodeId ? nodesRef.current.find((node) => node.id === event.nodeId) : undefined;
      if (existing) {
        // 已存在的节点：本页发起的那次生成（composer 还在等图），图到了就地变成结果
        if (existing.data.status !== 'done') {
          patchNode(existing.id, {
            kind: existing.data.kind === 'composer' ? 'image' : existing.data.kind,
            status: 'done',
            imageUrl: event.url,
            fileName: event.fileName,
            size: event.size || existing.data.size,
            model: event.model || existing.data.model,
            enhancedPrompt: event.usedPrompt && event.usedPrompt !== event.prompt ? event.usedPrompt : '',
            revisedPrompt: String(event.revisedPrompt || ''),
            responseId: event.responseId,
            imageGenerationCallId: event.imageGenerationCallId,
            responseModel: event.responseModel,
            responseProfileId: event.responseProfileId,
            finishedAt: new Date().toISOString(),
          });
          markFreshResultNode(existing.id);
        }
        return;
      }
      const id = event.nodeId || createId('image');
      appendNode({
        id,
        type: 'flow-image',
        position: { ...cursor },
        data: {
          kind: 'image',
          label: 'Codex 生成',
          cardWidth: 320,
          prompt: event.prompt,
          enhancedPrompt: event.usedPrompt && event.usedPrompt !== event.prompt ? event.usedPrompt : '',
          revisedPrompt: String(event.revisedPrompt || ''),
          responseId: event.responseId,
          imageGenerationCallId: event.imageGenerationCallId,
          responseModel: event.responseModel,
          responseProfileId: event.responseProfileId,
          status: 'done',
          imageUrl: event.url,
          fileName: event.fileName,
          size: event.size,
          model: event.model,
          // 对话 agent 推来的图保留 source=chat：PUT 快照保护与自动定位都认它
          source: event.source === 'chat' ? 'chat' : 'mcp',
          createdAt: new Date().toISOString(),
        },
      } as FlowNode);
      advanceCursor(0, 380);
      markFreshResultNode(id);
    });
  }, [activeId, advanceCursor, appendNode, cursor, markFreshResultNode, patchNode, revealResultNode]);

  /* ── 局域网其他页面写入同一画布：拉最新文档合并并刷新视图，看到对方的上传与编辑 ── */
  useEffect(() => {
    if (!activeId) return undefined;
    return subscribeCanvasUpdated(activeId, (event) => {
      if (nodeInteractionRef.current || nodePositionProtectionRef.current.size > 0) {
        remoteUpdatePendingRef.current = true;
        return;
      }
      void (async () => {
        const local = useCanvasStore.getState().canvases.find((doc) => doc.id === activeId);
        if (Date.parse(event.updatedAt) <= Date.parse(local?.updatedAt || '')) return;
        try {
          const remote = await getCanvases();
          if (nodeInteractionRef.current) {
            remoteUpdatePendingRef.current = true;
            return;
          }
          const previous = useCanvasStore.getState().canvases.find((doc) => doc.id === activeId);
          useCanvasStore.getState().mergeCanvases(remote);
          const merged = useCanvasStore.getState().canvases.find((doc) => doc.id === activeId);
          if (merged && merged !== previous && !nodeInteractionRef.current) {
            hydrateActiveCanvas({ interruptRunning: false, preserveSelection: true });
          }
        } catch {
          /* 单次拉取失败不打断本地使用，下一次写入事件再合并 */
        }
      })();
    });
  }, [activeId, hydrateActiveCanvas]);

  const refreshAfterNodeInteraction = useCallback((force = false) => {
    if ((!remoteUpdatePendingRef.current && !force) || !activeId) {
      nodeInteractionRef.current = false;
      return;
    }
    remoteUpdatePendingRef.current = false;
    const canvasId = activeId;
    const revision = interactionRevisionRef.current;
    const preservePositions = new Map(nodePositionProtectionRef.current);
    window.setTimeout(() => {
      if (useCanvasStore.getState().activeId !== canvasId) {
        if (revision === interactionRevisionRef.current) {
          nodePositionProtectionRef.current.clear();
          nodeInteractionRef.current = false;
        }
        return;
      }
      const previous = useCanvasStore.getState().canvases.find((doc) => doc.id === canvasId);
      void getCanvases().then((remote) => {
        if (revision !== interactionRevisionRef.current || (!force && nodeInteractionRef.current)) {
          remoteUpdatePendingRef.current = true;
          return;
        }
        const protectedRemote = remote.map((doc) => {
          if (doc.id !== canvasId || preservePositions.size === 0) return doc;
          return {
            ...doc,
            nodes: doc.nodes.map((node) => {
              const position = preservePositions.get(node.id);
              return position ? { ...node, position } : node;
            }),
          };
        });
        useCanvasStore.getState().mergeCanvases(protectedRemote);
        const merged = useCanvasStore.getState().canvases.find((doc) => doc.id === canvasId);
        if (merged && (force || merged !== previous) && (force || !nodeInteractionRef.current)) {
          hydrateActiveCanvas({
            interruptRunning: false,
            preserveSelection: true,
            preservePositions,
          });
        }
        if (revision === interactionRevisionRef.current) {
          nodePositionProtectionRef.current.clear();
          nodeInteractionRef.current = false;
        }
      }).catch(() => {
        if (revision === interactionRevisionRef.current) {
          nodePositionProtectionRef.current.clear();
          nodeInteractionRef.current = false;
        }
      });
    }, 800);
  }, [activeId, hydrateActiveCanvas]);

  const deferRemoteDuringNodeInteraction = useCallback(() => {
    nodeInteractionRef.current = true;
    window.clearTimeout(interactionReleaseTimerRef.current);
    interactionReleaseTimerRef.current = window.setTimeout(() => {
      nodeInteractionRef.current = false;
      refreshAfterNodeInteraction();
    }, 400);
  }, [refreshAfterNodeInteraction]);

  /* ── MCP 定位：agent 调 huiban_locate / 生成后自动定位，把用户带到那个节点跟前 ── */
  useEffect(() => subscribeCanvasLocate((request) => {
    const targetId = String(request.nodeId || '');
    const targetCanvas = String(request.canvasId || '');
    if (!targetId) return;
    // 节点可能是刚合进来的，还没渲染：跟几帧，最多约 1.5s。
    // 显式调 huiban_locate 一律归位；生成后的自动定位（onlyIfOffscreen）复用手动生成的礼貌规则
    const focusWhenReady = () => {
      let frames = 0;
      const step = () => {
        if (nodesRef.current.some((node) => node.id === targetId)) {
          revealResultNode(targetId, { onlyIfOffscreen: request.onlyIfOffscreen !== false });
          return;
        }
        if (frames++ < 90) window.requestAnimationFrame(step);
      };
      step();
    };
    if (!targetCanvas || targetCanvas === activeId) {
      focusWhenReady();
      return;
    }
    // 跨画布：先把目标画布的最新文档拉回来（MCP 写的节点本地可能还没有），
    // 只按 id 补缺——不整份替换，本地还没上桥的改动不会被冲掉
    void (async () => {
      try {
        const remote = (await getCanvases()).find((doc) => doc.id === targetCanvas);
        if (!remote) {
          showToast('定位失败：本地还没有这张画布，刷新页面后再试');
          return;
        }
        if (!useCanvasStore.getState().canvases.some((doc) => doc.id === targetCanvas)) {
          useCanvasStore.getState().mergeCanvases([remote]);
        } else {
          mergeCanvasNodes(targetCanvas, remote.nodes as CanvasNode[]);
        }
        setActive(targetCanvas);
      } catch {
        showToast('定位失败：读不到画布文档');
        return;
      }
      // 切画布的 hydrate 是 useEffect，等两帧节点上屏再聚焦
      window.requestAnimationFrame(() => window.requestAnimationFrame(focusWhenReady));
    })();
  }), [activeId, revealResultNode, mergeCanvasNodes, setActive, showToast]);

  /* ── 节点复制 / 粘贴：Ctrl+C / Ctrl+V，剪贴板跨画布有效 ── */
  const copySelectedNodes = useCallback(() => {
    // 页面上有文本选中时不抢：那是复制文字，不是复制节点
    if (window.getSelection()?.toString()) return;
    const picked = nodesRef.current.filter((node) => node.selected);
    const source = picked.length > 0
      ? picked
      : (selectedId ? nodesRef.current.filter((node) => node.id === selectedId) : []);
    if (source.length === 0) return;
    const ids = new Set(source.map((node) => node.id));
    nodeClipboard = {
      canvasId: activeId,
      nodes: JSON.parse(JSON.stringify(source)) as FlowNode[],
      edges: edgesRef.current
        .filter((edge) => ids.has(String(edge.source)) && ids.has(String(edge.target)))
        .map((edge) => ({ id: edge.id, source: String(edge.source), target: String(edge.target) })),
      pastes: 0,
    };
    showToast(source.length === 1
      ? '已复制节点，Ctrl+V 粘贴（可切换到其他画布）'
      : `已复制 ${source.length} 个节点，Ctrl+V 粘贴（可切换到其他画布）`);
  }, [activeId, selectedId, showToast]);

  const pasteNodes = useCallback(async () => {
    const clip = nodeClipboard;
    if (!clip || clip.nodes.length === 0) return;
    // 确认真要粘节点了才置 guard：剪贴板是空的时候不能拦浏览器紧接着补发的
    // paste 事件——那一下往往是用户粘图片，被误拦就等于「画布不能粘贴图片」
    nodePasteGuardRef.current = performance.now();
    clip.pastes += 1;
    // 落点：同画布复制 = 原位错开一截（原地复制的手感）；跨画布 = 整组中心对到当前视口中心
    let dx = 48;
    let dy = 48;
    if (clip.canvasId !== activeId) {
      const center = insertPosition();
      const box = clip.nodes.reduce((acc, node) => {
        const size = nodeBoxFor(node.data);
        const width = size ? size.width : Number(node.width || 0);
        const height = size ? size.height : Number(node.height || 0);
        return {
          minX: Math.min(acc.minX, node.position.x),
          minY: Math.min(acc.minY, node.position.y),
          maxX: Math.max(acc.maxX, node.position.x + width),
          maxY: Math.max(acc.maxY, node.position.y + height),
        };
      }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      dx = center.x - (box.minX + box.maxX) / 2;
      dy = center.y - (box.minY + box.maxY) / 2;
    }
    // 连续粘贴再整体错开一截：全叠在一起分不清谁是谁（六次一循环，不会飘到天边）
    const cascade = ((clip.pastes - 1) % 6) * 36;
    dx += cascade;
    dy += cascade;
    // 先给全部节点发新 id：referenceOrder 里存的是旧节点 id，要按新 id 重映射，
    // 一轮边发 id 边重映射会漏掉排在后面的上游节点
    const idMap = new Map<string, string>();
    clip.nodes.forEach((node) => idMap.set(node.id, createId(String(node.data.kind || 'composer'))));
    const clones: FlowNode[] = clip.nodes.map((node, index) => {
      const data = JSON.parse(JSON.stringify(node.data)) as CanvasNodeData;
      // 运行态不跟节点走：复制一个「正在生成」的节点不该永远转圈
      if (data.status === 'running') data.status = 'idle';
      delete data.stage;
      delete data.runningDirect;
      // 编辑态是组件 state 的镜像，节点级字段不带去；手动引用顺序按新 id 重映射
      delete data.composerEditing;
      if (Array.isArray(data.referenceOrder)) {
        data.referenceOrder = data.referenceOrder.map((item) => {
          const mapped = idMap.get(String(item));
          return mapped || String(item);
        });
      }
      return {
        ...node,
        id: idMap.get(node.id) as string,
        position: { x: node.position.x + dx, y: node.position.y + dy },
        data,
        selected: index === 0,
        className: '',
      };
    });
    // 媒体副本：/api/files 引用逐个在 bridge 侧复制一份再改写过去，副本与原件各占一个文件。
    // 从前共享同一路径，删任一副本都会把另一个节点的图弄没（用户实测）
    const wanted = new Set<string>();
    clones.forEach((node) => collectMediaUrls(node.data).forEach((url) => wanted.add(url)));
    const remap = new Map<string, string>();
    await Promise.all([...wanted].map(async (url) => {
      try {
        const response = await fetch('/api/files/copy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: url.slice('/api/files/'.length) }),
        });
        const body = await response.json() as { code?: number; data?: { url?: string } };
        if (body?.code === 0 && body.data?.url) remap.set(url, String(body.data.url));
      } catch {
        // 复制失败就沿用原引用：图至少还在，只是仍与原件共享
      }
    }));
    clones.forEach((node) => applyMediaRemap(node.data, remap));
    // persist 抑制位可能还挂着上一轮拖拽 / 选择的 true，先摘掉再写（整理布局同款教训）
    suppressPersistRef.current = false;
    clones.forEach((node) => appendNode(node));
    const nextEdges: Edge[] = clip.edges.map((edge) => ({
      id: createId('edge'),
      source: idMap.get(edge.source) || edge.source,
      target: idMap.get(edge.target) || edge.target,
    }));
    if (nextEdges.length > 0) setEdgesBoth([...edgesRef.current, ...nextEdges]);
    // 边没跟过来的（只复制了部分节点）：上游引用要归零，别把旧 id 的引用带去新画布
    syncComposerReferences(edgesRef.current);
    // 进撤回栈：Ctrl+Z 整组撤掉；复制出来的媒体文件记在这，撤回时只清没人再引的
    editUndoRef.current.push({
      kind: 'paste',
      nodeIds: clones.map((node) => node.id),
      edgeIds: nextEdges.map((edge) => edge.id),
      copiedUrls: [...remap.values()],
    });
    showToast(clones.length === 1 ? '已粘贴节点' : `已粘贴 ${clones.length} 个节点`);
  }, [activeId, appendNode, insertPosition, setEdgesBoth, showToast, syncComposerReferences]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'v') return;
      // 输入态里是浏览器自己的复制粘贴（composer 输入框 / 弹窗表单 / 标注文字浮层都算）
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // 标注器 / 设置弹窗 / 大图灯箱开着时不碰画布节点：那几层有自己的交互
      if (annotateNodeId || settingsOpen || previewItem) return;
      if (key === 'c') {
        copySelectedNodes();
        return;
      }
      // guard 时间戳在 pasteNodes 里置（确认剪贴板有节点才置）：这里无条件置过，
      // 空剪贴板时会把浏览器紧接着补发的图片 paste 事件整轮拦掉
      void pasteNodes();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotateNodeId, copySelectedNodes, pasteNodes, previewItem, settingsOpen]);

  /* ── 粘贴图片：文件、网页复制的 <img>、图片链接三条路都走参考图节点 ── */
  useEffect(() => {
    /** 粘贴落点：贴着当前选中的生成节点左侧（上游参考图该待的位置）走流坐标再转屏幕。
     *  以前一律拍在视口中心：卡片被压住时手柄吃不到指针，用户看到的就是「线连不上」；
        而节点落在生成节点右侧时，线要从参考图左侧绕回生成节点左侧，整条弧线横穿卡片——
        就是「线不在右侧、跑到节点里面」。没选中生成节点时才退回视口中心。 */
    const pastePoint = (): { x: number; y: number } | undefined => {
      const composer = nodesRef.current.find(
        (node) => node.id === selectedId
          && node.data.kind === 'composer'
          && !String(node.data.imageUrl || '').trim(),
      );
      if (!composer) return undefined;
      const screen = rf.flowToScreenPosition({
        x: composer.position.x - Number(composer.data.cardWidth || DEFAULT_COMPOSER_NODE_WIDTH) - 96,
        y: composer.position.y + 24,
      });
      return { x: screen.x, y: screen.y };
    };
    const onPaste = (event: ClipboardEvent) => {
      // 刚用 Ctrl+V 粘过节点（时间戳热乎着）：同一轮补发的 paste 事件直接跳过，
      // 不然节点粘贴和图片粘贴会为一次按键各出一份结果
      if (performance.now() - nodePasteGuardRef.current < 800) return;
      const files = event.clipboardData?.files ? Array.from(event.clipboardData.files).filter((item) => item.type.startsWith('image/')) : [];
      for (const item of Array.from(event.clipboardData?.items || [])) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const itemFile = item.getAsFile();
        if (itemFile && !files.some((file) => file === itemFile)) files.push(itemFile);
      }
      if (files.length > 0) {
        void Promise.all(files.map((item, index) => addReferenceFile(item as unknown as File, (() => {
          const point = pastePoint();
          return point ? { x: point.x + index * 28, y: point.y + index * 28 } : undefined;
        })())));
        return;
      }
      const items = event.clipboardData?.items;
      // 网页拷贝的图像（text/html 里的 <img>）或图片链接：getAsString 是异步的
      let handled = false;
      for (const item of Array.from(items || [])) {
        if (item.kind !== 'string') continue;
        if (item.type !== 'text/html' && item.type !== 'text/uri-list' && item.type !== 'text/plain') continue;
        handled = true;
        item.getAsString((text) => {
          const imgSrc = /<img[^>]+src=["']([^"']+)["']/i.exec(text || '');
          void addReferenceFromUrl(imgSrc ? imgSrc[1] : text || '', pastePoint());
        });
      }
      if (handled) return;
      // 输入态里的粘贴归浏览器（打字 / 弹窗表单 / 标注文字浮层），画布不接也不该吭声
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      showToast('画布上只支持粘贴图片：截图、图片文件、拷贝的图像或图片链接');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addReferenceFile, addReferenceFromUrl, selectedId, rf, showToast]);

  /* ── Esc 关闭添加菜单 ── */
  useEffect(() => {
    if (!addMenu) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAddMenu(null);
        setNodeConnectionMenu(null);
        if (historyOpen && !historyClosing) setHistoryClosing(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addMenu]);

  /* ── 拖拽进画布：图片文件，或从别处拖来的图片链接 ── */
  useEffect(() => {
    const hasImage = (event: DragEvent) => {
      const types = Array.from(event.dataTransfer?.types || []);
      // 节点里参考图 chip 的拖拽换序：自定义暗号在，就不是外来图片，整层不接
      if (types.includes('application/x-huiban-reference')) return false;
      return types.includes('Files') || types.includes('text/uri-list');
    };
    const onDragEnter = (event: DragEvent) => {
      if (!hasImage(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      setFileDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasImage(event)) return;
      // 不阻止默认行为的话，浏览器会直接导航打开图片文件/链接
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasImage(event)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setFileDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasImage(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setFileDragging(false);
      // 设置弹窗打开时只吞事件，不建节点
      if (settingsOpen) return;
      const onCanvas = (event.target as HTMLElement | null)?.closest('.hb-canvas-wrap');
      const point = onCanvas ? { x: event.clientX, y: event.clientY } : undefined;
      const files = Array.from(event.dataTransfer?.files || []).filter((item) => item.type.startsWith('image/'));
      if (files.length > 0) {
        void Promise.all(files.map((file, index) => addReferenceFile(file, point
          ? { x: point.x + index * 28, y: point.y + index * 28 }
          : undefined)));
        return;
      }
      const link = (event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '').trim();
      if (link) void addReferenceFromUrl(link, point);
      else showToast('只支持图片文件或图片链接');
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    // 兜底清层：任何拖拽结束（chip 换序、拖到窗外、被别的元素截走 drop）都复位，
    // 「松开添加到画布」再也不会有关不死的残留
    const onDragEnd = () => {
      dragDepthRef.current = 0;
      setFileDragging(false);
    };
    window.addEventListener('dragend', onDragEnd);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', onDragEnd);
    };
  }, [addReferenceFile, addReferenceFromUrl, settingsOpen, showToast]);

  /* ── 初始加载：先拉服务端画布文档（换浏览器/新 profile 也能还原），再落活动画布 ── */
  useEffect(() => {
    void (async () => {
      // remote 提到 try 外：清理占位画布那段在 finally 之后还要用
      let remote: CanvasDoc[] = [];
      try {
        remote = await getCanvases();
        const store = useCanvasStore.getState();
        const localPristine = store.canvases.length === 1
          && store.canvases[0].nodes.length === 0
          && store.canvases[0].edges.length === 0;
        if (remote.length > 0 && localPristine) {
          // 全新 profile：直接采用服务端列表，别留一张空默认画布占位
          store.adoptCanvases(remote);
        } else if (remote.length > 0) {
          store.mergeCanvases(remote);
        }
        // 本地较新（或服务端没有）的画布置回推：浏览器是工作副本，bridge 只做第二拷贝
        const remoteById = new Map(remote.map((doc) => [doc.id, doc]));
        for (const doc of useCanvasStore.getState().canvases) {
          const remoteDoc = remoteById.get(doc.id);
          const localEmpty = doc.nodes.length === 0 && doc.edges.length === 0;
          const remoteHasContent = Boolean(remoteDoc)
            && (remoteDoc!.nodes.length > 0 || remoteDoc!.edges.length > 0);
          // 本地是空快照而服务端有内容时不回推：那通常是新 profile 还没水合完，
          // 这一推会把服务端那份冲掉，历史出图就这样丢过
          if (localEmpty && remoteHasContent) continue;
          if (!remoteDoc || Date.parse(doc.updatedAt || '') > Date.parse(remoteDoc.updatedAt || '')) {
            void putCanvasDoc(doc);
          }
        }
        // 对话线程第二拷贝合并：本地缺 / 本地旧的采用远端，本地更新的由 store 回推
        try {
          const remoteThreads = await getChatThreads();
          useChatStore.getState().mergeRemoteThreads(remoteThreads);
        } catch {
          /* 拉不到服务端就用本地对话，功能不中断 */
        }
      } catch {
        /* 拉不到服务端就用本地 localStorage，功能不中断 */
      }
      const current = useCanvasStore.getState();
      if (!current.activeId) {
        const first = current.canvases[0];
        if (first) current.setActive(first.id);
      }
      // 活动画布定下来之后再清理空占位画布，否则每次刷新都会凭空多一张，左侧下拉越用越脏。
      // 只认"默认画布"这个自动占位名（用户新建的叫「画布 N」），空 = 0 节点 0 边。
      // 这里**不能**加"本地独占"条件：空占位早就被浏览器回推 bridge 了，那样永远清不掉。
      const merged = useCanvasStore.getState();
      const hasContent = merged.canvases.some((doc) => doc.nodes.length > 0 || doc.edges.length > 0);
      const isPlaceholderDoc = (doc: CanvasDoc) => doc.name === '默认画布'
        && doc.nodes.length === 0
        && doc.edges.length === 0;
      if (hasContent) {
        // 当前停在空占位上时，先切到最近更新的一张有内容的画布，别让用户对着空白页
        const active = merged.canvases.find((doc) => doc.id === merged.activeId);
        if (active && isPlaceholderDoc(active)) {
          const target = merged.canvases
            .filter((doc) => doc.nodes.length > 0 || doc.edges.length > 0)
            .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || ''))[0];
          if (target) merged.setActive(target.id);
        }
        const settled = useCanvasStore.getState();
        for (const doc of settled.canvases) {
          if (!isPlaceholderDoc(doc) || doc.id === settled.activeId) continue;
          useCanvasStore.getState().deleteCanvas(doc.id);
          void deleteCanvasDoc(doc.id);
        }
      }
      void loadSettings();
    })();
  }, [loadSettings]);

  // 旧标签页可能一直挂着：切回页面时重新读 bridge，避免停留在恢复前的默认模型或旧 Key 状态。
  useEffect(() => {
    const refreshSettings = () => {
      void loadSettings();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshSettings();
    };
    window.addEventListener('focus', refreshSettings);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', refreshSettings);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadSettings]);


  const active = canvases.find((doc) => doc.id === activeId) || canvases[0];
  const activeDocId = active?.id || '';
  const activeDocUpdatedAt = active?.updatedAt || '';


  /* ── 活动画布变更上桥（防抖，拖动节点不会打满请求） ── */
  const remoteSyncRef = useRef(0);
  useEffect(() => {
    if (!activeDocId) return undefined;
    window.clearTimeout(remoteSyncRef.current);
    const doc = useCanvasStore.getState().activeCanvas();
    if (!doc || doc.id !== activeDocId) return undefined;
    remoteSyncRef.current = window.setTimeout(() => void putCanvasDoc(doc), 600);
    return () => window.clearTimeout(remoteSyncRef.current);
  }, [activeDocId, activeDocUpdatedAt]);

  /* ── 节点入场错相：水合灌入的整批不播，用户操作新增的按 index 错相展开 ── */
  useEffect(() => {
    const known = knownNodeIdsRef.current;
    if (skipEnteringDiffRef.current) {
      skipEnteringDiffRef.current = false;
      known.clear();
      nodes.forEach((node) => known.add(node.id));
      return;
    }
    const added = nodes.filter((node) => !known.has(node.id)).map((node) => node.id);
    nodes.forEach((node) => known.add(node.id));
    [...known].forEach((id) => {
      if (!nodes.some((node) => node.id === id)) known.delete(id);
    });
    if (added.length === 0) return;
    setEnteringNodeIds((current) => [...new Set([...current, ...added])]);
  }, [nodes]);

  /* ── 退场清理：节点被真正移除后摘掉退场 class ── */
  useEffect(() => {
    if (exitingNodeIds.length === 0) return;
    const alive = new Set(nodes.map((node) => node.id));
    if (exitingNodeIds.some((id) => !alive.has(id))) {
      setExitingNodeIds((current) => current.filter((id) => alive.has(id)));
    }
  }, [nodes, exitingNodeIds]);

  /* ── 入场结束：动画播完由节点 onAnimationEnd 通知摘 class，比定时器兜底精确 ── */
  useEffect(() => onEvent<NodeAnimationDoneDetail>(NODE_ANIMATION_EVENTS.done, ({ nodeId }) => {
    setEnteringNodeIds((current) => current.filter((id) => id !== nodeId));
  }), []);

  useEffect(() => () => window.clearTimeout(freshResultTimerRef.current), []);

  // 节点 class / style 注入：fresh / entering / exiting 三组 class + 入场错相延迟
  const flowNodes = useMemo<FlowNode[]>(() => nodes.map((node) => {
    const composerReferences = node.data.kind === 'composer'
      ? buildOrderedReferences(node.id, nodes, edges)
      : [];
    const composerEditing = editingNodeId === node.id;
    const referencesChanged = !areCanvasReferencesEqual(node.data.references, composerReferences);
    const editingChanged = Boolean(node.data.composerEditing) !== composerEditing;
    const nextData = referencesChanged || editingChanged
      ? { ...node.data, references: composerReferences, composerEditing }
      : node.data;
    const entering = enteringNodeIds.includes(node.id);
    const nextClassName = [
      node.id === freshResultNodeId ? 'is-fresh-result' : '',
      entering ? 'is-entering' : '',
      exitingNodeIds.includes(node.id) ? 'is-exiting' : '',
    ].filter(Boolean).join(' ');
    // 批量入场时按 index 错相展开（经 CSS 自定义属性传给内层卡片）
    const enterDelay = entering
      ? `${Math.min(enteringNodeIds.indexOf(node.id) * NODE_ENTER_STAGGER_STEP, NODE_ENTER_STAGGER_MAX)}ms`
      : '';
    const nextStyle = enterDelay
      ? { ...node.style, '--image-node-enter-delay': enterDelay } as CSSProperties
      : node.style;
    // React Flow 盒子宽度钉到卡片实测宽（图片按 aspect 档位、composer 按 cardWidth）：
    // node.width 可能停在 composer 期 / 自然尺寸 / 旧 cardWidth，盒子比卡片大时连线端点
    // 就飘出卡片。高度只 pin 图片节点——composer 外壳是内容高度，得让 React Flow 贴着量。
    const imageBox = imageNodeFlowBox(node.data);
    const nextWidth = nodeWidthFor(node.data);
    const nextHeight = imageBox ? imageBox.height : node.height;
    if (node.className === nextClassName && node.style === nextStyle && nextData === node.data
      && node.width === nextWidth && node.height === nextHeight) return node;
    return { ...node, data: nextData, className: nextClassName, style: nextStyle, width: nextWidth, height: nextHeight };
  }), [nodes, edges, editingNodeId, enteringNodeIds, exitingNodeIds, freshResultNodeId]);

  // 与灵枢同款：默认态不挂 edge-related；只有与选中节点相连才走高亮档
  /** 剪断一条连线：删边 + 同步 composer 引用 + 提示，与拖端点到空白断开同一套收尾 */
  const cutEdgeById = useCallback((edgeId: string) => {
    const next = edgesRef.current.filter((edge) => edge.id !== edgeId);
    if (next.length === edgesRef.current.length) return;
    pushGraphUndo('断开连接');
    setEdgesBoth(next);
    syncComposerReferences(next);
    showToast('已断开连接');
  }, [pushGraphUndo, setEdgesBoth, syncComposerReferences, showToast]);

  const flowEdges = useMemo<Edge[]>(() => edges.map((edge) => {
    const related = !!selectedId
      && (String(edge.source) === selectedId || String(edge.target) === selectedId);
    return {
      ...edge,
      className: related ? 'edge-related' : '',
      // onCut 只走渲染层（JSON 序列化时天然丢掉），不写进画布文档
      data: { ...(edge.data || {}), onCut: cutEdgeById },
    };
  }), [edges, selectedId, cutEdgeById]);

  /* ── 整理布局：dock「整理」按钮把节点按边分层排齐，Ctrl+Z 逐次撤回 ── */
  /** 画布编辑撤回栈（Ctrl+Z）：整理布局与节点粘贴共用一条时间线，后进先出——
   *  整理之后又粘贴，先撤的是粘贴；撤过一次弹一条，不混其他编辑历史。 */
  const tidyNodes = useCallback(() => {
    const current = nodesRef.current;
    if (current.length === 0) return;
    const result = tidyLayout(
      current.map((node) => {
        const box = nodeBoxFor(node.data);
        return { id: node.id, x: node.position.x, y: node.position.y, width: box.width, height: box.height };
      }),
      edgesRef.current.map((edge) => ({ source: String(edge.source), target: String(edge.target) })),
      // 屏幕固定的功能条 / dock 是禁入区：整理完不许让卡片压住图标（用户实测）
      { avoid: canvasAvoidRects(rf) },
    );
    if (result.movedIds.length === 0) {
      showToast('画布已经很整齐了');
      return;
    }
    const moved = new Map(result.positions.map((item) => [item.id, item]));
    editUndoRef.current.push({ kind: 'tidy', positions: new Map(result.movedIds.map((id) => {
      const node = current.find((entry) => entry.id === id);
      return [id, { x: node?.position.x ?? 0, y: node?.position.y ?? 0 }] as [string, { x: number; y: number }];
    })) });
    const nextNodes = current.map((node) => {
      const next = moved.get(node.id);
      return next ? { ...node, position: { x: next.x, y: next.y } } : node;
    });
    nodesRef.current = nextNodes;
    // 位置变更不走 applyNodeChanges，persist 抑制位可能还挂着上一轮拖拽的 true，先摘掉
    suppressPersistRef.current = false;
    setNodes(nextNodes);
    showToast(`已整理 ${result.movedIds.length} 个节点，Ctrl+Z 撤回`);
  }, [rf, showToast]);

  /** 撤回一次粘贴：节点连边整组摘掉。故意不走 onNodesChange——那条路会按媒体清单
   *  真删文件，把粘贴时新复制的副本删掉没问题，但原件与副本路径相同时会误伤原件。
   *  撤销栈里登记的复制媒体只清「再没有节点引用」的，原件一根汗毛不动。 */
  const undoPasteEntry = useCallback((entry: Extract<EditUndoEntry, { kind: 'paste' }>) => {
    const ids = new Set(entry.nodeIds);
    const alive = nodesRef.current.filter((node) => ids.has(node.id));
    if (alive.length === 0) {
      showToast('粘贴的节点已删除，没有可撤回的');
      return;
    }
    alive.forEach((node) => removeNode(node.id));
    nodesRef.current = nodesRef.current.filter((node) => !ids.has(node.id));
    const nextEdges = edgesRef.current.filter((edge) => (
      !ids.has(String(edge.source)) && !ids.has(String(edge.target)) && !entry.edgeIds.includes(edge.id)
    ));
    // 粘贴时选中过克隆节点，撤回后 selectedId 可能指着已不存在的节点
    setSelectedId((current) => (current && ids.has(current) ? '' : current));
    suppressPersistRef.current = false;
    setNodes(nodesRef.current);
    setEdgesBoth(nextEdges);
    syncComposerReferences(nextEdges);
    orphanCopiedUrls(entry.copiedUrls, nodesRef.current)
      .forEach((url) => { void deleteImageIfUnused(url.slice('/api/files/'.length)).catch(() => false); });
    showToast(alive.length === 1 ? '已撤回粘贴的节点' : `已撤回粘贴的 ${alive.length} 个节点`);
  }, [removeNode, setEdgesBoth, setSelectedId, showToast, syncComposerReferences]);

  // Ctrl+Z 撤回画布编辑（整理布局 / 节点粘贴）：输入框 / 正文编辑里不抢（那里是浏览器自己的撤销）；
  // 标注器开着时整条跳过——那里 Ctrl+Z 是撤销标注笔迹，两层都会响应就变成了「一起撤」
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (annotateNodeId) return;
      const stack = editUndoRef.current;
      if (stack.length === 0) return;
      event.preventDefault();
      const entry = stack.pop() as EditUndoEntry;
      if (entry.kind === 'tidy') {
        const nextNodes = nodesRef.current.map((node) => {
          const back = entry.positions.get(node.id);
          return back ? { ...node, position: { x: back.x, y: back.y } } : node;
        });
        nodesRef.current = nextNodes;
        suppressPersistRef.current = false;
        setNodes(nextNodes);
        showToast('已撤回整理');
        return;
      }
      if (entry.kind === 'graph') {
        nodesRef.current = entry.nodes;
        edgesRef.current = entry.edges;
        suppressPersistRef.current = false;
        setNodes(entry.nodes);
        setEdges(entry.edges);
        syncComposerReferences(entry.edges);
        setSelectedId('');
        setEditingNodeId('');
        showToast(`已撤回${entry.label}`);
        return;
      }
      undoPasteEntry(entry);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotateNodeId, setEditingNodeId, setSelectedId, showToast, syncComposerReferences, undoPasteEntry]);

  /* ── 生成节点手动拉伸：拖右下角手柄同时改宽高，落定后写库 ── */
  useEffect(() => {
    const onResizeStart = (event: Event) => {
      const detail = (event as CustomEvent<{
        nodeId?: string; clientX?: number; clientY?: number; pointerId?: number; pointerTarget?: HTMLElement;
      }>).detail || {};
      const nodeId = String(detail.nodeId || '');
      const startX = Number(detail.clientX);
      const startY = Number(detail.clientY);
      const node = nodesRef.current.find((entry) => entry.id === nodeId);
      if (!node || node.data.kind !== 'composer' || !Number.isFinite(startX) || !Number.isFinite(startY)) return;
      event.preventDefault();

      const zoom = Math.max(0.1, viewControls.flowViewport.zoom || 1);
      const nodeElement = Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node'))
        .find((element) => element.dataset.id === nodeId);
      const shell = nodeElement?.querySelector<HTMLElement>('.image-node-composer-shell');
      const measuredHeight = shell ? shell.getBoundingClientRect().height / zoom : MIN_COMPOSER_NODE_HEIGHT;
      const startWidth = Number(node.data.cardWidth || 0) > 0 ? Number(node.data.cardWidth) : DEFAULT_COMPOSER_NODE_WIDTH;
      const startHeight = Math.min(
        MAX_COMPOSER_NODE_HEIGHT,
        Math.max(MIN_COMPOSER_NODE_HEIGHT, Number(node.data.nodeHeight) || measuredHeight),
      );
      let latestX = startX;
      let latestY = startY;
      let frame = 0;
      let finished = false;

      const applySize = () => {
        const width = Math.min(
          MAX_COMPOSER_NODE_WIDTH,
          Math.max(MIN_COMPOSER_NODE_WIDTH, startWidth + (latestX - startX) / zoom),
        );
        const height = Math.min(
          MAX_COMPOSER_NODE_HEIGHT,
          Math.max(MIN_COMPOSER_NODE_HEIGHT, startHeight + (latestY - startY) / zoom),
        );
        const nextNodes = nodesRef.current.map((entry) => (
          entry.id === nodeId
            ? {
              ...entry,
              data: {
                ...entry.data,
                cardWidth: Math.round(width),
                nodeHeight: Math.round(height),
                nodeHeightManual: true,
              },
            }
            : entry
        ));
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        return nextNodes;
      };
      const render = () => {
        frame = 0;
        applySize();
      };
      const move = (moveEvent: PointerEvent) => {
        latestX = moveEvent.clientX;
        latestY = moveEvent.clientY;
        if (!frame) frame = window.requestAnimationFrame(render);
      };
      const cleanup = () => {
        if (finished) return;
        finished = true;
        if (frame) {
          window.cancelAnimationFrame(frame);
          frame = 0;
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', cleanup);
        if (Number.isFinite(detail.pointerId)) {
          try { detail.pointerTarget?.releasePointerCapture?.(detail.pointerId as number); } catch { /* 指针已释放 */ }
        }
        window.getSelection()?.removeAllRanges();
      };
      const handlePointerUp = () => {
        applySize();
        cleanup();
        window.setTimeout(() => persistSoon(), 0);
      };

      if (Number.isFinite(detail.pointerId)) {
        try { detail.pointerTarget?.setPointerCapture?.(detail.pointerId as number); } catch { /* 指针不可捕获 */ }
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', cleanup);
    };

    window.addEventListener(NODE_ANIMATION_EVENTS.resizeStart, onResizeStart);
    return () => window.removeEventListener(NODE_ANIMATION_EVENTS.resizeStart, onResizeStart);
  }, [persistSoon, viewControls.flowViewport.zoom]);

  // 工具栏的模型候选：所有配置里勾选的模型汇成一份，带上来源配置名。
  // 语言模型（kind === 'text'，只负责整理提示词）不进生图工具栏——以前混在一起，
  // 用户会在生成节点上误选到 GPT 语言模型。kind 缺失的旧数据按生图算，保持兼容。
  const toolbarModelOptions = useMemo(() => (
    imageModelOptionsOf(settings?.profiles)
  ), [settings]);

  const selectedComposer = useMemo(() => {
    const node = nodes.find((item) => item.id === selectedId);
    if (!node || node.data.kind !== 'composer') return null;
    if (String(node.data.imageUrl || node.data.referenceDataUrl || '').trim()) return null;
    return node;
  }, [nodes, selectedId]);


  /**
   * 工具栏浮在选中节点上方居中。上方放不下（节点顶到可视区上沿）时**翻到卡片下方**，
   * 而不是 clamp 到安全线把自己挤进卡片里——那是"悬浮工具栏被挤下来"的根因。
   */
  const toolbarStyle = useMemo<CSSProperties | undefined>(() => {
    if (!selectedComposer) return undefined;
    const zoom = Number(viewport.zoom) || 1;
    const offsetX = Number(viewport.x) || 0;
    const offsetY = Number(viewport.y) || 0;
    const width = composerWidthForRatio(ratioToNumber(String(selectedComposer.data.ratio || '')) || 1) * zoom;
    const centerX = selectedComposer.position.x * zoom + offsetX + width / 2;
    const nodeTop = selectedComposer.position.y * zoom + offsetY;
    const box = nodeBoxFor(selectedComposer.data);
    const nodeBottom = nodeTop + box.height * zoom;
    const wrap = document.querySelector('.hb-canvas-wrap');
    const wrapWidth = wrap?.clientWidth || window.innerWidth;
    const wrapHeight = wrap?.clientHeight || window.innerHeight;
    const topSafe = 72;
    const above = nodeTop - 52;
    const below = nodeBottom + 12;
    const top = above >= topSafe
      ? above
      : Math.min(below, Math.max(topSafe, wrapHeight - 56));
    return {
      left: Math.min(Math.max(centerX, 180), Math.max(180, wrapWidth - 180)),
      top,
    };
  }, [selectedComposer, viewport]);

  // 选中图片节点时浮在其上方的工具栏：节点像素位置 × 视口缩放，再按可视区收边（灵枢同款）
  const selectedImageNode = useMemo(() => {
    const node = nodes.find((item) => item.id === selectedId);
    if (!node) return null;
    if (String(node.data.imageUrl || node.data.referenceDataUrl || '').trim()) return node;
    return null;
  }, [nodes, selectedId]);

  const annotateImageUrl = useMemo(() => {
    if (!annotateNodeId) return '';
    const node = nodes.find((item) => item.id === annotateNodeId);
    if (!node) return '';
    const versions = normalizeVersions(node.data);
    const active = activeVersionOf({ ...node.data, versions });
    return String(active?.imageUrl || node.data.imageUrl || node.data.referenceDataUrl || '');
  }, [annotateNodeId, nodes]);

  const selectionToolbarStyle = useMemo<CSSProperties | undefined>(() => {
    if (!selectedImageNode) return undefined;
    const zoom = Number(viewport.zoom) || 1;
    const box = nodeBoxFor(selectedImageNode.data);
    const nodeCenterX = selectedImageNode.position.x * zoom + Number(viewport.x || 0) + box.width * zoom / 2;
    const nodeTop = selectedImageNode.position.y * zoom + Number(viewport.y || 0);
    const nodeBottom = nodeTop + box.height * zoom;
    const wrap = document.querySelector('.hb-canvas-wrap');
    const width = (wrap?.clientWidth || window.innerWidth);
    const height = (wrap?.clientHeight || window.innerHeight);
    const toolbarWidth = 128;
    const topSafe = 72;
    const above = nodeTop - 52;
    // 与生成工具栏同规则：上方不够就翻到卡片下方
    const top = above >= topSafe ? above : Math.min(nodeBottom + 12, Math.max(topSafe, height - 56));
    return {
      left: Math.min(Math.max(nodeCenterX, toolbarWidth / 2 + 12), Math.max(toolbarWidth / 2 + 12, width - toolbarWidth / 2 - 12)),
      top,
    };
  }, [selectedImageNode, viewport]);

  return (
    <div
      className={`hb-shell image-canvas-page ${entering ? 'is-entering' : ''} ${chatOpen ? 'is-chat-open' : ''}`}
      style={{ ['--hb-chat-layout-width' as string]: chatOpen ? `${chatPanelWidth}px` : '0px' }}
    >
      <div
        ref={canvasHostRef}
        className={`hb-canvas-wrap image-canvas-flow ${viewControls.panTool ? 'canvas-pan-tool' : ''}`}
      >
        {/* 导航是画布里的浮层：贴最顶部、无背景，空白处点击穿透到画布 */}
        <TopBar
          canvases={canvases}
          activeId={active?.id || ''}
          settingsOpen={settingsOpen}
          direct={direct}
          onSwitch={(id) => {
            setActive(id);
            playEntry();
          }}
          onCreate={() => {
            createCanvas();
            playEntry();
          }}
          onRename={(id, name) => renameCanvas(id, name)}
          onDelete={(id) => {
            deleteCanvas(id);
            void deleteCanvasDoc(id);
          }}
          onToggleSettings={() => setSettingsOpen((open) => !open)}
        />
        {entering ? <CanvasEntryWave hostRef={canvasHostRef} viewport={viewControls.flowViewport} onComplete={completeEntry} /> : null}
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={({ nodes: selected }) => {
            const nextSelectedId = selected.length === 1 ? String(selected[0].id) : '';
            const intent = selectionIntentRef.current;
            if (intent && Date.now() < intent.expiresAt) {
              if (nextSelectedId !== intent.nodeId) return;
            } else {
              selectionIntentRef.current = null;
            }
            setSelectedId(nextSelectedId);
            // 只有“多选”（框选 / 修饰键点选）在这里退出输入态。
            // 换选节点由 onNodeClick 判、点空白由 onPaneClick 判，这里别再按单选变化清：
            // React Flow 在新节点并入后会先补报一次旧选中（结果节点本身还处于选中态），
            // 按下单变化清会把刚拿到的编辑态擦掉，新建的 composer 就进不了输入态。
            if (selected.length > 1) setEditingNodeId('');
          }}
          onNodeClick={(event, node) => {
            // 单击有内容的图片节点就引用到当前对话；修饰键、多选和节点内控件保持原有语义。
            const isMulti = event.shiftKey || event.metaKey || event.ctrlKey;
            const target = event.target as HTMLElement | null;
            const clickedControl = Boolean(target?.closest('button, textarea, input, select, [contenteditable="true"], [role="button"], .react-flow__handle, .image-node-resize-handle'));
            setNodeConnectionMenu(null);
            if (isMulti) {
              selectionIntentRef.current = null;
              setEditingNodeId('');
              return;
            }
            // 选中态交给 React Flow 通过 onNodesChange/onSelectionChange 推进。
            // 这里如果手动用旧快照重写整份 nodes，会覆盖刚刚完成的拖拽位置。
            selectionIntentRef.current = { nodeId: node.id, expiresAt: Date.now() + 250 };
            setSelectedId(node.id);
            deferRemoteDuringNodeInteraction();
            setEditingNodeId(
              node.data.kind === 'composer' && !String(node.data.imageUrl || '').trim() ? node.id : '',
            );
            if (!clickedControl && (node.data.kind === 'image' || node.data.kind === 'reference')) {
              // 只有 AI 对话面板打开时才把节点自动加进引用：面板关闭时点节点只做选中，不抢焦点
              if (useChatStore.getState().open) referenceSelectedInChat(node.id);
            }
          }}
          onNodeDragStart={() => {
            window.clearTimeout(interactionReleaseTimerRef.current);
            interactionRevisionRef.current += 1;
            nodePositionProtectionRef.current.clear();
            nodeInteractionRef.current = true;
            nodeDragUndoRef.current = cloneGraphForUndo(nodesRef.current, edgesRef.current);
          }}
          onNodeDragStop={() => {
            window.clearTimeout(interactionReleaseTimerRef.current);
            const before = nodeDragUndoRef.current;
            nodeDragUndoRef.current = null;
            const movedPositions = new Map<string, { x: number; y: number }>();
            const moved = before && before.nodes.some((beforeNode) => {
              const afterNode = nodesRef.current.find((node) => node.id === beforeNode.id);
              const changed = Boolean(afterNode && (
                afterNode.position.x !== beforeNode.position.x
                || afterNode.position.y !== beforeNode.position.y
              ));
              if (changed && afterNode) movedPositions.set(afterNode.id, { ...afterNode.position });
              return changed;
            });
            if (moved) editUndoRef.current.push({ kind: 'graph', nodes: before!.nodes, edges: before!.edges, label: '移动节点' });
            if (movedPositions.size > 0) {
              nodePositionProtectionRef.current = movedPositions;
              refreshAfterNodeInteraction(true);
            } else {
              nodeInteractionRef.current = false;
              refreshAfterNodeInteraction();
            }
          }}
          onMove={(_event, nextViewport) => viewControls.setFlowViewport(nextViewport)}
          onMoveEnd={(_event, nextViewport) => viewControls.persistCanvasViewport(nextViewport)}
          // 删除前先播放缩小退场：返回的 Promise 会推迟 ReactFlow 的真正移除
          onBeforeDelete={async ({ nodes: nodesToRemove }) => {
            if (nodesToRemove.length === 0) return true;
            setExitingNodeIds(nodesToRemove.map((node) => String(node.id)));
            await new Promise((resolve) => window.setTimeout(resolve, NODE_EXIT_ANIMATION_MS));
            return true;
          }}
          onNodeDoubleClick={(event, node) => {
            // 灵枢同款：只有双击落在图片区域才开大图，输入区/其它区域不抢
            const target = event.target as HTMLElement | null;
            if (!target?.closest('.image-node-media')) return;
            const url = String(node.data.imageUrl || node.data.referenceDataUrl || '').trim();
            if (!url) return;
            emitEvent<NodePreviewDetail>(NODE_EVENTS.preview, { nodeId: node.id });
          }}
          onPaneClick={(event) => {
            // 灵枢同款：双击空白处弹“图像生成 / 上传图片”菜单，单击收起
            setEditingNodeId('');
            selectionIntentRef.current = null;
            setSelectedId('');
            // 点空白处把所有展开的版本宫格收起来（节点侧还有 Esc / 换选兜底）
            emitEvent(NODE_EVENTS.versionsCollapse, {});
            if (event.detail === 2) {
              pendingConnectionRef.current = null;
              openAddMenu({ x: event.clientX, y: event.clientY });
              return;
            }
            setAddMenu(null);
            setNodeConnectionMenu(null);
            if (historyOpen && !historyClosing) setHistoryClosing(true);
          }}
          onConnectStart={(_event, params) => {
            pendingConnectionRef.current = {
              sourceId: String(params.nodeId || ''),
              handleType: params.handleType === 'target' ? 'target' : 'source',
            };
          }}
          onConnectEnd={(event) => {
            const pending = pendingConnectionRef.current;
            if (!pending?.sourceId) return;
            const target = event.target as HTMLElement | null;
            const point = 'changedTouches' in event && event.changedTouches?.[0]
              ? { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }
              : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
            const targetNodeElement = target?.closest('.react-flow__node') as HTMLElement | null;
            const targetNodeId = targetNodeElement?.dataset.id || '';
            // 接触到任意节点即连线（不要求对准圆形手柄）：拖到节点身上也算接上。
            // 手柄对接成功的情况 onConnect 已经建过边并清了挂起态，走不到这里。
            if (targetNodeId) {
              connectPending(targetNodeId);
              return;
            }
            // 改接手势拖到空白 = 断开连接（边已由 onReconnectEnd 删掉）：不再弹添加菜单
            if (edgeReconnectingRef.current) {
              edgeReconnectingRef.current = false;
              return;
            }
            // 拖到空白处：弹添加菜单，建完节点后自动补上这条线
            openAddMenu(point);
          }}
          defaultViewport={active?.viewport}
          fitView={!active?.viewport}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={annotateNodeId ? null : ['Backspace', 'Delete']}
          onReconnectStart={() => {
            edgeReconnectingRef.current = true;
            pendingConnectionRef.current = null;
          }}
          edgesReconnectable
          /* 端点抓手半径：xyflow 默认 10px 太小，线条两头基本捏不住。
             放大后两端各有一块明显的拖拽区，拖到空白处即断开（onReconnectEnd 里删边）。 */
          reconnectRadius={16}
          onReconnect={(oldEdge, newConnection) => {
            const source = String(newConnection.source || '');
            const target = String(newConnection.target || '');
            const sourceHandle = newConnection.sourceHandle || 'out';
            const targetHandle = newConnection.targetHandle || 'in';
            const sourceNode = nodesRef.current.find((node) => node.id === source);
            const targetNode = nodesRef.current.find((node) => node.id === target);
            // 规则与新建连接一致：图（结果 / 参考）→ 生成节点；目标必须是 composer
            const valid = Boolean(
              sourceNode
              && targetNode
              && targetNode.data.kind === 'composer'
              && source !== target
              // 已连过就不再来一条重复线
              && !edgesRef.current.some((edge) => edge.id !== oldEdge.id && edge.source === source && edge.target === target),
            );
            if (!valid) {
              edgeReconnectedRef.current = true;
              showToast('该连接无效，已保留原连接');
              return;
            }
            const next = edgesRef.current.map((edge) => (
              edge.id === oldEdge.id ? { ...edge, source, target, sourceHandle, targetHandle } : edge
            ));
            pushGraphUndo('调整连接');
            edgeReconnectedRef.current = true;
            setEdgesBoth(next);
            syncComposerReferences(next);
          }}
          onReconnectEnd={(_event, draggedEdge) => {
            // 拖端点落到空白处 = 断开连接。成功改接时 onReconnect 已把标记置真，这里只处理没接上的。
            // v12 已移除 onEdgeUpdate，删边必须自己来，否则线条永远拽不断。
            if (edgeReconnectedRef.current) {
              edgeReconnectedRef.current = false;
              pendingConnectionRef.current = null;
              return;
            }
            const next = edgesRef.current.filter((edge) => edge.id !== draggedEdge.id);
            if (next.length === edgesRef.current.length) return;
            pushGraphUndo('断开连接');
            setEdgesBoth(next);
            syncComposerReferences(next);
            pendingConnectionRef.current = null;
            showToast('已断开连接');
          }}
          snapToGrid
          snapGrid={[12, 12]}
          // 左键拖拽空白处 = 框选；开启"拖动"工具后左键只平移；右键拖拽 = 平移；滚轮 = 缩放
          {...viewControls.interactionProps}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={2} color="var(--color-canvas-dot)" />
          {/* 左侧功能入口：添加节点（菜单贴按钮展开）+ 拖动工具 */}
          <CanvasRail
            onAdd={({ x, y }) => openAddMenu({ x, y })}
            panTool={viewControls.panTool}
            onTogglePanTool={viewControls.togglePanTool}
            addTitle="添加节点"
            extraButtons={(
              <button
                type="button"
                className={`canvas-rail-btn ${historyOpen ? 'is-active' : ''}`}
                title="生成历史"
                aria-label="生成历史"
                aria-pressed={historyOpen}
                onClick={(event) => {
                  event.stopPropagation();
                  if (historyOpen) {
                    // 收起动画中再点 = 不等了，直接卸载
                    if (historyClosing) {
                      setHistoryOpen(false);
                      setHistoryClosing(false);
                      return;
                    }
                    setHistoryClosing(true);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  openHistory({ x: rect.right + 12, y: rect.top - 8 });
                }}
              >
                <HistoryIcon />
              </button>
            )}
          />
          {/* 左下角缩放 dock：整理 + 重置视角 + 百分比 + 对数滑块 */}
          <CanvasDock
            zoom={viewControls.flowViewport.zoom}
            onZoomChange={viewControls.setCanvasZoom}
            onTidy={tidyNodes}
            onReset={viewControls.resetToBestView}
          />
        </ReactFlow>
        {nodes.length === 0 && !addMenu ? (
          <div className="image-empty-dropzone" aria-label="双击空白处添加生成节点">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" width="34" height="34">
              <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11Z" stroke="currentColor" strokeWidth="1.5" />
              <path d="m7.5 16 3.1-3.2 2.2 2.2 1.4-1.5 2.8 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M15 9h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            <strong>双击空白处添加生成节点</strong>
            <span>也可以直接粘贴图片，或从桌面拖进画布</span>
          </div>
        ) : null}
        {addMenu ? (
          <AddMenu
            x={addMenu.x}
            y={addMenu.y}
            onCreateGenerationNode={() => {
              const menu = addMenu;
              setAddMenu(null);
              const id = addComposerNode({ x: menu.clientX + 8, y: menu.clientY + 8 });
              connectPending(id);
            }}
            onUploadImage={() => {
              menuUploadContextRef.current = {
                point: { x: addMenu.clientX + 8, y: addMenu.clientY + 8 },
                connection: addMenu.connection,
              };
              pendingConnectionRef.current = null;
              setAddMenu(null);
              menuFileInputRef.current?.click();
            }}
          />
        ) : null}
        <input
          ref={menuFileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) return;
            const uploadContext = menuUploadContextRef.current;
            menuUploadContextRef.current = null;
            void Promise.all(files.map((file, index) => addReferenceFile(file, uploadContext?.point
              ? { x: uploadContext.point.x + index * 28, y: uploadContext.point.y + index * 28 }
              : undefined))).then((ids) => {
              const firstId = ids.find(Boolean);
              if (firstId) connectPending(firstId, uploadContext?.connection);
            });
          }}
        />
        {nodeConnectionMenu ? (
          <NodeConnectionMenu
            x={nodeConnectionMenu.x}
            y={nodeConnectionMenu.y}
            sourceId={nodeConnectionMenu.sourceId}
            direction={nodeConnectionMenu.direction}
            nodes={nodes as CanvasNode[]}
            edges={edges}
            onClose={() => setNodeConnectionMenu(null)}
            onConnect={(targetId) => {
              const menu = nodeConnectionMenu;
              setNodeConnectionMenu(null);
              if (!menu) return;
              const source = menu.direction === 'target' ? targetId : menu.sourceId;
              const target = menu.direction === 'target' ? menu.sourceId : targetId;
              appendConnection({ source, sourceHandle: 'out', target, targetHandle: 'in' });
              setSelectedId(target);
              setEditingNodeId(target);
            }}
          />
        ) : null}
        {selectedImageNode && selectedImageNode.data.status !== 'running' ? (
          <NodeSelectionToolbar
            style={selectionToolbarStyle}
            showPreview={Boolean(String(selectedImageNode.data.imageUrl || '').trim())}
            showRedit={selectedImageNode.data.kind === 'image'}
            onPreview={() => emitEvent<NodePreviewDetail>(NODE_EVENTS.preview, { nodeId: selectedImageNode.id })}
            onRedit={() => emitEvent<NodeReditDetail>(NODE_EVENTS.redit, { nodeId: selectedImageNode.id })}
            onRegenerate={() => regenerateFromImage(selectedImageNode.id)}
            onAnnotate={() => setAnnotateNodeId(selectedImageNode.id)}
          />
        ) : null}
        {selectedComposer ? (
          <NodeGenerationToolbar
            style={toolbarStyle}
            // 节点自己没选过模型时，工具栏显示当前生效那一路的名字（生成也是走它）：
            // 老画布的节点因此不再显示「选择模型」占位，与新节点一致（Figma 2664:1903）
            model={String(selectedComposer.data.model || activeProfileOf(settings)?.model || '')}
            modelOptions={toolbarModelOptions}
            ratio={String(selectedComposer.data.ratio || '1:1')}
            prompt={String(selectedComposer.data.prompt || '')}
            references={selectedComposer.data.references}
            direct={direct}
            onSelectModel={(model, profileId) => patchNode(selectedComposer.id, { model, profileId })}
            onSelectRatio={(label) => patchNode(selectedComposer.id, {
              ratio: label,
              // 「自动」档没有固定比例：卡片宽度先按 1:1 给，生成时再按参考图收敛
              cardWidth: label === AUTO_RATIO ? 320 : composerWidthForRatio(ratioToNumber(label)),
            })}
            resolution={String(selectedComposer.data.resolution || '1K')}
            onSelectResolution={(label) => patchNode(selectedComposer.id, {
              resolution: label === '1K' ? undefined : (label as '2K' | '4K'),
            })}
            imageCount={clampImageCount(selectedComposer.data.imageCount)}
            onSelectImageCount={(count) => patchNode(selectedComposer.id, {
              imageCount: count > 1 ? count : undefined,
            })}
            onToggleDirect={() => {
              const next = !direct;
              // 落盘失败要把原因抛给用户：否则开关看起来"没反应"
              setDirect(next).catch((err: unknown) => {
                showToast(`切换失败：${err instanceof Error ? err.message : '请检查 bridge 是否在运行'}`);
              });
            }}
          />
        ) : null}
        <input
          ref={composerFileInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            const replaceTarget = replaceTargetRef.current;
            replaceTargetRef.current = '';
            if (replaceTarget) {
              if (file) void replaceReference(replaceTarget, file);
              return;
            }
            const pending = pendingConnectionRef.current;
            if (!file) {
              if (pending?.handleType === 'target') pendingConnectionRef.current = null;
              return;
            }
            if (pending?.handleType !== 'target') return;
            const composer = nodesRef.current.find((node) => node.id === pending.sourceId);
            if (!composer) {
              pendingConnectionRef.current = null;
              return;
            }
            // 参考图落在生成节点左侧，留出手柄连线的空间
            const screen = rf.flowToScreenPosition({
              x: composer.position.x - Number(composer.data.cardWidth || 320) - 96,
              y: composer.position.y + 24,
            });
            void addReferenceFile(file, { x: screen.x, y: screen.y }).then((id) => {
              if (id) connectPending(id);
            });
          }}
        />
        {fileDragging ? (
          <div className="hb-drop-overlay" aria-hidden="true">
            <div className="hb-drop-card">
              <strong>松开添加到画布</strong>
              <span>图片将作为参考图，连线到生成节点即可图生图</span>
            </div>
          </div>
        ) : null}
        {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
        {toast ? <div className="hb-toast">{toast}</div> : null}
        {historyOpen ? (
          <HistoryPanel
            items={historyItems}
            loading={historyLoading}
            error={historyError}
            anchorRect={historyAnchor}
            onSelect={(item) => {
              setHistoryOpen(false);
              setPreviewItem(previewItemOfHistory(item));
            }}
            onLocate={(item) => locateHistoryItem(item)}
            onClose={() => {
              setHistoryOpen(false);
              setHistoryClosing(false);
            }}
            closing={historyClosing}
            onRequestClose={() => setHistoryClosing(true)}
            onClosed={() => {
              setHistoryOpen(false);
              setHistoryClosing(false);
            }}
          />
        ) : null}
        <ImagePreviewLightbox
          item={previewItem}
          playlist={historyItems.map(previewItemOfHistory)}
          onNavigate={setPreviewItem}
          onClose={() => setPreviewItem(null)}
        />
        {annotateNodeId && annotateImageUrl ? (
          <ImageAnnotator
            imageUrl={annotateImageUrl}
            onCancel={() => setAnnotateNodeId('')}
            onSave={handleAnnotateSave}
            onGenerate={(dataUrl, prompt) => handleAnnotateSave(dataUrl, prompt)}
          />
        ) : null}
      </div>
      {/* 对话面板是画布之外的浮层：右下角按钮 + 悬浮卡片，不参与画布交互 */}
      <ChatPanel
        canvasNames={Object.fromEntries(canvases.map((doc) => [doc.id, doc.name]))}
        onSend={(text, refs, modelSelection) => void startChatRunFlow(text, refs, { modelSelection })}
        onStop={stopChatRunFlow}
        submitting={chatRunStarting}
        onLocate={locateChatRef}
        onPreview={(url, title) => setPreviewItem({ url, title })}
        onRetry={retryChatMessage}
        onAnswerClarification={answerChatClarification}
        onWidthChange={setChatPanelWidth}
      />
    </div>
  );
}

/** 版本宫格展开时的视角下限：100% 是用户实测最舒服的看图倍率，低于它才抬上来 */
const VERSION_FIT_MIN_ZOOM = 0.8;

/** 图像画布边：+ 把手圆心在节点边框外 28px，线条端点落在「距边框 12px」处与节点留出间距，
    （用户实测 16px 仍显远，收到 12px：既留出把手的呼吸位，线又明显贴向卡片），
    让线从把手附近才开始弯，不会插进卡片里。
    边框一律按卡片实测宽（imageNodeFlowBox）算，不读 measured：图片 / 参考图节点的卡片宽
    按 aspect 档位重算，而 React Flow 的 measured 可能还停在 composer 期或上传时的自然尺寸，
    盒子比卡片大时端点会飘到卡片外面（横图版本节点上曾飘出 94px）。图片节点拿不到盒子时
    才回落 measured；节点整体还没挂上时回落 props（handle 伸出 40px，实测有陈旧误差）。 */
function CanvasEdge(props: EdgeProps) {
  const sourceNode = useInternalNode(props.source);
  const targetNode = useInternalNode(props.target);
  const EDGE_INSET = 12;
  const sourceLeftX = sourceNode ? sourceNode.internals.positionAbsolute.x : props.sourceX;
  const sourceWidth = sourceNode ? nodeWidthFor(sourceNode.data) : 0;
  const sourceRightX = sourceLeftX + sourceWidth;
  const targetLeftX = targetNode ? targetNode.internals.positionAbsolute.x : props.targetX;
  const targetWidth = targetNode ? nodeWidthFor(targetNode.data) : 0;
  const targetRightX = targetLeftX + targetWidth;
  const sourceX = props.sourcePosition === Position.Right
    ? sourceRightX + EDGE_INSET
    : props.sourcePosition === Position.Left
      ? sourceLeftX - EDGE_INSET
      : props.sourceX;
  const targetX = props.targetPosition === Position.Left
    ? targetLeftX - EDGE_INSET
    : props.targetPosition === Position.Right
      ? targetRightX + EDGE_INSET
      : props.targetX;
  return <FlowEdge {...props} sourceX={sourceX} targetX={targetX} />;
}

const edgeTypes = {
  default: CanvasEdge,
  canvasEdge: CanvasEdge,
};

export default function CanvasPage() {
  return (
    <ReactFlowProvider>
      <CanvasWorkspace />
    </ReactFlowProvider>
  );
}
