import type { CanvasNodeData } from '@/types';

/** 节点身上全部 /api/files 媒体引用：删节点时按这个清单真删文件。
 *  只收服务端文件（/api/files/ 开头）；dataURL 形式的内嵌引用本来就在文档里，随节点一起消失。 */
export function collectMediaUrls(data: CanvasNodeData): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    const url = String(value || '').trim();
    if (url.startsWith('/api/files/')) urls.push(url);
  };
  push(data.imageUrl);
  for (const version of data.versions || []) push(version.imageUrl);
  return urls;
}

/** 粘贴副本的媒体改写：把克隆节点里指向原文件的引用换成刚复制出来的那份，
 *  副本因此与原件各占一个文件——删任一副本都不再伤到另一个。
 *  复制失败的引用不在表里，原地不动（图至少还在，只是仍与原件共享）。 */
export function applyMediaRemap(data: CanvasNodeData, remap: Map<string, string>): void {
  if (remap.size === 0) return;
  const next = (url: string | undefined): string | undefined => {
    const value = String(url || '').trim();
    return value ? (remap.get(value) || value) : url;
  };
  data.imageUrl = next(data.imageUrl);
  for (const version of data.versions || []) version.imageUrl = next(version.imageUrl) ?? '';
}

/** 撤回粘贴后清场：这批复制出来的媒体里，还有节点在引用的不动，没人引的才删。
 *  Composer 的 references 是派生缓存（同步时按边重算），但粘贴后、同步前的那一瞬它仍持旧引用，
 *  这里一并算「在用」——刚粘贴就被撤回时，别把旁边节点还在引的副本删掉。 */
export function orphanCopiedUrls(copiedUrls: string[], nodes: Array<{ data: CanvasNodeData }>): string[] {
  const used = new Set<string>();
  for (const node of nodes) {
    collectMediaUrls(node.data).forEach((url) => used.add(url));
    for (const reference of node.data.references || []) {
      const url = String(reference?.url || '').trim();
      if (url) used.add(url);
    }
  }
  return copiedUrls.filter((url) => !used.has(url));
}
