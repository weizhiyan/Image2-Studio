import type { EnhanceLevel, MediaSettings, ModelProfileView } from '@/types';

/**
 * 直连生效值：节点没显式选过就跟随全局，全局缺省直连（true）。
 * 兼容语义：true = Image API；false = Responses 智能生成。与独立的提示词整理开关无关。
 */
export function resolveDirect(nodeDirect: boolean | undefined, globalDirect: boolean | undefined): boolean {
  if (typeof nodeDirect === 'boolean') return nodeDirect;
  return globalDirect !== false;
}

/**
 * 智能生成和设置里的独立优化开关都要经过提示词整理。
 * 旧代码只看 promptOptimizationEnabled，导致工具栏打开「智能生成」后
 * 仅切换了 Responses API，enhancedPrompt 始终为空，用户看不到优化链路。
 */
export function shouldEnhancePrompt(settings: MediaSettings | null, direct: boolean): boolean {
  return direct === false || settings?.promptOptimizationEnabled === true;
}

/** 优化提示词可用的语言模型：优先设置里选中的那把，否则第一把配好的。 */
export function pickTextProfile(settings: MediaSettings | null): ModelProfileView | null {
  if (!settings) return null;
  const list = (settings.profiles || []).filter((profile) => profile.kind === 'text');
  const chosen = list.find((profile) => profile.id === settings.textProfileId) || list[0] || null;
  return chosen && chosen.keyConfigured && chosen.model ? chosen : null;
}

/**
 * 整理强度三档。命名即语义，用户不用理解参数；只作用于语言模型那一次对话。
 * 节点工具栏与设置面板共用这一份，避免两处文案漂移。
 */
export const ENHANCE_LEVEL_OPTIONS: Array<{ value: EnhanceLevel; label: string; hint: string }> = [
  { value: 'strict', label: '高遵循', hint: '高遵循（听话）：尽量按你写的来，只补光线与画幅这类必要信息' },
  { value: 'balanced', label: '均衡', hint: '均衡（乖巧）：补齐必要细节，不改变你的意图' },
  { value: 'creative', label: '创意', hint: '创意（主见）：在意图内主动补氛围与环境细节，主体与动作不变' },
];

/** 当前档位的展示名；取值异常时回落均衡。 */
export function enhanceLevelLabel(level: EnhanceLevel | undefined): string {
  return ENHANCE_LEVEL_OPTIONS.find((option) => option.value === level)?.label || '均衡';
}
