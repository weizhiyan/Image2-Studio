import './ImageAnnotator.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AiGlyphIcon } from './NodeToolbarIcons';
import { SendGlyphIcon } from '@/components/chat/ChatIcons';

export interface ImageAnnotatorProps {
  /** 要标注的图（/api/files/... 或 dataURL）。 */
  imageUrl: string;
  onCancel: () => void;
  /** 保存：交付标注合成图的 dataURL（调用方落盘后作为新版本挂回节点）。 */
  onSave: (dataUrl: string) => void | Promise<void>;
  onGenerate: (dataUrl: string, prompt: string) => void | Promise<void>;
}

interface Point {
  x: number;
  y: number;
}

/**
 * 标注工具四选一：select 是「修改模式」——点选已画的线 / 框 / 文字并整体拖动移位，
 * 不产生新 shape；另外三个才是绘制工具。
 */
type AnnotateTool = 'select' | 'pen' | 'rect' | 'text';

/**
 * 统一 shape 历史栈：画笔 / 矩形 / 文字三类 shape 共用一套撤销、重做。
 * - pen：一条自由线，点序列已换算到画布自然尺寸（导出不丢精度）
 * - rect：一个实线矩形框，from/to 是拖拽起止两角的自然坐标
 * - text：一段文字，point 为落字点、字号由 width 换算（见 fontSizeFor）
 */
type AnnotateShape =
  | { kind: 'pen'; color: string; width: number; points: Point[] }
  | { kind: 'rect'; color: string; width: number; from: Point; to: Point }
  | { kind: 'text'; color: string; width: number; point: Point; text: string };

/** 文字浮层的上下文：自然坐标用于落字，left/top/scale 用于在缩放后的画布上摆放 input。 */
interface TextDraft {
  point: Point;
  left: number;
  top: number;
  /** 画布显示倍率（展示宽 / 自然宽）：input 字号要按它从自然字号缩放回屏幕像素。 */
  scale: number;
  color: string;
  width: number;
  value: string;
}

/** 画布像素色（JS 常量不是 CSS）：红黄蓝白紫五色预设。用户实测「太淡」，
 *  统一调高饱和、压明度——白除外（图上要压住画面只能用纯白）。 */
const PALETTE = ['#E5484D', '#E3A008', '#3E7BFA', '#FFFFFF', '#8E4EC6'];
const PALETTE_NAMES = ['红色', '黄色', '蓝色', '白色', '紫色'];

/** 选中框用色（JS 画布常量，与 CSS token 无关）：借调色板的蓝，读起来像「工具选中」而不是新画了一笔。 */
const SELECT_COLOR = '#3E7BFA';

/** canvas font 字符串必须是字面量，字体族抽成常量（与 tokens 的 --font-sans 同族）。 */
const CANVAS_FONT_FAMILY = '"PingFang SC", -apple-system, "PingFang SC", sans-serif';

/**
 * 文字字号与线条粗细联动：粗细取值 1–16 → 字号 6–96px。
 * 圈注时线越粗字越大，视觉重量才一致；上下浮动几 px 不影响使用。
 */
const fontSizeFor = (width: number) => width * 6;

/** 把一个 shape 画进上下文（预览与导出走同一条路径，保证所见即所得）。 */
function paintShape(ctx: CanvasRenderingContext2D, shape: AnnotateShape) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (shape.kind === 'pen') {
    if (shape.points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(shape.points[0].x, shape.points[0].y);
    for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
    // 单点落笔也要看见：往右偏 0.01 自然像素画一段零长度线，出一个圆点
    if (shape.points.length === 1) ctx.lineTo(shape.points[0].x + 0.01, shape.points[0].y);
    ctx.stroke();
    return;
  }
  if (shape.kind === 'rect') {
    // 实线矩形（用户实测虚线框存在感太弱）：预览与导出同一条路径
    ctx.strokeRect(
      Math.min(shape.from.x, shape.to.x),
      Math.min(shape.from.y, shape.to.y),
      Math.abs(shape.to.x - shape.from.x),
      Math.abs(shape.to.y - shape.from.y),
    );
    return;
  }
  ctx.font = `${fontSizeFor(shape.width)}px ${CANVAS_FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(shape.text, shape.point.x, shape.point.y);
}

/** shape 的外接框（自然坐标）。文字的宽要现场量：font 只有画布上下文认得。 */
function shapeBounds(ctx: CanvasRenderingContext2D, shape: AnnotateShape) {
  if (shape.kind === 'text') {
    const size = fontSizeFor(shape.width);
    ctx.font = `${size}px ${CANVAS_FONT_FAMILY}`;
    return { x: shape.point.x, y: shape.point.y - size / 2, width: ctx.measureText(shape.text).width, height: size };
  }
  if (shape.kind === 'rect') {
    return {
      x: Math.min(shape.from.x, shape.to.x),
      y: Math.min(shape.from.y, shape.to.y),
      width: Math.abs(shape.to.x - shape.from.x),
      height: Math.abs(shape.to.y - shape.from.y),
    };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of shape.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 点到线段的距离：自由线是一串折线段，判定要逐段算，不能只跟外接框较劲。 */
function distanceToSegment(point: Point, from: Point, to: Point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq));
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

/**
 * 命中判定（tolerance 已换算成自然像素，屏幕上空 8px 的容差）。
 * 矩形 / 文字框内即算；自由线必须真的压在线段上——否则长斜线的外接框里空一大片都能点中。
 */
function hitShape(ctx: CanvasRenderingContext2D, shape: AnnotateShape, point: Point, tolerance: number) {
  const bounds = shapeBounds(ctx, shape);
  const pad = shape.width / 2 + tolerance;
  if (
    point.x < bounds.x - pad ||
    point.x > bounds.x + bounds.width + pad ||
    point.y < bounds.y - pad ||
    point.y > bounds.y + bounds.height + pad
  ) {
    return false;
  }
  if (shape.kind !== 'pen') return true;
  const reach = shape.width / 2 + tolerance;
  if (shape.points.length === 1) return Math.hypot(point.x - shape.points[0].x, point.y - shape.points[0].y) <= reach;
  for (let index = 0; index < shape.points.length - 1; index += 1) {
    if (distanceToSegment(point, shape.points[index], shape.points[index + 1]) <= reach) return true;
  }
  return false;
}

/**
 * 选中框几何（自然坐标）：紧贴 shape 外接框外扩 pad，四角把手就是外扩后的四个角
 * （顺时针：左上 / 右上 / 左下 / 右下）。画框、把手命中判定、缩放手势的锚点
 * 共用这一处算法，改视觉只改这里。
 */
function selectionFrame(ctx: CanvasRenderingContext2D, shape: AnnotateShape, naturalPerScreen: number) {
  const bounds = shapeBounds(ctx, shape);
  const pad = shape.width / 2 + 6 * naturalPerScreen;
  const x = bounds.x - pad;
  const y = bounds.y - pad;
  const width = bounds.width + pad * 2;
  const height = bounds.height + pad * 2;
  return {
    bounds,
    pad,
    corners: [
      { x, y },
      { x: x + width, y },
      { x, y: y + height },
      { x: x + width, y: y + height },
    ],
  };
}

/** 选中框：虚线框 + 实心把手，把「这是选中态」和「这是画的内容」区分开。 */
function paintSelection(ctx: CanvasRenderingContext2D, shape: AnnotateShape, naturalPerScreen: number) {
  const { corners } = selectionFrame(ctx, shape, naturalPerScreen);
  const handle = 3 * naturalPerScreen;
  ctx.save();
  ctx.lineWidth = 1.5 * naturalPerScreen;
  ctx.setLineDash([6 * naturalPerScreen, 4 * naturalPerScreen]);
  ctx.strokeStyle = SELECT_COLOR;
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  ctx.lineTo(corners[1].x, corners[1].y);
  ctx.lineTo(corners[3].x, corners[3].y);
  ctx.lineTo(corners[2].x, corners[2].y);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 1 * naturalPerScreen;
  ctx.strokeStyle = '#FFFFFF';
  for (const corner of corners) {
    ctx.fillStyle = SELECT_COLOR;
    ctx.fillRect(corner.x - handle, corner.y - handle, handle * 2, handle * 2);
    ctx.strokeRect(corner.x - handle, corner.y - handle, handle * 2, handle * 2);
  }
  ctx.restore();
}

/** 线宽夹在 1–16：缩放把倍率乘上来时，别把线宽 / 字号拖出预设区间。 */
const clampThickness = (value: number) => Math.min(16, Math.max(1, Math.round(value)));

/** 整体平移一个 shape（自由线是一串点，矩形是两个角，文字是一个落点）。 */
function shiftShape(shape: AnnotateShape, dx: number, dy: number) {
  if (shape.kind === 'pen') {
    shape.points = shape.points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    return;
  }
  if (shape.kind === 'rect') {
    shape.from = { x: shape.from.x + dx, y: shape.from.y + dy };
    shape.to = { x: shape.to.x + dx, y: shape.to.y + dy };
    return;
  }
  shape.point = { x: shape.point.x + dx, y: shape.point.y + dy };
}

/** 深拷贝历史快照：撤销 / 重做要的是那一版的完整形状，拖动中途原地改过的不算。 */
function cloneShapes(list: AnnotateShape[]) {
  return list.map((shape) => {
    if (shape.kind === 'pen') return { ...shape, points: shape.points.map((point) => ({ ...point })) };
    if (shape.kind === 'rect') return { ...shape, from: { ...shape.from }, to: { ...shape.to } };
    return { ...shape, point: { ...shape.point } };
  });
}

/**
 * 图片标注浮层（模型见图）：在结果图上直接手动画线、画矩形框、落文字，保存后合成一张新图。
 * 画布按原图自然尺寸维护、CSS 缩放展示——指针坐标换算回自然尺寸，导出与原图同精度。
 * 顶部工具条：退出标注 / 选择移动·画笔·矩形·文字 / 颜色（单色钮 + 下拉色板）·粗细 /
 * 撤销·重做 / 保存图片·直接生成——除「保存图片 / 直接生成」外都是图标钮，色板收进下拉里；
 * 左侧是绘制区，右侧 undo/redo/保存/生成 是动作区，粗细数字框吃掉中间空隙。
 * 「选择移动」是修改模式：点选已画的线 / 框 / 文字（后画的盖住先画的），按住整体拖动，
 *  Esc 取消选中；画笔 / 矩形下直接点中已画内容也能选上拖走（不用先切工具），抓住选中框
 *  四角把手则整体缩放。所有改动都进同一套撤销 / 重做，拖动 / 缩放按整版快照压栈。
 */
export default function ImageAnnotator({ imageUrl, onCancel, onSave, onGenerate }: ImageAnnotatorProps) {
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const submittingRef = useRef(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const resizePrompt = useCallback(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, []);

  useLayoutEffect(() => {
    resizePrompt();
  }, [prompt, resizePrompt]);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    let previousWidth = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      if (textarea.clientWidth === previousWidth) return;
      previousWidth = textarea.clientWidth;
      resizePrompt();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [resizePrompt]);
  /**
   * 历史栈按「整版快照」存：每次提交都往 pastRef 压一份操作前的完整形状表。
   * 原来是「一 shape 一条」，那样拖动过的 shape 撤销只能整条消失、回不到拖动前的位置。
   * 按钮禁用态只要深浅两个布尔，不必把整表搬进 state。
   */
  const shapesRef = useRef<AnnotateShape[]>([]);
  const pastRef = useRef<AnnotateShape[][]>([]);
  const futureRef = useRef<AnnotateShape[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  /** 正在画的 shape（画笔行进中的线 / 矩形拖拽中的框）：只走 ref，高频指针事件不触发重渲染。 */
  const draftRef = useRef<AnnotateShape | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tool, setTool] = useState<AnnotateTool>('pen');
  const [color, setColor] = useState(PALETTE[0]);
  const [thickness, setThickness] = useState(4);
  /** 粗细数字框的文本中间态：可以清空重打，失才归一到合法区间，避免打一半被弹回 */
  const [thicknessText, setThicknessText] = useState('4');
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const textDraftRef = useRef<TextDraft | null>(null);
  /** 色板下拉开关 + 容器 ref（点外面收起）/ 文字输入框 ref（补焦点）。 */
  const [colorOpen, setColorOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  /**
   * 修改模式（选择工具）状态：selectedRef 是历史栈下标，选中框直接画在画布上，
   * 不占 React state，点选 / 拖动都不触发重渲染。dragRef 记拖动起点和拖动前的整版快照。
   */
  const selectedRef = useRef<number | null>(null);
  /** moved 标记很重要：只点选不移动时不压历史，否则每点一下就白吃一步撤销。 */
  const dragRef = useRef<{ last: Point; before: AnnotateShape[]; moved: boolean } | null>(null);
  /**
   * 缩放手势：抓住选中框的角把手拖。anchor 是「对角」的原始坐标（shape 外接框的角，
   * 不是外扩后的把手角）；handOff 是被抓把手相对原始角的偏移——指针坐标减掉它才是
   * 该贴上去的原始角；base 是手势开始时的原始外接框与线宽。
   */
  const resizeRef = useRef<{
    index: number;
    anchor: Point;
    handOff: Point;
    base: { width: number; height: number };
    baseWidth: number;
    before: AnnotateShape[];
    moved: boolean;
  } | null>(null);
  /** 底图宽高比：面板宽度照着图片走，别把一张方图抻成一条宽工具条。 */
  const [aspect, setAspect] = useState(1);

  /**
   * 重绘：底图 + 历史栈里的 shape + 正在画的这一笔（+ 选中框）。
   * includeSelection 只有预览传 true：选中框是编辑器 chrome，导出时必须摘掉，
   * 否则虚线框跟着一起烙进生成的图里。
   */
  const redraw = useCallback((includeSelection = true) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    // 自然像素 / 屏幕像素：选中框的线宽、虚线、把手都要按它换算，缩放后才是一个视觉粗细
    const naturalPerScreen = rect.width > 0 ? canvas.width / rect.width : 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    shapesRef.current.forEach((shape) => paintShape(ctx, shape));
    if (draftRef.current) paintShape(ctx, draftRef.current);
    const index = selectedRef.current;
    if (includeSelection && index !== null && shapesRef.current[index]) {
      paintSelection(ctx, shapesRef.current[index], naturalPerScreen);
    }
  }, []);

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth || 1024;
        canvas.height = image.naturalHeight || 1024;
      }
      // 换图（重新挂载）时清空全部编辑状态，不把上一张的历史带过来
      shapesRef.current = [];
      pastRef.current = [];
      futureRef.current = [];
      draftRef.current = null;
      textDraftRef.current = null;
      selectedRef.current = null;
      dragRef.current = null;
      setCanUndo(false);
      setCanRedo(false);
      setTextDraft(null);
      setAspect(canvas && canvas.height > 0 ? canvas.width / canvas.height : 1);
      setReady(true);
      redraw();
    };
    image.onerror = () => setLoadError('图片加载失败，无法标注');
    image.src = imageUrl;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [imageUrl, redraw]);

  /** 色板点外面收起：只在翻开时挂监听，免得每次渲染都增删。 */
  useEffect(() => {
    if (!colorOpen) return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (colorPickerRef.current?.contains(event.target as Node)) return;
      setColorOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [colorOpen]);

  /** 文字浮层落定后补一次焦点。autoFocus 在「点画布 → 同一轮渲染出输入框」这条路上不可靠：
   *  浏览器接着执行 pointerdown 的默认动作会把焦点拽回 body，输入框一闪就没（用户实测输入不了）。
   *  pointerdown 里已 preventDefault 断掉默认动作，这里再兜一层底。 */
  useEffect(() => {
    if (textDraft) textInputRef.current?.focus();
  }, [textDraft]);

  /** 修改模式按 Esc 取消选中，跟文字浮层的 Esc 取消同一套手势。 */
  useEffect(() => {
    if (tool !== 'select') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || selectedRef.current === null) return;
      selectedRef.current = null;
      redraw();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tool, redraw]);

  /** 指针屏幕坐标 → 画布自然尺寸坐标（画布是 CSS 缩放展示的）。 */
  const toNatural = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  /**
   * 整版提交历史：before 是这次操作前的完整快照（绘制前抓的 / 拖动前抓的）。
   * 注意 shapesRef.current 此刻已经是操作后的版本，调用方负责把它换好。
   */
  const commitHistory = (before: AnnotateShape[]) => {
    pastRef.current = [...pastRef.current, before];
    futureRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  };

  /** 入库一个 shape：追加到末尾，压一份「追加前」的快照。 */
  const commitShape = (shape: AnnotateShape) => {
    commitHistory(cloneShapes(shapesRef.current));
    shapesRef.current = [...shapesRef.current, shape];
    redraw();
  };

  /** 命中判定：从栈顶往下找第一个压中的（后画的盖住先画的）。容差按屏幕 8px 折成自然像素。 */
  const topmostShapeAt = (point: Point) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rect = canvas.getBoundingClientRect();
    const tolerance = rect.width > 0 ? (8 * canvas.width) / rect.width : 8;
    const list = shapesRef.current;
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (hitShape(ctx, list[index], point, tolerance)) return index;
    }
    return null;
  };

  /** 选中 shape 的选中框几何 + 原始四角（缩放锚点用）：拿得到才返回值。 */
  const selectionFrameOf = (index: number) => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const shape = shapesRef.current[index];
    if (!canvas || !image || !shape) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const rect = canvas.getBoundingClientRect();
    const naturalPerScreen = rect.width > 0 ? canvas.width / rect.width : 1;
    const frame = selectionFrame(ctx, shape, naturalPerScreen);
    return {
      shape,
      corners: frame.corners,
      bounds: frame.bounds,
      naturalPerScreen,
      // 原始四角（不带外扩 pad）：缩放时锚点与目标角都按原始坐标算
      rawCorners: [
        { x: frame.bounds.x, y: frame.bounds.y },
        { x: frame.bounds.x + frame.bounds.width, y: frame.bounds.y },
        { x: frame.bounds.x, y: frame.bounds.y + frame.bounds.height },
        { x: frame.bounds.x + frame.bounds.width, y: frame.bounds.y + frame.bounds.height },
      ],
    };
  };

  /** 指针压中的角把手序号（屏幕 8px 容差折成自然像素），没压中返回 -1。 */
  const handleIndexAt = (point: Point) => {
    const index = selectedRef.current;
    if (index === null) return -1;
    const frame = selectionFrameOf(index);
    if (!frame) return -1;
    const reach = 8 * frame.naturalPerScreen;
    return frame.corners.findIndex(
      (corner) => Math.hypot(corner.x - point.x, corner.y - point.y) <= reach,
    );
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready || loadError) return;
    const point = toNatural(event);
    if (!point) return;
    if (tool === 'text') {
      if (textDraftRef.current) return;
      const hit = topmostShapeAt(point);
      if (hit !== null && shapesRef.current[hit].kind === 'text') {
        selectedRef.current = hit;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { last: point, before: cloneShapes(shapesRef.current), moved: false };
        if (canvasRef.current) canvasRef.current.style.cursor = 'move';
        redraw();
        return;
      }
      selectedRef.current = null;
      redraw();
      // 断掉 pointerdown 的默认动作（焦点重定向），否则刚落型的输入框会被马上 blur 掉
      event.preventDefault();
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const stage = canvas.parentElement;
      const stageRect = stage?.getBoundingClientRect();
      const draft: TextDraft = {
        point,
        // 浮层定位在 stage 坐标系里（canvas 居中于 stage，偏移要按 stage 左上角算）
        left: event.clientX - (stageRect?.left ?? rect.left),
        top: event.clientY - (stageRect?.top ?? rect.top),
        // 展示倍率：input 字号 = 自然字号 × 倍率，缩放后与导出位置大小一致
        scale: rect.width / canvas.width,
        color,
        width: thickness,
        value: '',
      };
      textDraftRef.current = draft;
      setTextDraft(draft);
      return;
    }
    // 有选中先试角把手：抓住就进入缩放手势（任何非文字工具下都能直接发起，
    // 不必先切「选择移动」——用户实测缩放入口藏得太深）
    const selectedIndex = selectedRef.current;
    if (selectedIndex !== null) {
      const cornerIndex = handleIndexAt(point);
      const frame = cornerIndex >= 0 ? selectionFrameOf(selectedIndex) : null;
      if (cornerIndex >= 0 && frame) {
        event.currentTarget.setPointerCapture(event.pointerId);
        resizeRef.current = {
          index: selectedIndex,
          anchor: frame.rawCorners[3 - cornerIndex],
          handOff: {
            x: frame.corners[cornerIndex].x - frame.rawCorners[cornerIndex].x,
            y: frame.corners[cornerIndex].y - frame.rawCorners[cornerIndex].y,
          },
          base: { width: frame.bounds.width, height: frame.bounds.height },
          baseWidth: frame.shape.width,
          before: cloneShapes(shapesRef.current),
          moved: false,
        };
        if (canvasRef.current) {
          canvasRef.current.style.cursor = cornerIndex === 0 || cornerIndex === 3 ? 'nwse-resize' : 'nesw-resize';
        }
        return;
      }
    }
    if (tool === 'select') {
      // 修改模式：命中就选中并抓住准备拖动；点空处只取消选中。
      // 这里不 preventDefault——焦点该离开文字框，让 blur 去提交
      const hit = topmostShapeAt(point);
      selectedRef.current = hit;
      if (hit === null) {
        redraw();
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { last: point, before: cloneShapes(shapesRef.current), moved: false };
      if (canvasRef.current) canvasRef.current.style.cursor = 'move';
      redraw();
      return;
    }
    // 画笔 / 矩形：压中已画内容就先选上并允许拖动——不切「选择移动」也能点选移位；
    // 点空处才取消选中、落新的一笔
    const hit = topmostShapeAt(point);
    if (hit !== null) {
      selectedRef.current = hit;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { last: point, before: cloneShapes(shapesRef.current), moved: false };
      if (canvasRef.current) canvasRef.current.style.cursor = 'move';
      redraw();
      return;
    }
    selectedRef.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === 'rect') {
      draftRef.current = { kind: 'rect', color, width: thickness, from: point, to: point };
    } else {
      draftRef.current = { kind: 'pen', color, width: thickness, points: [point] };
    }
    redraw();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      const point = toNatural(event);
      const index = selectedRef.current;
      const shape = index === null ? null : shapesRef.current[index];
      if (point && shape) shiftShape(shape, point.x - drag.last.x, point.y - drag.last.y);
      if (point) {
        drag.moved = drag.moved || point.x !== drag.last.x || point.y !== drag.last.y;
        drag.last = point;
      }
      redraw();
      return;
    }
    const resize = resizeRef.current;
    if (resize) {
      // 缩放：矩形直接换对角；自由线各点相对锚点仿射；文字只按高度比放大字号，
      // 宽度交给 measureText 自己量——三条链路共用「角把手 → 原始角」的映射
      const point = toNatural(event);
      const shape = shapesRef.current[resize.index];
      if (point && shape) {
        const target = { x: point.x - resize.handOff.x, y: point.y - resize.handOff.y };
        const fx = resize.base.width > 0.5 ? (target.x - resize.anchor.x) / resize.base.width : 1;
        const fy = resize.base.height > 0.5 ? (target.y - resize.anchor.y) / resize.base.height : 1;
        if (shape.kind === 'rect') {
          shape.from = { ...resize.anchor };
          shape.to = { ...target };
          shape.width = clampThickness(resize.baseWidth * Math.max(fx, fy));
        } else if (shape.kind === 'pen') {
          shape.points = shape.points.map((p) => ({
            x: resize.anchor.x + (p.x - resize.anchor.x) * fx,
            y: resize.anchor.y + (p.y - resize.anchor.y) * fy,
          }));
          shape.width = clampThickness(resize.baseWidth * Math.max(fx, fy));
        } else {
          shape.width = clampThickness(resize.baseWidth * fy);
        }
        resize.moved = true;
      }
      redraw();
      return;
    }
    // 悬停光标反馈：角把手给缩放光标；压中 shape 给 move（画笔/矩形下也提示抓得动）；
    // 都扑空清掉内联光标，交回 data-tool 的 CSS 规则
    if (tool === 'select' || !draftRef.current) {
      const point = toNatural(event);
      if (tool !== 'text' && point && selectedRef.current !== null) {
        const cornerIndex = handleIndexAt(point);
        if (cornerIndex >= 0) {
          if (canvasRef.current) {
            canvasRef.current.style.cursor = cornerIndex === 0 || cornerIndex === 3 ? 'nwse-resize' : 'nesw-resize';
          }
          return;
        }
      }
      const hit = point ? topmostShapeAt(point) : null;
      const canMove = hit !== null && (
        tool !== 'text' || shapesRef.current[hit].kind === 'text'
      );
      if (canvasRef.current) canvasRef.current.style.cursor = canMove ? 'move' : '';
      if (tool === 'select') return;
    }
    const draft = draftRef.current;
    if (!draft) return;
    const point = toNatural(event);
    if (!point) return;
    if (draft.kind === 'pen') draft.points.push(point);
    else if (draft.kind === 'rect') draft.to = point;
    redraw();
  };

  const handlePointerUp = () => {
    const resize = resizeRef.current;
    if (resize) {
      resizeRef.current = null;
      // 缩放落定：真的拖过才压一份「缩放前」快照，单击把手不白吃一步撤销
      if (resize.moved) commitHistory(resize.before);
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      // 拖动落定：真的移动过才压一份「位置还没动」的快照，Ctrl+Z 撤回的是拖动前那一版
      if (drag.moved) commitHistory(drag.before);
      return;
    }
    const draft = draftRef.current;
    if (!draft) return;
    draftRef.current = null;
    // 矩形至少要拖出一点位移才计入历史，避免误单击留下一个看不见的 shape
    if (draft.kind === 'rect' && Math.abs(draft.to.x - draft.from.x) + Math.abs(draft.to.y - draft.from.y) < 1) {
      redraw();
      return;
    }
    commitShape(draft);
  };

  /** 指针离开画布：清掉悬停态写在内联上的光标。拖动中不理会——指针已捕获，事件还会继续来。 */
  const handlePointerLeave = () => {
    if (dragRef.current) return;
    if (canvasRef.current) canvasRef.current.style.cursor = '';
  };

/** 拖动 / 缩放被打断（pointercancel）：回到手势前的快照，别留半截在图上。 */
  const handlePointerCancel = () => {
    const resize = resizeRef.current;
    if (resize) {
      resizeRef.current = null;
      shapesRef.current = resize.before;
      redraw();
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    shapesRef.current = drag.before;
    redraw();
  };

  /** 提交文字：Enter 或 blur 时调用，空文本不入库。 */
  const commitText = () => {
    const draft = textDraftRef.current;
    if (!draft) return;
    textDraftRef.current = null;
    setTextDraft(null);
    const value = draft.value.trim();
    if (!value) return;
    commitShape({ kind: 'text', color: draft.color, width: draft.width, point: draft.point, text: value });
  };

  /** 取消文字：Esc 调用，直接丢弃不入库。 */
  const cancelText = () => {
    textDraftRef.current = null;
    setTextDraft(null);
  };

  const switchTool = (next: AnnotateTool) => {
    if (next === tool) return;
    // 切走时丢弃正在画的草稿重绘干净；打开中的文字浮层在这里显式提交——
    // 元素卸载不保证触发 blur，靠它会把打好的字弄丢
    commitText();
    draftRef.current = null;
    dragRef.current = null;
    resizeRef.current = null;
    selectedRef.current = null;
    // 清掉悬停态写在内联上的光标，交回给 data-tool 的 CSS 规则
    if (canvasRef.current) canvasRef.current.style.cursor = '';
    setTool(next);
    redraw();
  };

  const handleUndo = () => {
    const previous = pastRef.current[pastRef.current.length - 1];
    if (!previous) return;
    futureRef.current = [...futureRef.current, shapesRef.current];
    pastRef.current = pastRef.current.slice(0, -1);
    shapesRef.current = previous;
    selectedRef.current = null;
    setCanUndo(pastRef.current.length > 0);
    setCanRedo(true);
    redraw();
  };

  const handleRedo = () => {
    const next = futureRef.current[futureRef.current.length - 1];
    if (!next) return;
    pastRef.current = [...pastRef.current, shapesRef.current];
    futureRef.current = futureRef.current.slice(0, -1);
    shapesRef.current = next;
    selectedRef.current = null;
    setCanUndo(true);
    setCanRedo(futureRef.current.length > 0);
    redraw();
  };

  /** 撤销 / 重做快捷键：Ctrl(Z) / Cmd+Z 撤回，Shift 加它是重做，Ctrl+Y 同义。
   *  文字浮层与粗细数字框里不抢——那里是浏览器自己的输入撤销，带输入类标签的目标一概放过。
   *  画布 Ctrl+Z（撤回整理）那侧也已加同样的输入守卫 + 标注器打开时整条跳过，不会双重响应。 */
  useEffect(() => {
    if (!ready || loadError) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const target = event.target as HTMLElement | null;
        if (target?.closest('input, textarea, [contenteditable="true"], .hb-chat-panel')) return;
        event.preventDefault();
        event.stopPropagation();
        const selectedIndex = selectedRef.current;
        if (selectedIndex === null || !shapesRef.current[selectedIndex]) return;
        commitHistory(cloneShapes(shapesRef.current));
        shapesRef.current = shapesRef.current.filter((_, index) => index !== selectedIndex);
        selectedRef.current = null;
        redraw();
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      event.preventDefault();
      if (key === 'y' || (key === 'z' && event.shiftKey)) handleRedo();
      else handleUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const submit = async (action: 'save' | 'generate') => {
    const canvas = canvasRef.current;
    if (!canvas || !ready || loadError || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      commitText();
      redraw(false);
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL('image/png');
      } finally {
        redraw();
      }
      if (action === 'generate') await onGenerate(dataUrl, prompt.trim());
      else await onSave(dataUrl);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '标注图提交失败，请重试');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="hb-modal-overlay" role="dialog" aria-label="图片标注">
      <div className="image-annotator" style={{ '--annotator-aspect': aspect } as CSSProperties}>
        <div className="image-annotator-bar" role="toolbar" aria-label="标注工具">
          <button
            type="button"
            className="image-annotator-exit"
            onClick={onCancel}
            disabled={submitting}
            title="退出标注：不保存，返回画布"
            aria-label="退出标注：不保存，返回画布"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
          <span className="image-annotator-divider" aria-hidden="true" />
          <div className="image-annotator-tools" role="group" aria-label="标注工具切换">
            <button
              type="button"
              className={`image-annotator-tool ${tool === 'select' ? 'active' : ''}`}
              aria-pressed={tool === 'select'}
              aria-label="选择移动"
              title="选择移动：点选已画的线 / 框 / 文字，按住拖动移位，Esc 取消选中"
              onClick={() => switchTool('select')}
            >
              <SelectIcon />
            </button>
            <button
              type="button"
              className={`image-annotator-tool ${tool === 'pen' ? 'active' : ''}`}
              aria-pressed={tool === 'pen'}
              aria-label="画笔"
              title="画笔：按住自由画线"
              onClick={() => switchTool('pen')}
            >
              <PenIcon />
            </button>
            <button
              type="button"
              className={`image-annotator-tool ${tool === 'rect' ? 'active' : ''}`}
              aria-pressed={tool === 'rect'}
              aria-label="矩形"
              title="矩形：拖拽画矩形框"
              onClick={() => switchTool('rect')}
            >
              <RectIcon />
            </button>
            <button
              type="button"
              className={`image-annotator-tool ${tool === 'text' ? 'active' : ''}`}
              aria-pressed={tool === 'text'}
              aria-label="文字"
              title="文字：点击画布落字，Enter 确认、Esc 取消"
              onClick={() => switchTool('text')}
            >
              <TextIcon />
            </button>
          </div>
          <span className="image-annotator-divider" aria-hidden="true" />
          {/* 颜色只留一个当前色钮 + 下拉箭头，五色收进色板里 */}
          <div className="image-annotator-color-picker" ref={colorPickerRef}>
            <button
              type="button"
              className="image-annotator-color-trigger"
              aria-haspopup="true"
              aria-expanded={colorOpen}
              aria-label={`颜色：${PALETTE_NAMES[PALETTE.indexOf(color)] ?? '未设置'}`}
              title={`颜色：${PALETTE_NAMES[PALETTE.indexOf(color)] ?? '未设置'}，点击切换`}
              onClick={() => setColorOpen((open) => !open)}
            >
              <span className="image-annotator-color-dot" style={{ background: color }} />
              <ChevronDownIcon />
            </button>
            {colorOpen ? (
              <div className="image-annotator-color-pop" role="radiogroup" aria-label="颜色">
                {PALETTE.map((item, index) => (
                  <button
                    key={item}
                    type="button"
                    role="radio"
                    aria-checked={color === item}
                    aria-label={PALETTE_NAMES[index]}
                    className={`image-annotator-color ${color === item ? 'active' : ''}`}
                    style={{ background: item }}
                    onClick={() => {
                      setColor(item);
                      setColorOpen(false);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <label className="image-annotator-thickness">
            <span>粗细</span>
            <input
              type="number"
              min={1}
              max={16}
              step={1}
              value={thicknessText}
              aria-label="线条粗细"
              title="粗细：1–16"
              onChange={(event) => {
                const raw = event.target.value;
                setThicknessText(raw);
                const value = Number(raw);
                // 打一半（空串 / 超范围）先留在框里，只把合法值同步给工具
                if (Number.isFinite(value) && value >= 1 && value <= 16) setThickness(Math.round(value));
              }}
              onBlur={() => {
                const value = Number(thicknessText);
                if (Number.isFinite(value)) {
                  const clamped = clampThickness(value);
                  setThickness(clamped);
                  setThicknessText(String(clamped));
                } else {
                  setThicknessText(String(thickness));
                }
              }}
            />
          </label>
          {/* 右侧动作区：撤销 / 重做 / 保存 / 生成。margin-left:auto 把它们推到另一头，
              左边的粗细滑杆吃剩下的空隙，窄了整组换行也不会被拆散 */}
          <div className="image-annotator-actions">
            <button
              type="button"
              className="image-annotator-action"
              onClick={handleUndo}
              disabled={!canUndo}
              title="撤销：返回上一步"
              aria-label="撤销：返回上一步"
            >
              <UndoIcon />
            </button>
            <button
              type="button"
              className="image-annotator-action"
              onClick={handleRedo}
              disabled={!canRedo}
              title="重做：返回上一步的返回上一步"
              aria-label="重做：返回上一步的返回上一步"
            >
              <RedoIcon />
            </button>
            <button
              type="button"
              className="image-annotator-action image-annotator-label"
              onClick={() => void submit('save')}
              disabled={!ready || Boolean(loadError) || submitting}
              title="保存图片：把标注合成一张图挂回当前节点"
              aria-label="保存图片"
            >
              保存图片
            </button>
          </div>
        </div>
        <div className="image-annotator-stage">
          {loadError ? <p className="image-annotator-error">{loadError}</p> : null}
          <canvas
            ref={canvasRef}
            className="image-annotator-canvas"
            data-tool={tool}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
          />
          {textDraft ? (
            <input
              ref={textInputRef}
              className="image-annotator-text-input"
              autoFocus
              value={textDraft.value}
              aria-label="标注文字"
              placeholder="输入文字，Enter 确认"
              style={{
                left: textDraft.left,
                top: textDraft.top,
                color: textDraft.color,
                fontSize: `${fontSizeFor(textDraft.width) * textDraft.scale}px`,
              }}
              onChange={(event) => {
                const next = event.target.value;
                setTextDraft((current) => (current ? { ...current, value: next } : current));
                if (textDraftRef.current) textDraftRef.current = { ...textDraftRef.current, value: next };
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitText();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelText();
                }
              }}
              onBlur={commitText}
            />
          ) : null}
        </div>
        <form
          className="image-annotator-composer"
          aria-label="AI 标注生图"
          aria-busy={submitting}
          onSubmit={(event) => {
            event.preventDefault();
            void submit('generate');
          }}
        >
          <div className="image-annotator-composer-row">
            <span className="image-annotator-ai-glyph" aria-hidden="true"><AiGlyphIcon /></span>
            <textarea
              ref={promptRef}
              className="image-annotator-prompt"
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="描述想修改的地方，结合标注直接生成…"
              aria-label="标注修改描述"
              aria-describedby={submitError ? 'image-annotator-submit-error' : undefined}
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit('generate');
                }
              }}
            />
            <button
              type="submit"
              className="image-annotator-generate"
              disabled={!ready || Boolean(loadError) || submitting}
              title={submitting ? '正在提交' : '按标注和描述直接生成（Enter）'}
              aria-label={submitting ? '正在提交' : '直接生成'}
            >
              <SendGlyphIcon />
            </button>
          </div>
          {submitError ? <p id="image-annotator-submit-error" className="image-annotator-error" role="alert">{submitError}</p> : null}
        </form>
      </div>
    </div>
  );
}

/** 选择移动：实心指针，跟前三个绘制工具的形状语言区分开。 */
function SelectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 3.5 18.5 11l-5.6 1.5-1.9 5.5L6 3.5z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 画笔：笔尖压线。 */
function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 20c3.2 0 5.3-1.3 6.9-2.9l8.3-8.3a2 2 0 0 0-2.8-2.8L8.1 14.3C6.5 15.9 4 17 4 20z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.5 6.5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 矩形：实线框——与画布上画出来的矩形框同语言。 */
function RectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="6" width="16" height="12" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

/** 文字：大写 T。 */
function TextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6h12M12 6v12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** 撤销：回退箭头。 */
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 5 4 9l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 9h9a6 6 0 0 1 6 6v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 重做：回退的镜像，向前箭头。 */
function RedoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M16 5l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 9h-9a6 6 0 0 0-6 6v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 色板下拉箭头：收起 / 翻开。 */
function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
