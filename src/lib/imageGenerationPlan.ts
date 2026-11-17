import { assertPromptAspect, fallbackImageAspect, normalizeAspectRatio } from '../../bridge/imagePlanning';
import { AUTO_RATIO, detectPromptRatio, parseSizeRatio, pickSizeForResolution, ratioToNumber, resolveAutoRatio } from './aspect';

interface ImageGenerationInput {
  prompt: string;
  ratio?: string;
  resolution?: string;
  defaultSize: string;
  sizeOverride?: string;
  references?: Array<{ width?: number; height?: number }>;
  editingSize?: string;
  optimize: boolean;
}

export function planImageGeneration(input: ImageGenerationInput) {
  const explicitRatio = detectPromptRatio(input.prompt);
  const reference = input.references?.find((item) => Number(item.width) > 0 && Number(item.height) > 0);
  const referenceSize = input.editingSize || (reference ? `${reference.width}x${reference.height}` : undefined);
  const automatic = input.optimize && input.ratio === AUTO_RATIO && !input.sizeOverride && !input.editingSize && explicitRatio === 0;
  const presetRatio = input.ratio === AUTO_RATIO
    ? resolveAutoRatio({ prompt: input.prompt, references: input.references })
    : ratioToNumber(input.ratio || '');
  const ratio = explicitRatio
    || (input.ratio !== AUTO_RATIO ? presetRatio : 0)
    || ratioToNumber(input.editingSize || '') || presetRatio || parseSizeRatio(input.defaultSize);
  const resolution = input.resolution || '1K';
  const fallbackRatio = automatic ? ratioToNumber(fallbackImageAspect(input.prompt, referenceSize)) : ratio;
  return {
    automatic,
    referenceSize,
    resolution,
    size: input.sizeOverride || pickSizeForResolution(fallbackRatio, resolution),
  };
}

export function resolvePlannedImageSize(
  plan: ReturnType<typeof planImageGeneration>,
  result: { prompt: string; aspectRatio?: string },
): string {
  const ratio = normalizeAspectRatio(result.aspectRatio);
  const size = plan.automatic && ratio ? pickSizeForResolution(ratioToNumber(ratio), plan.resolution) : plan.size;
  assertPromptAspect(result.prompt, size);
  return size;
}
