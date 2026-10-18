import { describe, expect, it } from 'vitest';
import { easeFactor, growthOf, MATRIX_DEFAULTS, waveState, zoneState, type MatrixMode } from '@/components/canvas/RunningMatrixField';

/** 在 u∈[0,1) 上以 step 采样，返回 g 第一次达到 threshold 的 u（到不了就返回 -1） */
function firstHit(mode: MatrixMode, d: number, threshold: number, step = 0.005): number {
  for (let u = 0; u < 1; u += step) {
    if (growthOf(mode, u, d) >= threshold) return u;
  }
  return -1;
}

/** 固定 u 时 g 随距离 d 的峰值位置（波峰此刻停在哪一圈） */
function crestAt(mode: MatrixMode, u: number, step = 0.01): number {
  let best = -1;
  let bestD = -1;
  for (let d = 0; d <= 1.0001; d += step) {
    const g = growthOf(mode, u, Math.min(1, d));
    if (g > best) {
      best = g;
      bestD = d;
    }
  }
  return bestD;
}

describe('生成矩阵 growthOf', () => {
  it('静止矩阵：任何时刻、任何半径都不生长', () => {
    for (const d of [0, 0.3, 0.7, 1]) {
      for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(growthOf('static', u, d)).toBe(0);
      }
    }
  });

  it('呼吸波纹：波峰位置随 u 外移（从中心→边缘→回到中心），方向不能写反', () => {
    for (const u of [0.05, 0.2, 0.4, 0.55, 0.7, 0.85, 0.95]) {
      expect(crestAt('wave', u)).toBeCloseTo((u + 0.5) % 1, 1);
    }
    // 相邻两帧之间波峰只往外走一格，速度均匀（不会忽快忽慢）
    const a = crestAt('wave', 0.6);
    const b = crestAt('wave', 0.62);
    expect(b - a).toBeGreaterThan(0);
    expect(b - a).toBeLessThan(0.05);
  });

  it('中心爆发 / 整段循环：外圈比内圈晚开始长大，且整段收尾时全部回到 0', () => {
    for (const mode of ['burst', 'loop'] as MatrixMode[]) {
      const t0 = firstHit(mode, 0, 0.5);
      const t1 = firstHit(mode, 1, 0.5);
      expect(t0).toBeGreaterThanOrEqual(0);
      expect(t1).toBeGreaterThan(t0);
      // 循环接缝：u 逼近 1 时生长归零，下一圈从头开始才不会跳变
      expect(growthOf(mode, 0.999, 0.5)).toBeLessThan(0.05);
      // 中心最终一定能长满（不然参考图里那个亮心出不来了）
      expect(growthOf(mode, 0.5, 0)).toBeGreaterThan(0.9);
    }
  });

  it('默认参数自洽：间距足够大、放大倍率大于 1、循环比呼吸慢', () => {
    const p = MATRIX_DEFAULTS;
    expect(p.gap).toBeGreaterThan(p.dot);
    expect(p.sizeJitter).toBeGreaterThanOrEqual(0);
    expect(p.rippleCycle).toBeGreaterThan(0);
    expect(p.amp).toBeGreaterThan(1);
    expect(p.cycle).toBeGreaterThan(p.breathe);
    for (const key of ['ripple', 'centerBoost', 'colorMix', 'shapeMix', 'jitter', 'sizeJitter'] as const) {
      expect(p[key]).toBeGreaterThanOrEqual(0);
      expect(p[key]).toBeLessThanOrEqual(1);
    }
  });
});

describe('涟漪扩散 zoneState / waveState', () => {
  it('影响圆：圆内满档、圆外归零、边缘 smoothstep 柔化', () => {
    // 半径 200px：一半以内满档
    expect(zoneState(0, 200)).toBeCloseTo(1, 5);
    expect(zoneState(100, 200)).toBeCloseTo(1, 5);
    // 半径处及以外归零
    expect(zoneState(200, 200)).toBe(0);
    expect(zoneState(260, 200)).toBe(0);
    // 柔化带内单调往外衰减（这就是「由圆形中心点放大、边缘缩小」）
    expect(zoneState(120, 200)).toBeGreaterThan(zoneState(150, 200));
    expect(zoneState(150, 200)).toBeGreaterThan(zoneState(180, 200));
    expect(zoneState(180, 200)).toBeGreaterThan(zoneState(200, 200));
  });

  it('圆环波：参考站原版 —— 波前两侧各一个峰、正中为零、带外为 0', () => {
    // 带 = [ringR - width, ringR + width]，X = 1 - |dist - ringR| / width，S = sin(π·X)
    // 波前正中 dist === ringR → X = 1 → sin(π) = 0：站点就是这样，是一对双峰
    expect(waveState(300, 300, 180)).toBeCloseTo(0, 5);
    // 两个峰在 ringR ± width/2，满档
    expect(waveState(300, 210, 180)).toBeCloseTo(1, 5);
    expect(waveState(300, 390, 180)).toBeCloseTo(1, 5);
    // 带内关于波前对称
    expect(waveState(300, 240, 180)).toBeCloseTo(waveState(300, 360, 180), 5);
    // 带外（波还没到 / 已经过去）都是 0 —— 是环不是实心圆
    // 带 = [120, 480]：120 以内、480 以外一律为 0
    expect(waveState(300, 100, 180)).toBe(0);
    expect(waveState(300, 500, 180)).toBe(0);
    expect(waveState(300, 60, 180)).toBe(0);
  });

  it('指数平滑：60fps 一帧约 0.095（对齐参考站），缩小比放大慢半拍', () => {
    const grow = easeFactor(1000 / 60, 500);
    expect(grow).toBeGreaterThan(0.085);
    expect(grow).toBeLessThan(0.105);
    expect(easeFactor(1000 / 60, 600)).toBeLessThan(grow);
    // dt 为 0 不动；时长为 0 一步到位；大 dt 夹住后的系数仍落在 (0,1]
    expect(easeFactor(0, 500)).toBe(0);
    expect(easeFactor(16, 0)).toBe(1);
    expect(easeFactor(100, 500)).toBeGreaterThan(0);
    expect(easeFactor(100, 500)).toBeLessThan(1);
    // 连续步进收敛到目标且不过冲
    let v = 0;
    for (let i = 0; i < 120; i += 1) v += (1 - v) * grow;
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('默认参数对齐参考站：影响半径 / 波速 / 波前宽', () => {
    const p = MATRIX_DEFAULTS;
    expect(p.zoneR).toBeGreaterThanOrEqual(0.1);
    expect(p.zoneR).toBeLessThanOrEqual(0.6);
    expect(p.waveSpeed).toBeGreaterThanOrEqual(200);
    expect(p.waveSpeed).toBeLessThanOrEqual(2400);
    expect(p.waveWidth).toBeGreaterThanOrEqual(60);
    expect(p.waveWidth).toBeLessThanOrEqual(400);
    // 放大上限仍是「悬停 1–3 倍」那一档
    expect(p.amp).toBeGreaterThanOrEqual(3);
  });
});
