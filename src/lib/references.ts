import type { CanvasReference } from '@/types';

/**
 * 引用完全由连线派生（syncComposerReferences / flowNodes 都按边现算），
 * 所以相等必须是严格相等：长度不同就是变了——哪怕 next 是空数组
 * （断开连接 / 点 × 删边后引用要能归零；曾把「有 → 无」当相等，chip 会留着关不掉）。
 */
export function areCanvasReferencesEqual(current: CanvasReference[] | undefined, next: CanvasReference[]): boolean {
  const currentList = Array.isArray(current) ? current : [];
  if (currentList.length !== next.length) return false;
  return currentList.every((item, index) => (
    String(item?.id || '') === next[index].id
    && String(item?.url || '') === next[index].url
    && String(item?.title || '') === next[index].title
    && (item?.kind || 'image') === (next[index].kind || 'image')
    && String(item?.text || '') === String(next[index].text || '')
  ));
}

/**
 * 有没有可用的上游文案引用（连过来的文案节点）。
 * 输入框空着也允许发送：文案节点的内容会以「参考：…」合并进提示词，
 * 用户不需要把同一段话再抄一遍——这是文案节点连图像节点的正常用法。
 */
export function hasUsableTextReference(references: CanvasReference[] | undefined): boolean {
  return (Array.isArray(references) ? references : []).some((item) => (
    String(item?.text || '').trim().length > 0
    && (item?.kind === 'text' || !String(item?.url || '').trim())
  ));
}

/**
 * 生成请求中的参考图编号说明。
 * 二次编辑的基准图会排在图片数组第一位，但不应该占用用户描述里的「图 1」。
 */
export function buildReferenceNumberingInstruction(
  externalImageCount: number,
  hasEditingBase: boolean,
): string {
  const count = Math.max(0, Math.floor(Number(externalImageCount) || 0));
  if (hasEditingBase) {
    return '第一张输入图是上次生成结果的二次编辑基准图，只作为编辑基准，不计入用户描述中的「图1 / 图2」编号；其后的连线参考图按提供顺序从图1开始编号。';
  }
  if (count < 2) return '';
  return `附带参考图编号（按提供顺序）：${Array.from({ length: count }, (_, index) => `图${index + 1}`).join('、')}。用户提到的「图一 / 图二」等均按此编号对应。`;
}
