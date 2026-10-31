import type { CanvasDoc, CanvasNodeVersion } from '@/types';
import { normalizeVersions } from '@/lib/versions';

function versionTime(version: CanvasNodeVersion): number {
  const parsed = Date.parse(String(version.finishedAt || version.createdAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 画布最近一次生成的结果图：跨节点比较版本完成时间，同时间以文档中靠后的为准。 */
export function latestCanvasImageUrl(doc: CanvasDoc | undefined): string {
  let latestUrl = '';
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const node of doc?.nodes || []) {
    if (node.data?.kind !== 'image') continue;
    for (const version of normalizeVersions(node.data)) {
      const url = String(version.imageUrl || '').trim();
      if (!url) continue;
      const time = versionTime(version);
      if (time >= latestTime) {
        latestTime = time;
        latestUrl = url;
      }
    }
  }

  return latestUrl;
}
