import type { CanvasNode, CanvasNodeData } from '@/types';

export const SIZE_PRESETS = ['1024x1024', '1024x1536', '1536x1024'] as const;

/** "1024x1536" → 数字比例（高/宽）；不是合法尺寸返回 0（区别于 parseSizeRatio 的兜底 1）。 */
export function parseSizeRatioOrZero(size: string | undefined): number {
  const match = /^(\d+)x(\d+)$/.exec(String(size || '').trim());
  if (!match) return 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 0;
  return height / width;
}

/** "1024x1536" → 数字比例（高/宽），解析失败回 1。 */
export function parseSizeRatio(size: string | undefined): number {
  return parseSizeRatioOrZero(size) || 1;
}

/** 数字比例 → 节点里的展示比例（两位小数）。 */
export function formatRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.round(ratio * 100) / 100;
}

/** 尺寸按比例预设走：竖图 1024x1536、横图 1536x1024，其余方图。 */
export function pickSize(ratio: number): string {
  if (ratio > 1.15) return '1024x1536';
  if (ratio < 0.87) return '1536x1024';
  return '1024x1024';
}

/** 位图实际比例优先于尺寸字符串：节点展示以真实图片为准。 */
export function nodeRatio(node: CanvasNode | undefined): number {
  if (!node) return 1;
  const width = Number(node.data.width || 0);
  const height = Number(node.data.height || 0);
  if (width > 0 && height > 0) return formatRatio(height / width);
  if (node.data.kind === 'reference') return formatRatio(parseSizeRatio(node.data.size));
  return formatRatio(parseSizeRatio(node.data.size));
}

/** 从提示词里识别用户口头指定的画幅，例如 "竖构图 3:4" / "9:16"。 */
export function requestedRatioFromPrompt(prompt: string, fallback = 1): number {
  const detected = detectPromptRatio(prompt);
  return formatRatio(detected > 0 ? detected : fallback);
}

/** 灵枢同款比例预设（宽:高），节点工具栏里选。 */
export const RATIO_PRESETS = ['1:1', '16:9', '3:4', '9:16'] as const;

/** "16:9" → 高度/宽度的数字比例（与 parseSizeRatio 同向）。 */
export function ratioToNumber(label: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*[:：xX×]\s*(\d+(?:\.\d+)?)$/.exec(String(label || '').trim());
  if (!match) return 0;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return 0;
  return formatRatio(height / width);
}

/** 提示词里显式写了画幅就返回它的高度/宽度比例，没写返回 0（交给节点设置兜底）。 */
export function detectPromptRatio(prompt: string): number {
  const text = String(prompt || '');
  const ratio = /\b(\d{1,2})\s*[:：]\s*(\d{1,2})\b/.exec(text);
  if (ratio) {
    const width = Number(ratio[1]);
    const height = Number(ratio[2]);
    if (width > 0 && height > 0) return formatRatio(height / width);
  }
  if (/竖|portrait|竖构图/.test(text)) return formatRatio(4 / 3);
  if (/横|landscape|横构图|宽幅/.test(text)) return formatRatio(3 / 4);
  return 0;
}

/** 工具栏比例新选项：自动（按参考图推导）打头，其后是手动档（按用户习惯从宽到窄排）。 */
export const RATIO_TOOLBAR_OPTIONS = ['auto', '21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const;
export const AUTO_RATIO = 'auto';

/** 分辨率档位：长边像素（与比例共同决定发给生图模型的 size）。 */
export const RESOLUTION_OPTIONS = ['1K', '2K', '4K'] as const;
export type ResolutionLabel = (typeof RESOLUTION_OPTIONS)[number];
export const RESOLUTION_LONG_EDGE: Record<ResolutionLabel, number> = { '1K': 1024, '2K': 2048, '4K': 4096 };
/** OpenAI 图像尺寸约束：边长 16 的倍数、单边不超过 3840、总像素在此区间内、长短边不超过 3:1。 */
export const IMAGE_SIZE_LIMITS = {
  minEdge: 16,
  maxEdge: 3840,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxAspect: 3,
} as const;
/** 一次最多八张：用户实测画了 8 个档位，中转站对这个量级照单全收。 */
export const MAX_IMAGE_COUNT = 8;

/** 参考图比例：取第一张带尺寸的图（多图并排参考时没有主次，先到先得）。 */
export function referenceRatio(references: Array<{ width?: number; height?: number }> | undefined): number {
  for (const ref of references || []) {
    const width = Number(ref?.width || 0);
    const height = Number(ref?.height || 0);
    if (width > 0 && height > 0) return formatRatio(height / width);
  }
  return 0;
}

/** 自动档解析（对齐 CanvasPage 画幅优先级链）：提示词写明 > 参考图 > 1:1。 */
export function resolveAutoRatio(input: { prompt?: string; references?: Array<{ width?: number; height?: number }> }): number {
  const fromPrompt = detectPromptRatio(input.prompt || '');
  if (fromPrompt > 0) return fromPrompt;
  const fromReference = referenceRatio(input.references);
  if (fromReference > 0) return fromReference;
  return 1;
}

/**
 * 比例 + 分辨率 → API size。
 *
 * 分辨率档位代表期望长边，而不是可以直接发送给 API 的尺寸：4K 的 4096
 * 超过官方 3840 单边上限，极端比例在 1K 时又可能低于最小总像素。因此在
 * 16px 网格中挑选最接近目标长边、且满足全部约束的尺寸。
 */
export function pickSizeForResolution(ratio: number, resolution: string): string {
  const base = RESOLUTION_LONG_EDGE[String(resolution || '') as ResolutionLabel] || 1024;
  const requested = ratio > 0 && Number.isFinite(ratio) ? ratio : 1;
  const value = Math.min(IMAGE_SIZE_LIMITS.maxAspect, Math.max(1 / IMAGE_SIZE_LIMITS.maxAspect, requested));
  const targetLong = Math.min(base, IMAGE_SIZE_LIMITS.maxEdge);
  const step = IMAGE_SIZE_LIMITS.minEdge;
  const roundToStep = (input: number): number => Math.max(step, Math.round(input / step) * step);
  const ceilToStep = (input: number): number => Math.max(step, Math.ceil(input / step) * step);
  const floorToStep = (input: number): number => Math.max(step, Math.floor(input / step) * step);
  const portrait = value >= 1;
  const shortFactor = portrait ? 1 / value : value;

  // 先按分辨率档位生成尺寸；面积修正只放大到最低合法值或缩小到最高合法值，
  // 这样 1K 仍尽量接近 1024，4K 则不会发送 4096 或超过总像素上限。
  let width = portrait ? roundToStep(targetLong * shortFactor) : targetLong;
  let height = portrait ? targetLong : roundToStep(targetLong * shortFactor);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const actualLong = Math.max(width, height);
    const actualShort = Math.min(width, height);
    const pixels = width * height;
    let changed = false;

    if (actualLong / actualShort > IMAGE_SIZE_LIMITS.maxAspect) {
      const legalShort = ceilToStep(actualLong / IMAGE_SIZE_LIMITS.maxAspect);
      if (portrait) width = Math.max(width, legalShort);
      else height = Math.max(height, legalShort);
      changed = true;
    }

    if (pixels < IMAGE_SIZE_LIMITS.minPixels) {
      const scale = Math.sqrt(IMAGE_SIZE_LIMITS.minPixels / pixels);
      width = ceilToStep(width * scale);
      height = ceilToStep(height * scale);
      changed = true;
    } else if (pixels > IMAGE_SIZE_LIMITS.maxPixels) {
      const scale = Math.sqrt(IMAGE_SIZE_LIMITS.maxPixels / pixels);
      width = floorToStep(width * scale);
      height = floorToStep(height * scale);
      changed = true;
    }

    width = Math.min(IMAGE_SIZE_LIMITS.maxEdge, floorToStep(width));
    height = Math.min(IMAGE_SIZE_LIMITS.maxEdge, floorToStep(height));
    if (!changed) break;
  }

  // 迭代后的取整极少数情况下会把面积推过边界，再做一次确定性收敛。
  while (width * height < IMAGE_SIZE_LIMITS.minPixels) {
    if (portrait) height += step;
    else width += step;
  }
  while (width * height > IMAGE_SIZE_LIMITS.maxPixels) {
    if (width >= height) width -= step;
    else height -= step;
  }

  return `${width}x${height}`;
}

/** 生成数量收敛到 1~8。 */
export function clampImageCount(value: unknown): number {
  const count = Math.floor(Number(value));
  if (!Number.isFinite(count)) return 1;
  return Math.min(MAX_IMAGE_COUNT, Math.max(1, count));
}

/** 数字比例 → 展示标签（自动档旁边显示当前推导结果用）。 */
export function ratioToLabel(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return AUTO_RATIO;
  const known: Array<[number, string]> = [[1, '1:1'], [9 / 16, '9:16'], [3 / 4, '3:4'], [2 / 3, '2:3'], [16 / 9, '16:9']];
  for (const [value, label] of known) {
    if (Math.abs(value - ratio) < 0.01) return label;
  }
  const width = 100;
  const height = Math.round(width * ratio);
  return `${width}:${height}`;
}

/** 生成节点按比例给宽度：横幅放宽、竖幅收窄，和灵枢 getNodeWidthForAspect 同思路。 */
export function composerWidthForRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 320;
  if (ratio <= 0.7) return 400;
  if (ratio >= 1.4) return 280;
  return 320;
}

/**
 * 图片 / 参考图节点的真实卡片盒子：宽按 aspect 档位（nodeWidthFor 忽略存选 cardWidth），
 * 高 = 宽 / 比例，和卡片 CSS 的 aspect-ratio 逐像素对齐——没有 160 下限，卡多高就多高。
 * composer 返回 null：它的外壳是内容自适应高度，必须让 React Flow 贴着量，不能 pin。
 * 用途：把 React Flow 的盒子（width/height/measured）收敛到卡片实测盒。盒子比卡片大时，
 * 连线端点（按盒子边框外 24px 起弯）会飘到卡片外面——用户看到的"线离图太远"。
 */
export function imageNodeFlowBox(data: Pick<CanvasNodeData, 'imageUrl' | 'referenceDataUrl' | 'width' | 'height' | 'size' | 'ratio'>): { width: number; height: number } | null {
  if (!hasNodeImage(data)) return null;
  const width = nodeWidthFor(data);
  return { width, height: Math.round(width / nodeAspectRatio(data)) };
}

/** 灵枢同款尺寸常量（ImageCanvasPage.tsx：DEFAULT/MIN/MAX_COMPOSER_NODE_WIDTH）。 */
export const DEFAULT_COMPOSER_NODE_WIDTH = 320;
export const MIN_COMPOSER_NODE_WIDTH = 280;
export const MAX_COMPOSER_NODE_WIDTH = 600;
/** 灵枢同款高度上下限（ImageCanvasPage.tsx：MIN/MAX_COMPOSER_NODE_HEIGHT）。 */
export const MIN_COMPOSER_NODE_HEIGHT = 240;
export const MAX_COMPOSER_NODE_HEIGHT = 620;

/** 灵枢 normalizeAspectRatio：钳到 0.35~3.2，非法值回 1。 */
export function normalizeAspectRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(3.2, Math.max(0.35, value));
}

/**
 * 节点真实宽高比（宽/高，与 CSS aspect-ratio 同向）：位图实际像素 > 尺寸字符串 > 比例预设。
 * 注意 parseSizeRatio / ratioToNumber 返回的是「高/宽」，这里取倒数。
 */
export function nodeAspectRatio(data: Pick<CanvasNodeData, 'width' | 'height' | 'size' | 'ratio'>): number {
  const width = Number(data.width || 0);
  const height = Number(data.height || 0);
  if (width > 0 && height > 0) return normalizeAspectRatio(width / height);
  const sizeRatio = parseSizeRatioOrZero(data.size);
  if (sizeRatio > 0) return normalizeAspectRatio(1 / sizeRatio);
  const preset = ratioToNumber(String(data.ratio || ''));
  if (preset > 0) return normalizeAspectRatio(1 / preset);
  return 1;
}

/** 灵枢 getNodeWidthForAspect：横幅放宽、竖幅收窄，其余标准宽。 */
export function nodeWidthForAspect(aspect: number): number {
  if (aspect >= 1.55) return 400;
  if (aspect <= 0.7) return 280;
  return 320;
}

/**
 * 灵枢 getCanvasNodeDimensions：composer 用存的宽度，出图节点按比例；高度一律 宽/比例（下限 160）。
 * 自动定位的居中点、浮层位置都按这个盒子算，不读 node.width/height（React Flow 的实测值在 measured 里）。
 */
export function nodeBoxFor(data: Pick<CanvasNodeData, 'imageUrl' | 'referenceDataUrl' | 'width' | 'height' | 'size' | 'ratio' | 'cardWidth' | 'nodeHeight' | 'nodeHeightManual'>): { width: number; height: number } {
  const width = nodeWidthFor(data);
  const fallbackHeight = Math.max(160, width / nodeAspectRatio(data));
  // 手动拖过高度的 composer 用手存的高度（钳 240~620）；其余仍按比例推导。
  // 少了这个分支，拖高度只写进 data 却拿不到盒子上，看起来就是"只能等比拖"。
  const hasImage = hasNodeImage(data);
  const manual = data.nodeHeightManual === true && !hasImage;
  const height = manual
    ? Math.min(
      MAX_COMPOSER_NODE_HEIGHT,
      Math.max(MIN_COMPOSER_NODE_HEIGHT, Number(data.nodeHeight) || fallbackHeight),
    )
    : fallbackHeight;
  return { width, height };
}

function hasNodeImage(data: Pick<CanvasNodeData, 'imageUrl' | 'referenceDataUrl'>): boolean {
  return String(data.imageUrl || data.referenceDataUrl || '').trim().length > 0;
}

/** 卡片宽度：出图节点按真实位图比例重算，composer 用存的 cardWidth（钳 280~600）。 */
export function nodeWidthFor(data: Pick<CanvasNodeData, 'imageUrl' | 'referenceDataUrl' | 'width' | 'height' | 'size' | 'ratio' | 'cardWidth'>): number {
  if (hasNodeImage(data)) return nodeWidthForAspect(nodeAspectRatio(data));
  const stored = Number(data.cardWidth || 0);
  return Math.max(
    MIN_COMPOSER_NODE_WIDTH,
    Math.min(MAX_COMPOSER_NODE_WIDTH, stored > 0 ? stored : DEFAULT_COMPOSER_NODE_WIDTH),
  );
}
