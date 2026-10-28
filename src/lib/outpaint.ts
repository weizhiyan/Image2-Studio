export interface OutpaintPromptInput {
  ratio: string;
  imagePosition: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
  instruction: string;
}

export interface OutpaintImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 进入扩图时只多留一小圈可扩展区域，避免为了容纳所有比例而把操作区整体缩小。 */
export const OUTPAINT_INITIAL_SCALE = 1.25;
/** 切换比例时也给图片留一点扩图余量，避免“原比例/1:1”直接贴边。 */
export const OUTPAINT_RATIO_PADDING = 1.12;
/** 扩图进入时使用固定缩放，不再按图片尺寸 fit，避免每次切换比例时画布倍率漂移。 */
export const OUTPAINT_DEFAULT_ZOOM = 1;

export function initialOutpaintFrame(image: { width: number; height: number }): {
  width: number;
  height: number;
} {
  if (image.width <= 0 || image.height <= 0) return { width: 0, height: 0 };
  return {
    width: image.width * OUTPAINT_INITIAL_SCALE,
    height: image.height * OUTPAINT_INITIAL_SCALE,
  };
}

export function outpaintFrameForAspect(
  image: { width: number; height: number },
  aspect: number,
): { width: number; height: number } {
  if (image.width <= 0 || image.height <= 0) return { width: 0, height: 0 };
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  // 横向目标以原图高度为锚点（16:9 等高），纵向目标以原图宽度为锚点（9:16 等宽）。
  const width = Math.max(
    image.width * OUTPAINT_RATIO_PADDING,
    image.height * safeAspect * OUTPAINT_RATIO_PADDING,
  );
  return { width, height: width / safeAspect };
}

/** 切换比例时以当前图片中心为锚点，把图片重新居中到新画框。 */
export function centerOutpaintImageForAspect(
  image: OutpaintImageRect,
  aspect: number,
): {
  frame: { left: number; top: number; width: number; height: number };
  image: OutpaintImageRect;
} {
  const size = outpaintFrameForAspect(image, aspect);
  const frameLeft = image.x + image.width / 2 - size.width / 2;
  const frameTop = image.y + image.height / 2 - size.height / 2;
  return {
    frame: {
      left: frameLeft,
      top: frameTop,
      width: size.width,
      height: size.height,
    },
    image: {
      ...image,
      x: frameLeft + (size.width - image.width) / 2,
      y: frameTop + (size.height - image.height) / 2,
    },
  };
}

/** 把画框补到目标画布的精确比例，并返回图片相对目标画布的位置。 */
export function normalizeOutpaintTargetAspect(
  frame: { left: number; top: number; width: number; height: number },
  image: OutpaintImageRect,
  targetAspect: number,
): {
  frame: { left: number; top: number; width: number; height: number };
  imagePosition: OutpaintImageRect;
} {
  const safeAspect = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : 1;
  let left = frame.left;
  let top = frame.top;
  let width = frame.width;
  let height = frame.height;
  const frameAspect = width / height;
  if (frameAspect < safeAspect) {
    const nextWidth = height * safeAspect;
    left -= (nextWidth - width) / 2;
    width = nextWidth;
  } else if (frameAspect > safeAspect) {
    const nextHeight = width / safeAspect;
    top -= (nextHeight - height) / 2;
    height = nextHeight;
  }
  return {
    frame: { left, top, width, height },
    imagePosition: {
      x: image.x - left,
      y: image.y - top,
      width: image.width,
      height: image.height,
    },
  };
}

export function fitImageToOutpaintFrame(
  image: OutpaintImageRect,
  frame: { width: number; height: number },
): OutpaintImageRect {
  if (image.width <= 0 || image.height <= 0 || frame.width <= 0 || frame.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(1, frame.width / image.width, frame.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: Math.max(0, Math.min(frame.width - width, image.x)),
    y: Math.max(0, Math.min(frame.height - height, image.y)),
    width,
    height,
  };
}

function percent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((value / total) * 100);
}

/** Makes the edit mode explicit and describes the source placement in the padded canvas. */
export function buildOutpaintPrompt(input: OutpaintPromptInput): string {
  const left = percent(input.imagePosition.x, input.frame.width);
  const top = percent(input.imagePosition.y, input.frame.height);
  const width = percent(input.imagePosition.width, input.frame.width);
  const height = percent(input.imagePosition.height, input.frame.height);
  const instruction = input.instruction.trim();
  return [
    `扩图任务：将原图扩展到 ${input.ratio} 比例。`,
    `原图在透明目标画布中的位置为左侧 ${left}%、顶部 ${top}%，占目标画布宽度 ${width}%、高度 ${height}%。`,
    '严格保留原图已有区域的主体、位置、比例、视角、光线、色彩和细节，不重绘、不缩放变形原图；只补全透明的新增画布区域，并让新增内容与原图边缘自然连续。',
    instruction ? `扩图补充要求：${instruction}` : '',
  ].filter(Boolean).join('\n');
}
