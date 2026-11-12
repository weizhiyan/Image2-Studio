/** Shared by browser and bridge; keep this module free of Node/runtime dependencies. */
interface ImageProfileContext {
  id: string;
  model: string;
  responsesModel?: string;
}

interface ImageBaseContext {
  responseId?: unknown;
  imageGenerationCallId?: unknown;
  responseProfileId?: unknown;
  responseModel?: unknown;
  model?: unknown;
}

export interface ImageContinuation {
  previousResponseId?: string;
  previousImageGenerationCallId?: string;
  /** The supplied image is only the unchanged base already in this response chain. */
  reusePreviousImage?: boolean;
  resetReason?: string;
}

/** Resolve the outer model independently of the image-only model list. */
export function resolveResponseModel(profile: { responsesModel?: string }, requested?: string): string {
  for (const value of [requested, profile.responsesModel]) {
    const candidate = value?.trim();
    if (candidate && candidate !== 'GPT') return candidate;
  }
  return 'gpt-5.5';
}

export function resolveImageContinuation(input: {
  base?: ImageBaseContext;
  profile: ImageProfileContext;
  apiMode: 'images' | 'responses';
  model?: string;
  isEdit: boolean;
  hasNewReferences: boolean;
}): ImageContinuation {
  const { base, profile, apiMode, isEdit, hasNewReferences } = input;
  if (!base) return {};
  if (hasNewReferences || !isEdit) {
    return { resetReason: '本轮使用了新的参考图或全新需求，上下文从这里重新开始' };
  }
  const imageModel = input.model?.trim() || profile.model;
  // Missing historical identities are not evidence that today's configuration matches.
  if (apiMode !== 'responses' || base.responseProfileId !== profile.id
    || base.responseModel !== resolveResponseModel(profile)
    || !base.model || base.model !== imageModel) {
    return { resetReason: '模型配置或接口模式变化，无法续接上一轮上下文' };
  }
  if (typeof base.responseId !== 'string' || !base.responseId.trim()) {
    return { resetReason: '基准版本没有可续接的上下文，已重新上传基准图' };
  }
  return {
    previousResponseId: base.responseId,
    previousImageGenerationCallId: typeof base.imageGenerationCallId === 'string'
      ? base.imageGenerationCallId || undefined : undefined,
    reusePreviousImage: true,
  };
}
