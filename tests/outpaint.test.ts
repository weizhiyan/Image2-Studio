import { describe, expect, it } from 'vitest';
import {
  buildOutpaintPrompt,
  centerOutpaintImageForAspect,
  fitImageToOutpaintFrame,
  initialOutpaintFrame,
  normalizeOutpaintTargetAspect,
  OUTPAINT_RATIO_PADDING,
  outpaintFrameForAspect,
} from '../src/lib/outpaint';

describe('outpaint helpers', () => {
  it('keeps the source image fully inside the target frame without distorting it', () => {
    expect(fitImageToOutpaintFrame(
      { x: -20, y: 60, width: 400, height: 200 },
      { width: 300, height: 240 },
    )).toEqual({ x: 0, y: 60, width: 300, height: 150 });
  });

  it('describes the target ratio, source placement, and optional request', () => {
    const prompt = buildOutpaintPrompt({
      ratio: '16:9',
      imagePosition: { x: 25, y: 10, width: 150, height: 80 },
      frame: { width: 200, height: 100 },
      instruction: '右侧延续天空',
    });

    expect(prompt).toContain('扩图任务：将原图扩展到 16:9 比例');
    expect(prompt).toContain('左侧 13%、顶部 10%');
    expect(prompt).toContain('占目标画布宽度 75%、高度 80%');
    expect(prompt).toContain('扩图补充要求：右侧延续天空');
  });

  it('anchors a 16:9 frame to the image height', () => {
    const frame = outpaintFrameForAspect({ width: 280, height: 498 }, 16 / 9);

    expect(frame.width).toBeCloseTo(498 * OUTPAINT_RATIO_PADDING * (16 / 9), 1);
    expect(frame.height).toBeCloseTo(498 * OUTPAINT_RATIO_PADDING, 1);
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 5);
  });

  it('anchors a 9:16 frame to the image width', () => {
    const frame = outpaintFrameForAspect({ width: 800, height: 450 }, 9 / 16);

    expect(frame.width).toBeCloseTo(800 * OUTPAINT_RATIO_PADDING, 1);
    expect(frame.height).toBeCloseTo(800 * OUTPAINT_RATIO_PADDING / (9 / 16), 1);
  });

  it('keeps a small expansion margin when the selected ratio matches the image', () => {
    const frame = outpaintFrameForAspect({ width: 400, height: 400 }, 1);

    expect(frame.width).toBeCloseTo(400 * OUTPAINT_RATIO_PADDING, 1);
    expect(frame.height).toBeCloseTo(400 * OUTPAINT_RATIO_PADDING, 1);
  });

  it('opens with only a small expandable margin around the image', () => {
    expect(initialOutpaintFrame({ width: 280, height: 498 })).toEqual({
      width: 350,
      height: 622.5,
    });
  });

  it('keeps the image visually centered when switching ratios', () => {
    const next = centerOutpaintImageForAspect(
      { x: 120, y: 80, width: 320, height: 180 },
      9 / 16,
    );

    expect(next.frame.left + next.frame.width / 2).toBeCloseTo(280, 5);
    expect(next.frame.top + next.frame.height / 2).toBeCloseTo(170, 5);
    expect(next.image.x + next.image.width / 2).toBeCloseTo(280, 5);
    expect(next.image.y + next.image.height / 2).toBeCloseTo(170, 5);
  });

  it('normalizes the output canvas to the exact requested aspect without moving the image', () => {
    const next = normalizeOutpaintTargetAspect(
      { left: 20, top: 30, width: 400, height: 300 },
      { x: 70, y: 90, width: 200, height: 150 },
      16 / 9,
    );

    expect(next.frame.width / next.frame.height).toBeCloseTo(16 / 9, 5);
    expect(next.frame.left).toBeCloseTo(-46.6667, 3);
    expect(next.imagePosition.x).toBeCloseTo(116.6667, 3);
    expect(next.imagePosition.y).toBeCloseTo(60, 5);
  });
});
