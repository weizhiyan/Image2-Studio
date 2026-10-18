/**
 * Chat memory policy shared by the bridge agent runner.
 *
 * This module is intentionally pure: it does not call a model, read files, or
 * depend on the canvas store. The runner can persist `memory` together with a
 * thread and can replace `summaryDraft` with an LLM-written summary later.
 */

export type MemoryRole = 'user' | 'assistant';

export interface MemoryMessage {
  id?: string;
  role: MemoryRole;
  content?: string;
  createdAt?: string;
  attachments?: Array<Record<string, unknown>>;
  media?: Array<Record<string, unknown>>;
  toolCalls?: Array<Record<string, unknown>>;
}

export interface MemoryImageRef {
  canvasId?: string;
  nodeId?: string;
  versionId?: string;
  url?: string;
  title?: string;
  source?: 'attachment' | 'generated' | 'base';
}

export interface CurrentWorkGoal {
  mode: 'image' | 'video' | 'ui' | 'interaction' | 'mixed' | 'unknown';
  statement: string;
  deliverable?: string;
  confirmed: string[];
  preserve: string[];
  change: string[];
  rejected: string[];
  openQuestions: string[];
  updatedAt?: string;
}

export interface VisualWorkingSet {
  base?: MemoryImageRef;
  references: MemoryImageRef[];
  recentOutputs: MemoryImageRef[];
  inheritMode: 'auto' | 'edit' | 'new';
  explicitNewRequest: boolean;
}

/** Persist this object beside a thread. It contains no message bodies. */
export interface PersistedMemory {
  version?: number;
  summary?: string;
  summaryMessageCount?: number;
  summaryUpdatedAt?: string;
  goal?: Partial<CurrentWorkGoal>;
  visualWorkingSet?: Partial<VisualWorkingSet>;
  lastCompactionAt?: string;
}

export interface MemoryPolicy {
  /** Approximate token budget for the raw messages sent on every turn. */
  shortTermTokenBudget: number;
  /** Number of recent messages kept even when they are short. */
  shortTermMessageLimit: number;
  /** Start preparing a summary once the full history reaches this estimate. */
  summaryTriggerTokens: number;
  /** Target size for the generated/extractive summary. */
  summaryTargetTokens: number;
  /** Maximum number of image references in the working set. */
  maxReferences: number;
  /** Maximum number of generated outputs retained as visual candidates. */
  maxRecentOutputs: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  shortTermTokenBudget: 4_500,
  shortTermMessageLimit: 12,
  summaryTriggerTokens: 8_000,
  summaryTargetTokens: 900,
  maxReferences: 8,
  maxRecentOutputs: 4,
};

const EXPLICIT_NEW_REQUEST = /新需求|另一个|另外做|重新做|全新|从头开始|不基于|换一个方向|另起|新做一个|另外设计/;

function latestNewRequestIndex(messages: MemoryMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && EXPLICIT_NEW_REQUEST.test(String(messages[index].content || '').toLowerCase())) return index;
  }
  return -1;
}

export interface MemoryContext {
  summary: string;
  goal: CurrentWorkGoal;
  visualWorkingSet: VisualWorkingSet;
  shortTermMessages: MemoryMessage[];
  estimatedFullTokens: number;
  estimatedShortTermTokens: number;
  shouldCompact: boolean;
  /** Messages excluded from the short-term window and eligible for summarizing. */
  compactableMessages: MemoryMessage[];
  /** Deterministic fallback; a runner may replace it with an LLM summary. */
  summaryDraft: string;
  summaryMessageCount: number;
}

/** A conservative estimate that works for Chinese, English, and JSON-ish text. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uac00-\ud7a3]/g) || []).length;
  const latin = text.replace(/[\u3400-\u9fff\uac00-\ud7a3]/g, '').trim();
  // CJK tokenizers are close to one character/token; Latin prose averages 4 chars/token.
  return cjk + Math.ceil(latin.length / 4);
}

function messageTokens(message: MemoryMessage): number {
  return estimateTokens({
    role: message.role,
    content: message.content || '',
    attachments: message.attachments?.map((item) => ({ title: item.title, nodeId: item.nodeId, versionId: item.versionId })),
    media: message.media?.map((item) => ({ nodeId: item.nodeId, versionId: item.versionId, prompt: item.prompt })),
    toolCalls: message.toolCalls?.map((item) => ({ name: item.name, args: item.args })),
  });
}

function cleanText(value: unknown, max = 240): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function unique(values: string[], max = 8): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = cleanText(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= max) break;
  }
  return result;
}

function latestUserMessages(messages: MemoryMessage[]): MemoryMessage[] {
  return messages.filter((message) => message.role === 'user');
}

function inferMode(text: string): CurrentWorkGoal['mode'] {
  const value = text.toLowerCase();
  const image = /logo|标志|海报|插画|图片|图像|背景|图标|封面|视觉/.test(value);
  const video = /视频|video|动画|分镜|镜头运动/.test(value);
  const ui = /ui|界面|页面|组件|交互|按钮|弹窗|布局/.test(value);
  const interaction = /交互|动效|动画|hover|点击|拖拽|过渡/.test(value);
  const hits = [image, video, ui, interaction].filter(Boolean).length;
  if (hits > 1) return 'mixed';
  if (video) return 'video';
  if (ui) return 'ui';
  if (interaction) return 'interaction';
  if (image) return 'image';
  return 'unknown';
}

function extractGoal(messages: MemoryMessage[], previous?: Partial<CurrentWorkGoal>): CurrentWorkGoal {
  const users = latestUserMessages(messages);
  const allText = users.map((message) => String(message.content || '')).join('\n');
  const latest = cleanText(users.at(-1)?.content || previous?.statement || '未明确');
  const confirmed: string[] = [];
  const preserve: string[] = [];
  const change: string[] = [];
  const rejected: string[] = [];
  for (const message of users) {
    const text = cleanText(message.content, 360);
    if (/确认|确定|就这样|采用|保留|保持|不变/.test(text)) confirmed.push(text);
    if (/保留|保持|不变|继续沿用|不要改/.test(text)) preserve.push(text);
    if (/改|换|调整|增加|减少|删除|变成|优化|修改/.test(text)) change.push(text);
    if (/不要|不喜欢|不需要|排除|取消|去掉/.test(text)) rejected.push(text);
  }
  const assistantQuestions = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => cleanText(message.content, 220))
    .filter((text) => /[？?]$/.test(text));
  const mode = inferMode(allText);
  const deliverable = mode === 'image'
    ? '图像生成结果'
    : mode === 'video'
      ? '视频生成方案'
      : mode === 'ui' || mode === 'interaction'
        ? 'UI / 交互设计方案'
        : previous?.deliverable;
  return {
    mode,
    statement: latest,
    deliverable,
    confirmed: unique([...(previous?.confirmed || []), ...confirmed]),
    preserve: unique([...(previous?.preserve || []), ...preserve]),
    change: unique([...(previous?.change || []), ...change]),
    rejected: unique([...(previous?.rejected || []), ...rejected]),
    openQuestions: unique(assistantQuestions),
    updatedAt: users.at(-1)?.createdAt || previous?.updatedAt,
  };
}

function refFrom(raw: Record<string, unknown>, source: MemoryImageRef['source']): MemoryImageRef | null {
  const nodeId = String(raw.nodeId || '').trim();
  const versionId = String(raw.versionId || '').trim();
  const url = String(raw.url || '').trim();
  if (!nodeId && !versionId && !url) return null;
  return {
    canvasId: String(raw.canvasId || '').trim() || undefined,
    nodeId: nodeId || undefined,
    versionId: versionId || undefined,
    url: url || undefined,
    title: String(raw.title || '').trim() || undefined,
    source,
  };
}

function refKey(ref: MemoryImageRef): string {
  return `${ref.canvasId || ''}:${ref.nodeId || ''}@${ref.versionId || ref.url || ''}`;
}

function inferVisualWorkingSet(messages: MemoryMessage[], previous?: Partial<VisualWorkingSet>, policy = DEFAULT_MEMORY_POLICY): VisualWorkingSet {
  const attachments: MemoryImageRef[] = [];
  const outputs: MemoryImageRef[] = [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : undefined;
  const resetIndex = latestNewRequestIndex(messages);
  for (const item of latestUser?.attachments || []) {
    const ref = refFrom(item, 'attachment');
    if (ref) attachments.push(ref);
  }
  for (let index = 0; index < messages.length; index += 1) {
    if (index <= resetIndex) continue;
    const message = messages[index];
    for (const item of message.media || []) {
      const ref = refFrom(item, 'generated');
      if (ref) outputs.push(ref);
    }
    for (const call of message.toolCalls || []) {
      for (const item of (Array.isArray(call.media) ? call.media : []) as Array<Record<string, unknown>>) {
        const ref = refFrom(item, 'generated');
        if (ref) outputs.push(ref);
      }
    }
  }
  const dedupe = (items: MemoryImageRef[], max: number) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = refKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-max);
  };
  const recentOutputs = dedupe(outputs, policy.maxRecentOutputs);
  const references = dedupe(attachments, policy.maxReferences);
  const latestText = cleanText(latestUser?.content || '').toLowerCase();
  const explicitNewRequest = EXPLICIT_NEW_REQUEST.test(latestText);
  const explicitEdit = /基于|继续|沿用|保留|保持|改成|修改|调整|优化|细一些|粗一些|放大|缩小|加大|减小|更大|更小|换色|这张|上一张|刚才/.test(latestText);
  // 继承判断只看当前用户这句话：上一轮是新需求不能把“断开”粘到后续回合。
  // 没有明确编辑或新需求时回到 auto，由最近生成结果作为默认候选基准。
  const inheritMode: VisualWorkingSet['inheritMode'] = explicitNewRequest ? 'new' : explicitEdit ? 'edit' : 'auto';
  const previousBase = resetIndex < 0 && previous?.base && typeof previous.base === 'object' ? previous.base : undefined;
  const base = inheritMode === 'new'
    ? undefined
    : (recentOutputs.at(-1) || previousBase ? { ...(recentOutputs.at(-1) || previousBase), source: 'base' as const } : undefined);
  return { base, references, recentOutputs, inheritMode, explicitNewRequest };
}

function fallbackSummary(messages: MemoryMessage[], previousSummary: string, goal: CurrentWorkGoal, targetTokens: number): string {
  const users = latestUserMessages(messages).map((message) => cleanText(message.content, 260));
  const assistants = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => cleanText(message.content, 220))
    .filter(Boolean);
  const lines = [
    previousSummary ? `已有摘要：${cleanText(previousSummary, Math.max(300, targetTokens * 3))}` : '',
    `当前目标：${goal.statement}`,
    goal.deliverable ? `交付类型：${goal.deliverable}` : '',
    users.length > 0 ? `用户要求：${users.slice(-6).join('；')}` : '',
    goal.preserve.length > 0 ? `需保留：${goal.preserve.slice(-4).join('；')}` : '',
    goal.change.length > 0 ? `待修改：${goal.change.slice(-4).join('；')}` : '',
    goal.rejected.length > 0 ? `已否决：${goal.rejected.slice(-4).join('；')}` : '',
    assistants.length > 0 ? `已讨论：${assistants.slice(-3).join('；')}` : '',
  ].filter(Boolean);
  let summary = lines.join('\n');
  const maxChars = Math.max(600, targetTokens * 3);
  if (summary.length > maxChars) summary = `${summary.slice(0, maxChars - 1)}…`;
  return summary;
}

function selectShortTerm(messages: MemoryMessage[], policy: MemoryPolicy): { window: MemoryMessage[]; compactable: MemoryMessage[] } {
  let total = 0;
  const selected: MemoryMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cost = messageTokens(message);
    if (selected.length >= policy.shortTermMessageLimit) break;
    if (selected.length > 0 && total + cost > policy.shortTermTokenBudget) break;
    selected.push(message);
    total += cost;
  }
  selected.reverse();
  return { window: selected, compactable: messages.slice(0, Math.max(0, messages.length - selected.length)) };
}

export function buildMemoryContext(
  messages: MemoryMessage[],
  persistedMemory: PersistedMemory = {},
  overrides: Partial<MemoryPolicy> = {},
): MemoryContext {
  const policy = { ...DEFAULT_MEMORY_POLICY, ...overrides };
  const safeMessages = Array.isArray(messages) ? messages.filter((message) => message && (message.role === 'user' || message.role === 'assistant')) : [];
  const resetIndex = latestNewRequestIndex(safeMessages);
  const taskMessages = safeMessages.slice(Math.max(0, resetIndex));
  const selected = selectShortTerm(taskMessages, policy);
  const estimatedFullTokens = safeMessages.reduce((sum, message) => sum + messageTokens(message), 0);
  const estimatedShortTermTokens = selected.window.reduce((sum, message) => sum + messageTokens(message), 0);
  const resetAt = resetIndex >= 0 ? Date.parse(String(safeMessages[resetIndex]?.createdAt || '')) : NaN;
  const previousGoalAt = Date.parse(String(persistedMemory.goal?.updatedAt || ''));
  const resetPreviousGoal = resetIndex >= 0 && (!Number.isFinite(resetAt) || !Number.isFinite(previousGoalAt) || resetAt > previousGoalAt);
  const goal = extractGoal(taskMessages, resetPreviousGoal ? undefined : persistedMemory.goal);
  const visualWorkingSet = inferVisualWorkingSet(taskMessages, persistedMemory.visualWorkingSet, policy);
  const totalCompactableBoundary = safeMessages.length - selected.window.length;
  const previousSummaryCount = Math.max(0, Number(persistedMemory.summaryMessageCount) || 0);
  const summaryBoundary = Math.min(previousSummaryCount, totalCompactableBoundary);
  const compactableMessages = safeMessages.slice(summaryBoundary, totalCompactableBoundary);
  const shouldCompact = estimatedFullTokens >= policy.summaryTriggerTokens && compactableMessages.length > 0;
  const summary = String(persistedMemory.summary || '').trim();
  const summaryDraft = shouldCompact
    ? fallbackSummary(compactableMessages, summary, goal, policy.summaryTargetTokens)
    : summary;
  return {
    summary,
    goal,
    visualWorkingSet,
    shortTermMessages: selected.window,
    estimatedFullTokens,
    estimatedShortTermTokens,
    shouldCompact,
    compactableMessages,
    summaryDraft,
    summaryMessageCount: shouldCompact ? totalCompactableBoundary : previousSummaryCount,
  };
}

/** Stable prompt block for an agent; the runner can prepend it to the system spec. */
export function memoryPromptBlock(context: MemoryContext): string {
  const lines = [
    '【对话记忆】',
    context.summary ? `早期摘要：${context.summary}` : '早期摘要：暂无',
    `当前工作目标：${context.goal.statement}`,
    context.goal.deliverable ? `交付类型：${context.goal.deliverable}` : '',
    context.goal.preserve.length > 0 ? `必须保留：${context.goal.preserve.join('；')}` : '',
    context.goal.change.length > 0 ? `本轮关注：${context.goal.change.join('；')}` : '',
    context.goal.rejected.length > 0 ? `已否决方向：${context.goal.rejected.join('；')}` : '',
    context.visualWorkingSet.base?.versionId ? `默认候选基准版本：${context.visualWorkingSet.base.versionId}` : '默认候选基准版本：无',
    context.visualWorkingSet.inheritMode === 'new' ? '本轮判定：用户表达了全新需求，不继承上一张图。' : '',
  ].filter(Boolean);
  return lines.join('\n');
}

