import { useEffect, useRef } from 'react';
import './RunningMatrixField.css';

/* ── 生成矩阵（RunningMatrixField）───────────────────────────────────────────
   「生成中」卡片里那层点阵的升级版：静止时是一片常驻小点阵（每个点的初始大小在建点时
   随机定好，幂律分布、之后不变）；影响圆（跟着涟漪圆心走）扫到谁就把谁等比撑大成形状；
   圆环波以 sin(π·X) 推过去，环过之后回到影响圆的量级。

   生成节点（canvas/FlowImageNode.tsx）运行态用 <RunningMatrix inline
   params={MATRIX_DEFAULTS} mode="ripple" />；参数已定稿（用户 9/25 第二版取值），
   MATRIX_DEFAULTS 是单一来源。

   对齐参考站 AnimShapeField（vuesax.com/a/anim-shape-field，组件源码逐行核对过）：
   · 配色 = 原版 17 色盘逐值对齐：10 纯色 + 7 双色径向渐变（hex 存 tokens.css 的
     --matrix-* 变量，运行时读取）；每点开局从 17 种里等概率挑一个 —— 10/17 纯色、
     7/17 渐变，与站点同比例；
   · 形状 = 参考站那三种：圆 / 药丸 / 多角星，星形双倍权重（站点是 star 占一半）；
     星形 4–10 角、内径比 0.1–0.5 随机，药丸两端半圆，几何比例按站点的形状间关系换算；
   · 初始大小随机（sizeJitter，默认 0.6）建点时定死；放大是全局统一倍率、等比缩放；
   · 影响圆扫入某个点的瞬间重掷它的角度 / 形态（参考站 rollShape，不换大小）；
   · 影响圆与圆环的放量都走指数平滑：放大 0.5s、缩小 0.6s，按真实帧间隔折算；
     圆环不瞬跳，波前扫过是一段平滑起伏（非对称手感，站点同款）；
   · 圆环波 = 参考站点击波纹的原版数学：环带 [ringR ± width] 内 sin(π·X)，是一对
     以波前为中心对称的双峰；波与影响圆取大（max(d, S)），不是叠加。

   实现说明：用 canvas 一个画布画完所有点，而不是几百个 DOM 节点。每个点都要
   「随机取色 + 随机形状 + 按距离做相位」，DOM 方案既贵又难维护；canvas 一次 clear + 批量
   路径才是这个量级（上千点）的正解。多个节点同时生成时各自一块小画布，点数随面积降。

   令牌纪律：颜色一律运行时从 CSS 变量读（纯色、渐变两端都是），不在这边写死色值。 */

export type MatrixMode = 'static' | 'wave' | 'burst' | 'loop' | 'ripple';

export interface MatrixParams {
  /** 点阵间距 px */
  gap: number;
  /** 基点直径 px */
  dot: number;
  /** 大小随机 0–1：默认 0（影响圆内一律同等放大，不做大小随机）；1 = 幂律散布 */
  sizeJitter: number;
  /** 呼吸一圈 ms */
  breathe: number;
  /** 单点放大倍率（波峰时的直径倍数） */
  amp: number;
  /** 波纹相位强度 0–1：离中心越远越晚呼吸，于是看起来从中心向外扩散 */
  ripple: number;
  /** 中心放大 0–1：越靠中心的点基础越大 */
  centerBoost: number;
  /** 彩色浓度 0–1：0 = 全白点（旧点阵），1 = 五色随机 */
  colorMix: number;
  /** 形状概率 0–1：撑大时长出形状的点占比 */
  shapeMix: number;
  /** 随机相位 0–1：每个点额外错开多少，打散机械感 */
  jitter: number;
  /** 整段循环 ms（爆发 / 整段循环模式的一圈） */
  cycle: number;
  /** 涟漪一圈 ms（四个起点走完一遍：中心 → 右上 → 中心 → 左侧） */
  rippleCycle: number;
  /** 影响圆半径（占画布宽度比例）：圆内的点被常驻放大，圆外保持默认点阵 */
  zoneR: number;
  /** 圆环波速度 px/s：每个角释放一次、沿半径向外传播 */
  waveSpeed: number;
  /** 波前宽 px：圆环起伏带宽度，带内以 sin(π·t) 从 0→1→0 */
  waveWidth: number;
}

/** 默认值 = 参考图那一档的观感；滑块默认值也取这里，方便「恢复出厂」时对照 */
/** 默认值 = 用户 9/25 定稿的第二版取值（取色台已拆，值不再回改）。
   涟漪一圈 21000ms：四个角各放一次波，到位即放、放完即走、无静场间隔，比 12s 那版松弛。 */
export const MATRIX_DEFAULTS: MatrixParams = {
  gap: 11,
  dot: 1.4,
  sizeJitter: 0.6,
  breathe: 1300,
  amp: 6,
  ripple: 0.85,
  centerBoost: 0.6,
  colorMix: 1,
  shapeMix: 1,
  jitter: 0.3,
  cycle: 12000,
  rippleCycle: 21000,
  zoneR: 0.5,
  waveSpeed: 200,
  waveWidth: 160,
};

export const MATRIX_MODES: { id: MatrixMode; label: string }[] = [
  { id: 'static', label: '静止矩阵' },
  { id: 'wave', label: '呼吸波纹' },
  { id: 'ripple', label: '涟漪扩散' },
  { id: 'burst', label: '中心爆发' },
  { id: 'loop', label: '整段循环' },
];

/** 涟漪模式下默认点阵的常驻底亮度：固定值，不随涟漪圆心远近衰减 ——
    基础点阵的直径和亮度永远是固定的，圆扫到哪就放大哪，别处的点原样不动。 */
const RIPPLE_BASE = 0.22;

/** 多角星角数 4–10（对齐参考站：奇偶角都要有，角数完全随机） */
const STAR_N_MIN = 4;
const STAR_N_SPAN = 7;
/** 星形内径比 0.1–0.5：越小角越尖（参考站同款随机） */
const STAR_RATIO_MIN = 0.1;
const STAR_RATIO_SPAN = 0.4;
/** 形状权重池：圆 / 药丸 / 多角星，星形双倍权重 —— 与参考站的 circle/pill/star/star 一致 */
const SHAPE_POOL = [0, 1, 2, 2];

/** 涟漪的圆心轨迹：从左上角出发，绕四个角一圈回到左上闭环。每个角分三段：
    delay = 0 —— 用户明确要求「到位即发射、去掉发射前的那一下停顿」，
            原来 80ms 的驻足已并进 move；
    hold  = 到位后从圆心向外传播的放射段；
    move  = 放射结束后缓入缓出滑向下一个角，占每角九成时间：圆几乎一直在走，
            波在滑行全程继续向外荡开（waveEnv 跟着 move 段一路淡出），
            观感是「滑到点上就放波、放完接着滑向下一个点」，中间不空一拍。 */
const RIPPLE_STOPS: { fx: number; fy: number; delay: number; hold: number; gap: number; move: number }[] = [
  { fx: 0.08, fy: 0.1, delay: 0, hold: 0.1, gap: 0, move: 0.9 },
  { fx: 0.92, fy: 0.1, delay: 0, hold: 0.1, gap: 0, move: 0.9 },
  { fx: 0.92, fy: 0.9, delay: 0, hold: 0.1, gap: 0, move: 0.9 },
  { fx: 0.08, fy: 0.9, delay: 0, hold: 0.1, gap: 0, move: 0.9 },
];

/** 10 纯色（参考站 palette 原序，hex 逐值对齐，定义在 tokens.css） */
const SOLID_VARS = [
  '--matrix-solid-1',
  '--matrix-solid-2',
  '--matrix-solid-3',
  '--matrix-solid-4',
  '--matrix-solid-5',
  '--matrix-solid-6',
  '--matrix-solid-7',
  '--matrix-solid-8',
  '--matrix-solid-9',
  '--matrix-solid-10',
];

/** 7 组渐变对（内环色 → 外圈色，参考站原序） */
const GRADIENT_PAIRS: [string, string][] = [
  ['--matrix-grad-1a', '--matrix-grad-1b'],
  ['--matrix-grad-2a', '--matrix-grad-2b'],
  ['--matrix-grad-3a', '--matrix-grad-3b'],
  ['--matrix-grad-4a', '--matrix-grad-4b'],
  ['--matrix-grad-5a', '--matrix-grad-5b'],
  ['--matrix-grad-6a', '--matrix-grad-6b'],
  ['--matrix-grad-7a', '--matrix-grad-7b'],
];

type RGB = [number, number, number];

/** 每个点携带的「上色方式」：纯色，或双色偏心径向渐变（对齐参考站） */
type Paint = { solid: RGB } | { gradient: [RGB, RGB] };

/** 读不到 CSS 变量时的兜底色：与 tokens.css 的 --matrix-* 同值（参考站原版 hex） */
const FALLBACK_RGB: Record<string, RGB> = {
  '--matrix-solid-1': [34, 197, 94],
  '--matrix-solid-2': [6, 182, 212],
  '--matrix-solid-3': [249, 115, 22],
  '--matrix-solid-4': [239, 68, 68],
  '--matrix-solid-5': [250, 204, 21],
  '--matrix-solid-6': [236, 72, 153],
  '--matrix-solid-7': [156, 163, 175],
  '--matrix-solid-8': [167, 139, 250],
  '--matrix-solid-9': [96, 165, 250],
  '--matrix-solid-10': [52, 211, 153],
  '--matrix-grad-1a': [99, 102, 241], '--matrix-grad-1b': [59, 130, 246],
  '--matrix-grad-2a': [6, 182, 212], '--matrix-grad-2b': [99, 102, 241],
  '--matrix-grad-3a': [34, 197, 94], '--matrix-grad-3b': [6, 182, 212],
  '--matrix-grad-4a': [249, 115, 22], '--matrix-grad-4b': [239, 68, 68],
  '--matrix-grad-5a': [139, 92, 246], '--matrix-grad-5b': [6, 182, 212],
  '--matrix-grad-6a': [59, 130, 246], '--matrix-grad-6b': [139, 92, 246],
  '--matrix-grad-7a': [52, 211, 153], '--matrix-grad-7b': [59, 130, 246],
};

interface Dot {
  x: number;
  y: number;
  /** 归一化离中心距离 0（中心）→ 1（最远的角） */
  d: number;
  color: Paint;
  /** 形状编号：0 圆点 / 1 药丸 / 2 多角星 —— 与参考站的 circle/pill/star 一致 */
  shape: number;
  /** 多角星的角数 4–10，随机 */
  starN: number;
  /** 星形内径比 0.1–0.5：越小角越尖 */
  starRatio: number;
  /** 形状抽取源 0–1：放大量够大时才按它决定这个点长不长得成形状 */
  shapeRoll: number;
  rot: number;
  /** 大小随机源 0–1：最终直径由 sizeJitter 现算，改滑块不必重建点阵 */
  sizeRand: number;
  phase: number;
  /** 指数平滑的当前尺寸倍率：每帧追「理想倍率」，放大 0.5s / 缩小 0.6s */
  sizeMul: number;
  /** 是否正处在影响圆里：扫入瞬间要重掷角度 / 倍率 / 形态 */
  hovered: boolean;
  /** 每个点自己的随机流：重掷时用，同一 seed 全程可复现 */
  rnd: () => number;
}

/** 可复现的伪随机：同一个 seed 永远长出同一片矩阵，调参时点位不会乱跳 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 运行时读出色盘：10 纯色 + 7 渐变对 = 17 种上色方式，逐值对齐参考站 palette
    （定义在 tokens.css 的 --matrix-*）；读不到变量就走兜底同值。 */
function readPalette(el: HTMLElement): Paint[] {
  const cs = getComputedStyle(el);
  const read = (name: string): RGB => {
    const raw = cs.getPropertyValue(name).trim();
    const hex = /^#([0-9a-fA-F]{6})$/.exec(raw);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return FALLBACK_RGB[name];
  };
  const paints: Paint[] = SOLID_VARS.map((name) => ({ solid: read(name) }));
  for (const [a, b] of GRADIENT_PAIRS) paints.push({ gradient: [read(a), read(b)] });
  return paints;
}

/** 按间距铺网格并给每个点发一张「随机身份证」 */
function buildDots(w: number, h: number, gap: number, palette: Paint[], seed = 20260925): Dot[] {
  const rnd = mulberry32(seed);
  const cols = Math.max(1, Math.floor((w - 1) / gap) + 1);
  const rows = Math.max(1, Math.floor((h - 1) / gap) + 1);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.hypot(cx, cy) || 1;
  const dots: Dot[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x = cx + (c - (cols - 1) / 2) * gap;
      const y = cy + (r - (rows - 1) / 2) * gap;
      const index = dots.length;
      dots.push({
        x,
        y,
        d: Math.min(1, Math.hypot(x - cx, y - cy) / maxR),
        color: palette[Math.floor(rnd() * palette.length) % palette.length],
        shape: SHAPE_POOL[Math.floor(rnd() * SHAPE_POOL.length) % SHAPE_POOL.length],
        starN: STAR_N_MIN + Math.floor(rnd() * STAR_N_SPAN),
        starRatio: STAR_RATIO_MIN + rnd() * STAR_RATIO_SPAN,
        shapeRoll: rnd(),
        rot: rnd() * Math.PI * 2,
        sizeRand: rnd(),
        phase: rnd(),
        sizeMul: 1,
        hovered: false,
        rnd: mulberry32((seed + (index + 1) * 7919) >>> 0),
      });
    }
  }
  return dots;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a || 1));
  return t * t * (3 - 2 * t);
};

/** 四种模式的「生长量」g∈[0,1]：0 = 静止小点，1 = 完全撑大成形状。
    导出给测试用：波纹方向（是不是从中心往外走）是这套效果最容易写反的地方。 */
export function growthOf(mode: MatrixMode, u: number, d: number): number {
  if (mode === 'static') return 0;
  if (mode === 'wave') {
    // 行进脉冲：fract(u - d) 让波前从中心一圈圈向外走，首尾相接所以无缝循环
    const p = (((u - d) % 1) + 1) % 1;
    return clamp01(Math.pow(Math.sin(Math.PI * p), 1.6));
  }
  // burst / loop：波前从中心一路扫到最远的角，扫到的点立刻撑大（所以是 rise 的补——
  // 写成 smooth(front,…,d) 会让外圈先长、中心始终是黑的，方向就反了）；
  // 尾部整场缩回原位，首尾相接才能无缝循环。
  const front = u * 3 - 0.12;
  const rise = 1 - smooth(front, front + 0.16, d);
  const hold = mode === 'loop' ? 0.7 : 0.55;
  const fall = 1 - smooth(hold, 1, u);
  return clamp01(rise * fall);
}

/** 更缓的加减速：圆心滑行用，比 ease-in-out 再钝一点，起步和落点都不生硬 */
/** 缓入缓出（标准三次 ease-in-out）：滑行从静止起步、到下一个角稳稳停住，
    首尾都有明确的加减速；不用 smootherstep —— 那条曲线端点太肉，
    看着像「粘住一拍才冲出去」。 */
function easeInOut(t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

/** 涟漪：整圈时间 u 落在哪一段上 —— 圆心在哪个角、这个角的波放到哪了。
    zoneR = 常驻影响圆半径（px，跟着圆心走、不消失）；
    ringR = 圆环波的波前半径（到位即从圆心以 waveSpeed 向外传播，滑行段也在走，
            出画后停在画布外）；
    waveEnv = 滑行段的淡出包络（拖尾余波平滑灭掉，不会有「啪」的一下）。
    max 取半对角线且全程不变：圆心在动，归一化尺度必须固定，否则所有点会一起抽动。 */
function ripplePath(u: number, w: number, h: number, p: MatrixParams, period: number) {
  const total = RIPPLE_STOPS.reduce((sum, stop) => sum + stop.delay + stop.hold + stop.gap + stop.move, 0);
  const t = (((u % 1) + 1) % 1) * total;
  const max = (Math.hypot(w, h) / 2) || 1;
  let acc = 0;
  for (let i = 0; i < RIPPLE_STOPS.length; i += 1) {
    const stop = RIPPLE_STOPS[i];
    const span = stop.delay + stop.hold + stop.gap + stop.move;
    if (t < acc + span || i === RIPPLE_STOPS.length - 1) {
      const next = RIPPLE_STOPS[(i + 1) % RIPPLE_STOPS.length];
      // 这一段的总时长与各段时长（权重 × 一圈时长）
      const spanMs = (period * span) / total;
      const delayMs = (period * stop.delay) / total;
      const moveMs = (period * stop.move) / total;
      const moveStartMs = spanMs - moveMs;
      const subMs = (t - acc) * (period / total);
      let x = stop.fx * w;
      let y = stop.fy * h;
      // 滑行段：圆心缓入缓出地滑到下一个角，起步加速、到位减速，不会「啪」地跳过去
      if (subMs > moveStartMs) {
        const k = easeInOut((subMs - moveStartMs) / moveMs);
        x += (next.fx * w - x) * k;
        y += (next.fy * h - y) * k;
      }
      // 圆环：到位即从圆心以 waveSpeed 向外传播（delay = 0），放射结束后波在滑行全程
      // 继续走；waveEnv 跟着滑行段一路淡出（拖尾余波平滑灭掉，不会有「啪」的一下）
      const travel = Math.max(w, h) * 1.5;
      const waveMs = Math.max(0, subMs - delayMs);
      const ringR = Math.min((p.waveSpeed * waveMs) / 1000, travel);
      let waveEnv = 1;
      if (subMs < delayMs) waveEnv = 0;
      // 淡出铺满整段滑行（到 92% 才归零）：波从放出处一路荡到下一个角附近，
      // 圆滑到尾迹后面越来越弱，正好接上下一角的 delay —— 全程不空一拍
      else if (subMs > moveStartMs) waveEnv = 1 - smooth(0, 0.92, (subMs - moveStartMs) / moveMs);
      // 影响半径对齐参考站：按画布短边取百分比（站点是 Math.min(W,H) × influenceRadius/100）
      return { x, y, max, zoneR: p.zoneR * Math.min(w, h), ringR, waveEnv };
    }
    acc += span;
  }
  return { x: w / 2, y: h / 2, max, zoneR: p.zoneR * Math.min(w, h), ringR: Math.max(w, h) * 1.5, waveEnv: 0 };
}

/** 单个点在这一次涟漪里的状态。
    g = 生长量；圆环是双峰：波前扫过时同一点「抬-落-抬」正好两下，
    两次峰的间隔 = 波前宽 / 波速（收紧波前宽 = 间隔变快）。 */
/** 常驻影响圆：以涟漪圆心为圆心的软圆（边缘 smoothstep 柔化）。
    半径一半以内满档、到半径处柔化到 0 —— 参考图里「由圆形中心点放大、边缘缩小」的那个圆；
    它跟着圆心走、不消失，圆外一律保持默认点阵。 */
export function zoneState(dist: number, radiusPx: number): number {
  const r = Math.max(1, radiusPx);
  return 1 - smooth(r * 0.5, r, dist);
}

/** 圆环波（参考站原版数学）：环带 = [ringR - width, ringR + width]，带内
    X = 1 - |dist - ringR| / width，放大量 = sin(π·X)。所以是一对以 ringR 为中心
    对称的双峰（峰在 ringR ± width/2，波前正中反而落到 0）—— 每个点被「抬-落-抬」
    两次，就是参考站那种成对推进的波纹；带外一律为 0（是环，不是实心圆）。 */
export function waveState(ringR: number, dist: number, widthPx: number): number {
  const w = Math.max(1, widthPx);
  const x = 1 - Math.abs(dist - ringR) / w;
  if (x <= 0) return 0;
  return Math.sin(Math.PI * x);
}

/** 指数平滑的帧系数：参考站把「0.5s 放大 / 0.6s 缩小」换算成每帧比例（1 - 5%^(1/帧数)），
    我们按真实帧间隔折算 —— 掉帧时一步走够，不会因帧率波动忽快忽慢。 */
export function easeFactor(dtMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return 1 - Math.pow(0.05, Math.max(0, dtMs) / durationMs);
}

/** 影响圆扫入某个点的瞬间，重掷它的角度 / 形态（星形角数、内径比、要不要长成形状
    一起换）—— 参考站的 rollShape：悬停进入即 reassign angle/scale/form，同一片点阵
    每被扫过一次就换一张脸。每个点带自己的随机流，全程可复现。 */
function rollShape(dot: Dot) {
  dot.rot = dot.rnd() * Math.PI * 2;
  dot.starN = STAR_N_MIN + Math.floor(dot.rnd() * STAR_N_SPAN);
  dot.starRatio = STAR_RATIO_MIN + dot.rnd() * STAR_RATIO_SPAN;
  dot.shapeRoll = dot.rnd();
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const PAPER: RGB = [255, 255, 255];
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** 上色前统一过一遍：往纸面白混 tint 提亮，再把色度外扩 40%（灰度均值不动）——
    小点阵的颜色也能跳出来，饱和度对标参考站那组高饱和 palette。 */
function boost(c: RGB, tint: number): RGB {
  const m = mixRGB(PAPER, c, tint);
  const mean = (m[0] + m[1] + m[2]) / 3;
  return [
    clamp255(mean + (m[0] - mean) * 1.4),
    clamp255(mean + (m[1] - mean) * 1.4),
    clamp255(mean + (m[2] - mean) * 1.4),
  ];
}

const cssRGBA = (c: RGB, a: number) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a.toFixed(3)})`;

function polyPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, n: number, rot: number, inner = 1) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i += 1) {
    const rad = i % 2 === 0 ? r : r * inner;
    const a = rot + (i * Math.PI) / n;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 形状路径画在局部坐标（调用方已 translate + rotate）—— 只剩参考站那三种。
    几何按站点的形状间关系换算（站点以圆直径 = 1.33·size 为基准：药丸高 1.07 倍圆径、
    宽 0.51 倍，星形外径 0.72 倍圆径）：药丸高 1.07s / 宽 0.51s / 两端半圆；
    多角星外径 0.72s、内径比 0.1–0.5 随机、4–10 角。 */
function shapePath(ctx: CanvasRenderingContext2D, dot: Dot, s: number) {
  switch (dot.shape) {
    case 1: {
      // 药丸：高 1.07s、宽 0.51s、两端半圆
      const hw = s * 0.257;
      const hh = s * 0.537;
      ctx.beginPath();
      ctx.moveTo(-hw + hw, -hh);
      ctx.arcTo(hw, -hh, hw, hh, hw);
      ctx.arcTo(hw, hh, -hw, hh, hw);
      ctx.arcTo(-hw, hh, -hw, -hh, hw);
      ctx.arcTo(-hw, -hh, hw, -hh, hw);
      ctx.closePath();
      break;
    }
    case 2:
      polyPath(ctx, 0, 0, s * 0.72, dot.starN, 0, dot.starRatio);
      break;
    default:
      ctx.beginPath();
      ctx.arc(0, 0, s / 2, 0, Math.PI * 2);
  }
}

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  dots: Dot[],
  w: number,
  h: number,
  p: MatrixParams,
  mode: MatrixMode,
  elapsed: number,
  dtMs: number,
) {
  ctx.clearRect(0, 0, w, h);
  if (dots.length === 0) return;
  // 指数平滑按真实帧间隔折算；切标签页回来那一下的大 dt 夹住，尺寸不许瞬移
  const dt = Math.max(0, Math.min(100, dtMs));

  // 涟漪用自己的时钟：四个起点走满一圈 = rippleCycle；其余模式共用 cycle
  const isRipple = mode === 'ripple';
  const period = Math.max(400, isRipple ? p.rippleCycle : p.cycle);
  const u = mode === 'static' ? 0 : (elapsed % period) / period;
  const spot = isRipple ? ripplePath(u, w, h, p, period) : null;
  const breathe = Math.max(200, p.breathe);
  const tb = (elapsed % breathe) / breathe;

  for (const dot of dots) {
    let dn = dot.d;
    let g = 0;
    let zone = 0;
    let waveG = 0;
    let breath = 1;
    let rest: number;
    let tint: number;
    let falloff: number;
    let sizeCap = p.gap * 0.78;

    if (spot) {
      // 涟漪：默认小点阵是固定的底（直径/亮度都不随圆心远近变）；
      // 常驻影响圆（zone）走到哪放大到哪；本角释放的圆环（wave）以 sin(π·t) 在波前宽内
      // 瞬时再放大一截，环过之后回到影响圆的量级 —— 环是环，不是实心圆。
      const dx = dot.x - spot.x;
      const dy = dot.y - spot.y;
      const dist = Math.hypot(dx, dy);
      dn = Math.min(1, dist / spot.max);
      zone = zoneState(dist, spot.zoneR);
      waveG = waveState(spot.ringR, dist, p.waveWidth) * spot.waveEnv;
      g = Math.max(zone, waveG);
      // 影响圆扫入瞬间重掷角度 / 倍率 / 形态（对齐参考站 rollShape：悬停进入即换一张脸）
      if (zone > 0.05) {
        if (!dot.hovered) {
          dot.hovered = true;
          rollShape(dot);
        }
      } else {
        dot.hovered = false;
      }
      // 常驻底：固定亮度，任何位置都是同一片小点阵，不会哪个角突然消失
      rest = RIPPLE_BASE;
      tint = clamp01(p.colorMix * (0.6 + 0.4 * g));
      // 衰减只作用在影响圆的放大量上：中心大、边缘小，但不碰底尺寸
      falloff = Math.max(0.05, 1 - p.centerBoost * 1.2 * dn);
      // 圆环波不随距离衰减（环扫到哪都亮）；上限 1.6 格，元素之间允许互相压一角
      sizeCap = p.gap * 1.6;
    } else {
      const bp = tb * Math.PI * 2 - dot.d * p.ripple * 2.4 - dot.phase * p.jitter * 2;
      breath = 0.5 + 0.5 * Math.sin(bp);
      g = growthOf(mode, u, dot.d);
      rest = (0.18 + 0.42 * breath) * (1 - 0.35 * dot.d);
      tint = clamp01(p.colorMix * (0.45 + 0.55 * Math.max(breath, g)));
      falloff = 1 + p.centerBoost * (1 - dot.d) * 1.15;
    }

    // 初始大小随机：幂律让多数点贴着基准、少数点明显大；建点时定好、之后不再变
    // （重掷只换长相不换大小）；放大按 scale × 统一倍率等比进行
    const spread = 0.5 + dot.sizeRand * dot.sizeRand * 1.5;
    const scale = 1 + (spread - 1) * p.sizeJitter;
    // 直径上限：常规模式卡在 0.78 格保住暗缝，涟漪放到 1.6 格让元素互相压一角
    // 亮度用的混合量：影响圆与圆环取大；亮度不平滑，跟手
    const ampMix = spot ? Math.max(zone * falloff, waveG) : g;
    // 影响圆与圆环都走同一条指数平滑：放大 0.5s、缩小 0.6s（参考站的非对称手感），
    // 按真实帧间隔折算 —— 站点是 G 出来后统一 chase，环不再是瞬跳，波前扫过是一段
    // 平滑起伏；波速慢下来时双峰的「抬-落-抬」会重新显形，波速快时融成一次柔和膨胀。
    // 倍率用全局 amp、所有点等比：初始大小的随机在建点时就定好（见下方 scale），
    // 放大不再逐点随机 —— 大点和大点一起大，小点和小点一起大。
    const zoneIdeal = spot
      ? 1 + zone * falloff * (p.amp - 1)
      : falloff * (1 + g * (p.amp - 1)) * (0.78 + 0.5 * breath);
    // 圆环波与影响圆取大（参考站是 max(d, S)，不是叠加）后一起追赶
    const waveIdeal = spot ? 1 + waveG * (p.amp - 1) : 0;
    const target = Math.max(zoneIdeal, waveIdeal);
    dot.sizeMul += (target - dot.sizeMul) * easeFactor(dt, target > dot.sizeMul ? 500 : 600);
    const mul = dot.sizeMul;
    const size = Math.max(0.4, Math.min(p.dot * scale * mul, sizeCap));
    // 亮度：涟漪段 = 固定底 + 影响圆放大（带衰减） + 圆环提亮；常规模式公式不变
    const alpha = Math.min(1, spot ? rest + ampMix * 0.5 + waveG * 0.15 : rest + g * 0.55);
    if (alpha < 0.02) continue;

    const x = dot.x;
    const y = dot.y;
    const paint = dot.color;
    // 纯色 / 渐变各自的（提亮 + 提饱和前的）原始两端；纯色时两端同色，下面统一处理
    const pair: [RGB, RGB] = 'gradient' in paint ? paint.gradient : [paint.solid, paint.solid];
    const c0 = boost(pair[0], tint);

    // 撑大时背后垫一层同色柔光；涟漪模式不要发光，直接跳过
    if (!spot && g > 0.15 && size < p.gap * 0.6) {
      ctx.fillStyle = cssRGBA(c0, 0.08 * g);
      ctx.beginPath();
      ctx.arc(x, y, size * 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 形状跟着大小走：小点保持圆点，放大了才各自按概率长出药丸 / 多边形 / 多角星（角数随机）
    const shapeChance = Math.min(1, p.shapeMix * (0.12 + 1.9 * g) * Math.min(1.4, scale));
    const useShape = dot.shape > 0 && dot.shapeRoll < shapeChance;
    if (useShape) {
      // 形状统一画局部坐标：先平移、再按各自的随机角度旋转
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(dot.rot);
      shapePath(ctx, dot, size);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
    }
    // 够大的形状按参考站的方式上偏心径向渐变（中心偏上、外圈 1.5 倍）；
    // 小点直接走纯色 —— 几千个点每帧建渐变太贵
    const grad = 'gradient' in paint && size > p.gap * 0.4
      ? ctx.createRadialGradient(x, y - size * 0.3, 0, x, y + size * 0.3, Math.max(1, size * 1.5))
      : null;
    if (grad) {
      grad.addColorStop(0, cssRGBA(c0, alpha));
      grad.addColorStop(1, cssRGBA(boost(pair[1], tint), alpha));
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = cssRGBA(c0, alpha);
    }
    ctx.fill();
  }
}

export function RunningMatrix({ params, mode, inline = false }: { params: MatrixParams; mode: MatrixMode; inline?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const startRef = useRef(performance.now());

  // 换效果就把动画时钟拨回开头：否则接着上一模式的相位，头一秒看的是半截动画
  useEffect(() => {
    startRef.current = performance.now();
  }, [mode]);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const palette = readPalette(box);
    let dots: Dot[] = [];
    let w = 0;
    let h = 0;
    let builtGap = -1;
    let raf = 0;

    const rebuild = () => {
      const rect = box.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = buildDots(w, h, paramsRef.current.gap, palette);
      builtGap = paramsRef.current.gap;
    };

    let prev = performance.now();
    const frame = (now: number) => {
      const dt = now - prev;
      prev = now;
      // 间距是唯一影响点位的参数：变了才重建，其余每帧读最新值
      if (paramsRef.current.gap !== builtGap) rebuild();
      // 时钟走 startRef：切换模式时把它拨回 0，调参的人一按就看到完整一遍
      drawMatrix(ctx, dots, w, h, paramsRef.current, modeRef.current, now - startRef.current, dt);
      raf = window.requestAnimationFrame(frame);
    };

    rebuild();
    raf = window.requestAnimationFrame(frame);

    const ro = new ResizeObserver(() => rebuild());
    ro.observe(box);
    return () => {
      window.cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className={`running-matrix${inline ? ' is-inline' : ''}`} ref={boxRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
