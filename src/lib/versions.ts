import type { CanvasNodeData, CanvasNodeVersion } from '@/types';

/**
 * 结果节点版本链的纯函数助手：老节点（只有一个 imageUrl）在这里补成一版，
 * 之后重编辑、设主图、历史面板都只认这套结构，不再各写一份判断。
 */

/** 节点当前的版本链：老节点按当前图补一版，没有图则空数组。 */
export function normalizeVersions(data: CanvasNodeData | undefined): CanvasNodeVersion[] {
  if (!data) return [];
  const stored = Array.isArray(data.versions) ? data.versions.filter((item) => item && String(item.imageUrl || '').trim()) : [];
  if (stored.length > 0) return stored;
  const imageUrl = String(data.imageUrl || '').trim();
  if (!imageUrl) return [];
  return [{
    id: String(data.activeVersionId || '') || 'v1',
    imageUrl,
    fileName: String(data.fileName || ''),
    prompt: String(data.prompt || ''),
    model: String(data.model || ''),
    size: String(data.size || ''),
    width: data.width,
    height: data.height,
    createdAt: String(data.createdAt || ''),
    finishedAt: String(data.finishedAt || data.createdAt || ''),
    enhancedPrompt: String(data.enhancedPrompt || '') || undefined,
    revisedPrompt: String(data.revisedPrompt || '') || undefined,
    responseId: String(data.responseId || '') || undefined,
    imageGenerationCallId: String(data.imageGenerationCallId || '') || undefined,
    responseModel: String(data.responseModel || '') || undefined,
    responseProfileId: String(data.responseProfileId || '') || undefined,
  }];
}

/** 当前主图版本：activeVersionId 命中就用它，否则默认最新一版。 */
export function activeVersionOf(data: CanvasNodeData | undefined): CanvasNodeVersion | null {
  const versions = normalizeVersions(data);
  if (versions.length === 0) return null;
  const wanted = String(data?.activeVersionId || '');
  return versions.find((item) => item.id === wanted) || versions[versions.length - 1];
}

/** 当前主图实际使用的提示词。已有版本时只认该版本，不回退到节点上可能属于旧版的提示词。 */
export function activePromptOf(data: CanvasNodeData | undefined): string {
  const active = activeVersionOf(data);
  const prompt = active ? active.prompt : data?.prompt;
  return String(prompt ?? '').trim();
}

/** 版本展开列表按生成时间倒序：最新结果始终排在第一位，不随手动主图选择变化。 */
export function newestVersionsFirst(data: CanvasNodeData | undefined): CanvasNodeVersion[] {
  return normalizeVersions(data).reverse();
}

/** 版本在链里的序号（1 起）；找不到返回 0。 */
export function versionIndexOf(data: CanvasNodeData | undefined, versionId: string): number {
  const versions = normalizeVersions(data);
  const index = versions.findIndex((item) => item.id === versionId);
  return index < 0 ? 0 : index + 1;
}

/** 版本角标：V1 / V2 / V3…（图上左上的小标签）。 */
export function versionLabel(index: number): string {
  return `V${Math.max(1, Math.round(index))}`;
}

/** 迭代次数：版本数减一（首版不算一次迭代），用于右上角数字角标。 */
export function reditCountOf(data: CanvasNodeData | undefined): number {
  return Math.max(0, normalizeVersions(data).length - 1);
}

/** 这一版是不是二次编辑来的（历史面板里标“基于 Vx”）。 */
export function isReditVersion(version: CanvasNodeVersion | undefined): boolean {
  return Boolean(version && String(version.baseVersionId || '').trim());
}
