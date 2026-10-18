import { BaseEdge, getBezierPath, Position, useInternalNode, type EdgeProps } from '@xyflow/react';
import { nodeBoxFor } from '@/lib/aspect';
import type { CanvasNodeData } from '@/types';

/** 剪刀落点：节点卡片边框外 92px。
 *  从边框往外数，这片区域依次占着三样东西：「+」连接把手（边框外 40px，hover 柔光伸到 ~61px）、
 *  xyflow 的端点重抓取圆（把手 ± reconnectRadius=16，占 40~72px，渲染在边组件之后，
 *  transparent fill 照样吃指针事件）。剪刀必须退到 72px 之外：再加底板半径 13 与 7px 余量，
 *  定在 96px——既不和把手/重抓取区叠，也还贴在"线条两端"的语感上。 */
const CUT_FROM_BORDER = 96;
/** 落点距边框的下限：把手中心在边框外 28px、端点重抓取圈半径 16（占到 44px），
 *  底板半径 13，中心必须退到 57px 之外才不被那个透明圆压住；再留 16px 余量定在 73px。 */
export const CUT_MIN_REACH = 73;
/** 两个底板之间的最小间隔（直径 26 + 4px） */
export const CUT_PAIR_SPACING = 30;
/** 线条过短（两张卡片几乎贴脸）时的沿弧上限：两端各占 42%，两个剪刀永不叠一起 */
const CUT_MAX_T = 0.42;
/** 单块剪刀的落点：曲线中点。两端净空不够时用它兜底，见 cutGeometry 里的 singleCut */
const CUT_MID_T = 0.5;
/** 拿不到节点盒子时的退路：从线条起点（= 边框外 16px）沿弧 76px，等效落在 92px 那一档 */
const CUT_FALLBACK_OFFSET = 76;
/** 单块剪刀兜底时扫曲线用的两个几何量（都和把手圈有关，实测值）：
 *  「+」把手中心在卡片边框外 28px（inset:-40px + 宽 24px 的一半）；
 *  端点重抓取圈半径 16px、剪刀底板半径 13px，所以底板中心离把手中心至少要 HANDLE_CLEAR。 */
const HANDLE_OUT = 28;
const HANDLE_CLEAR = 33;
const CUT_PLATE_R = 13;
/** 命中圈比可见底板大一圈：以前 r=11 整个 22px 就是点击区，太难点中 */
const CUT_HIT_R = 20;

export default function FlowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  interactionWidth,
  data,
}: EdgeProps) {
  const onCut = (data?.onCut as ((edgeId: string) => void) | undefined) || undefined;
  /* 剪刀要落在「卡片边框外固定距离」处，得知道两端节点的盒子——和 CanvasEdge 同一个取法
     （读 cardWidth / aspect 推导的宽高，不读 React Flow 的 measured：它会停在 composer 期）。 */
  const sourceNode = useInternalNode(String(source));
  const targetNode = useInternalNode(String(target));
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const edgeKey = String(id);
  const gradientId = `canvas-edge-beam-${edgeKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  /* getBezierPath 只回 path 串，这里把控制点解出来：剪刀落点（边框外 ~96px）要用。
     解不开就退化成 props 端点直线插值，功能不丢。 */
  const cubicMatch = edgePath.match(
    /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*C\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)/,
  );
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const cubicAt = (a: number, b: number, c: number, d: number, t: number) => {
    const mt = 1 - t;
    return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
  };
  const round1 = (value: number) => Math.round(value * 10) / 10;
  /** 三次曲线的四个顶点（[x, y] ×4）：p0 起点 → p3 终点 */
  const curve = (() => {
    if (cubicMatch) {
      const nums = cubicMatch.slice(1).map(Number);
      // 少解析出一个数就会把 undefined 塞进控制点，坐标静默变 NaN（剪小组件飘到原点）。
      // 这里只认 8 个都有效的情况，否则整段退回 props 直线插值。
      if (nums.length === 8 && nums.every((value) => Number.isFinite(value))) {
        return [
          [nums[0], nums[1]], [nums[2], nums[3]], [nums[4], nums[5]], [nums[6], nums[7]],
        ] as Array<[number, number]>;
      }
    }
    return [
      [sourceX, sourceY], [sourceX, sourceY], [targetX, targetY], [targetX, targetY],
    ] as Array<[number, number]>;
  })();
  const [p0x, p0y] = curve[0];
  const [p1x, p1y] = curve[1];
  const [p2x, p2y] = curve[2];
  const [p3x, p3y] = curve[3];
  const cutGeometry = (() => {
    if (!onCut) return null;
    const pointAt = (t: number) => ({
      x: cubicAt(p0x, p1x, p2x, p3x, t),
      y: cubicAt(p0y, p1y, p2y, p3y, t),
    });
    // 弧长近似用直线距，够定退路档位的 t 了
    const straight = Math.max(Math.hypot(p3x - p0x, p3y - p0y), 1);
    /** 贝塞尔在某一轴上的取值：剪刀锚点解算用 */
    const axisCurve = (axis: 'x' | 'y') => (t: number) => (axis === 'x'
      ? cubicAt(p0x, p1x, p2x, p3x, t)
      : cubicAt(p0y, p1y, p2y, p3y, t));
    /** 沿曲线找「该轴坐标首次到达 anchor」的 t：
     *  源端从 t=0 往外扫、目标端从 t=1 往回扫，区间上限 CUT_MAX_T 保证两端剪刀永不叠；
     *  线短到扫不到（卡片贴脸）就落在区间端点上。 */
    const scanForAnchor = (axis: 'x' | 'y', anchor: number, forward: boolean) => {
      const valueAt = axisCurve(axis);
      const samples = 64;
      let prevT = forward ? 0 : 1;
      for (let index = 1; index <= samples; index += 1) {
        const t = forward
          ? (index / samples) * CUT_MAX_T
          : 1 - (index / samples) * CUT_MAX_T;
        const reached = forward ? valueAt(t) >= anchor : valueAt(t) <= anchor;
        if (reached) {
          let lo = Math.min(prevT, t);
          let hi = Math.max(prevT, t);
          for (let step = 0; step < 24; step += 1) {
            const mid = (lo + hi) / 2;
            const hit = forward ? valueAt(mid) >= anchor : valueAt(mid) <= anchor;
            if (hit === forward) hi = mid;
            else lo = mid;
          }
          return forward ? hi : lo;
        }
        prevT = t;
      }
      return forward ? CUT_MAX_T : 1 - CUT_MAX_T;
    };
    /** 单侧信息：边框坐标、朝外方向、所在轴（Top/Bottom 走 y，其余走 x） */
    const cutSideInfo = (side: 'source' | 'target') => {
      const node = side === 'source' ? sourceNode : targetNode;
      const position = side === 'source' ? sourcePosition : targetPosition;
      const axis: 'x' | 'y' = position === Position.Top || position === Position.Bottom ? 'y' : 'x';
      const outward = position === Position.Right || position === Position.Bottom ? 1 : -1;
      const box = node ? nodeBoxFor(node.data as CanvasNodeData) : null;
      const absolute = node?.internals.positionAbsolute;
      const border = box && absolute
        ? (axis === 'x'
          ? (position === Position.Right ? absolute.x + box.width : absolute.x)
          : (position === Position.Bottom ? absolute.y + box.height : absolute.y))
        : 0;
      // 把手中心：沿朝外方向离边框 28px，横向（垂直轴）落在节点中点——把手永远是这么排的
      const across = box && absolute
        ? (axis === 'x' ? absolute.y + box.height / 2 : absolute.x + box.width / 2)
        : 0;
      const along = border + outward * HANDLE_OUT;
      return {
        axis,
        outward,
        border,
        hasBox: Boolean(box && absolute),
        forward: side === 'source',
        handle: box && absolute
          ? (axis === 'x' ? { x: along, y: across } : { x: across, y: along })
          : null,
      };
    };
    const sides = [cutSideInfo('source'), cutSideInfo('target')];
    /** 两端相向（源右 / 目标左，最常见）时，落点按对侧边框往中点收：
     *  两张卡片贴脸时两个剪刀不至于叠在一起，最近距离 = 底板直径 + 4px。
     *  收到 CUT_MIN_REACH 以下（卡片贴脸，或是别处搬来的窄间距节点）
     *  时，两端都落不进「把手圈 / 端点重抓取圈」之外的净空——这时不整条线裸奔，
     *  退化成「曲线中点一块剪刀」（见下面的 singleCut）。 */
    const facing = sides[0].axis === sides[1].axis && sides[0].outward !== sides[1].outward;
    const gap = facing ? Math.abs(sides[1].border - sides[0].border) : Number.POSITIVE_INFINITY;
    const reach = Math.min(CUT_FROM_BORDER, (gap - CUT_PAIR_SPACING) / 2);
    const singleCut = reach < CUT_MIN_REACH;
    /** 单侧剪刀：锚点 = 卡片边框外 reach，节点盒子拿不到时退回沿弧偏移。
     *  override 只在 singleCut 分支用：强制落点 t、红色提示段改成整条线。 */
    const cutAt = (side: 'source' | 'target', override?: { t: number; all: boolean }) => {
      const info = side === 'source' ? sides[0] : sides[1];
      const forward = info.forward;
      let t: number;
      if (override) {
        t = override.t;
      } else if (info.hasBox) {
        t = scanForAnchor(info.axis, info.border + info.outward * reach, forward);
      } else {
        const fallback = Math.min(CUT_MAX_T, CUT_FALLBACK_OFFSET / straight);
        t = forward ? fallback : 1 - fallback;
      }
      const at = pointAt(t);
      // de Casteljau 切出该侧的子路径，悬停剪刀时给这一头染红
      const q1x = lerp(p0x, p1x, t);
      const q1y = lerp(p0y, p1y, t);
      const q2x = lerp(lerp(p0x, p1x, t), lerp(p1x, p2x, t), t);
      const q2y = lerp(lerp(p0y, p1y, t), lerp(p1y, p2y, t), t);
      const r1x = lerp(lerp(p1x, p2x, t), lerp(p2x, p3x, t), t);
      const r1y = lerp(lerp(p1y, p2y, t), lerp(p2y, p3y, t), t);
      const r2x = lerp(p2x, p3x, t);
      const r2y = lerp(p2y, p3y, t);
      const head = `M ${round1(p0x)} ${round1(p0y)} C ${round1(q1x)} ${round1(q1y)} ${round1(q2x)} ${round1(q2y)} ${round1(at.x)} ${round1(at.y)}`;
      const tail = `M ${round1(at.x)} ${round1(at.y)} C ${round1(r1x)} ${round1(r1y)} ${round1(r2x)} ${round1(r2y)} ${round1(p3x)} ${round1(p3y)}`;
      // 单块剪刀时整条线一起染红：中点分不出"剪的是哪一头"，全红更像一次干净利落的剪断
      const segment = override?.all ? edgePath : (forward ? head : tail);
      return {
        end: override ? 'mid' : side,
        x: round1(at.x),
        y: round1(at.y),
        segment,
      };
    };
    // 兜底扫点：沿整条曲线采样，取「离两端把手圈最远」的那个点。
    // 侧向排布、上下错开的卡片，曲线中段落在两卡的竖向空档里，离把手圈很远；
    // 真正贴脸的横线扫不出干净点（整条线都在两个把手圈之间），此时返回 null——
    // 宁可没有剪刀，也不能把它压在「+」把手上（那正是用户点名不要的）。
    // 节点盒子拿不到（obstacles 空）时退回几何中点。
    const obstacles = sides.map((side) => side.handle).filter((handle) => handle !== null);
    const fallbackT = (() => {
      if (obstacles.length === 0) return CUT_MID_T;
      let best = { t: -1, score: -1 };
      for (let index = 1; index < 48; index += 1) {
        const t = index / 48;
        const at = pointAt(t);
        let score = Number.POSITIVE_INFINITY;
        for (const handle of obstacles) score = Math.min(score, Math.hypot(at.x - handle.x, at.y - handle.y));
        if (score > best.score) best = { t, score };
      }
      // score 是「底板中心到把手中心」的距离，减掉 HANDLE_CLEAR 才是真正可用的余量
      return best.score - HANDLE_CLEAR >= 0 ? best.t : null;
    })();
    if (singleCut) {
      if (fallbackT === null || straight < CUT_PAIR_SPACING) return null;
      return [cutAt('source', { t: fallbackT, all: true })];
    }
    return [cutAt('source'), cutAt('target')];
  })();
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const seed = hashString(edgeKey);
  const duration = (5.6 + (seed % 1200) / 1000) * 1.5;
  const phase = ((seed >>> 3) % 1000) / 1000 * duration;
  const beamHalfLength = 0.4;
  const travelPadding = 0.26;
  const startCenter = -travelPadding;
  const endCenter = 1 + travelPadding;
  const startX1 = sourceX + dx * (startCenter - beamHalfLength);
  const startY1 = sourceY + dy * (startCenter - beamHalfLength);
  const startX2 = sourceX + dx * (startCenter + beamHalfLength);
  const startY2 = sourceY + dy * (startCenter + beamHalfLength);
  const endX1 = sourceX + dx * (endCenter - beamHalfLength);
  const endY1 = sourceY + dy * (endCenter - beamHalfLength);
  const endX2 = sourceX + dx * (endCenter + beamHalfLength);
  const endY2 = sourceY + dy * (endCenter + beamHalfLength);
  const durationValue = `${duration.toFixed(2)}s`;
  const beginValue = `-${phase.toFixed(2)}s`;

  return (
    <>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={sourceX}
          y1={sourceY}
          x2={targetX}
          y2={targetY}
          spreadMethod="pad"
        >
          <stop offset="0%" stopColor="var(--color-text-secondary)" stopOpacity="0" />
          <stop offset="38%" stopColor="var(--color-text-secondary)" stopOpacity="0.18" />
          <stop offset="50%" stopColor="var(--color-text-primary)" stopOpacity="1" />
          <stop offset="62%" stopColor="var(--color-text-secondary)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-text-secondary)" stopOpacity="0" />
          <animate attributeName="x1" values={`${startX1};${endX1}`} dur={durationValue} begin={beginValue} repeatCount="indefinite" />
          <animate attributeName="y1" values={`${startY1};${endY1}`} dur={durationValue} begin={beginValue} repeatCount="indefinite" />
          <animate attributeName="x2" values={`${startX2};${endX2}`} dur={durationValue} begin={beginValue} repeatCount="indefinite" />
          <animate attributeName="y2" values={`${startY2};${endY2}`} dur={durationValue} begin={beginValue} repeatCount="indefinite" />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        /* 命中区下限 24px：整条线都是剪刀的触发面，细线很难悬停稳定 */
        interactionWidth={Math.max(interactionWidth ?? 0, 24)}
      />
      <path
        className="canvas-edge-beam canvas-edge-beam-glow"
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        aria-hidden="true"
      />
      <path
        className="canvas-edge-beam"
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        aria-hidden="true"
      />
      {/* 线条两端的断开剪刀：指针进入线条命中区（整条线都是触发面）才浮出，点一下即断连。
          站位在边框外 ~64px，避开「+」连接 icon 和端点重抓取区；
          悬停剪刀时对应那一头线段染红，明示"剪的是这头"，与选中与否无关。
          与两端拖拽断开互补——拖端点适合改接，剪刀适合"就是不要这条线了" */}
      {cutGeometry ? (
        <>
          {cutGeometry.map((cut) => (
            <g
              key={cut.end}
              className={`image-edge-cut image-edge-cut-${cut.end}`}
              transform={`translate(${cut.x} ${cut.y})`}
              onClick={(event) => {
                event.stopPropagation();
                onCut?.(edgeKey);
              }}
              role="button"
              tabIndex={-1}
              aria-label="断开连接"
            >
              <title>断开连接</title>
              {/* 红色提示线段：沿这条线从节点到剪刀，transform 抵消 group 位移回到线条坐标系 */}
              <path className="image-edge-cut-segment" transform={`translate(${-cut.x} ${-cut.y})`} d={cut.segment} />
              <circle className="image-edge-cut-hit" r={CUT_HIT_R} fill="transparent" />
              <circle className="image-edge-cut-plate" r={CUT_PLATE_R} />
              <g className="image-edge-cut-icon">
                <g transform="translate(-6 -6) scale(0.5)">
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M20 4 8.12 15.88" />
                  <path d="M14.47 14.48 20 20" />
                  <path d="M8.12 8.12 12 12" />
                </g>
              </g>
            </g>
          ))}
        </>
      ) : null}
    </>
  );
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
