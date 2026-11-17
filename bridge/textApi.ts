import { normalizeEnhanceLevel, type EnhanceLevel, type PreferenceEntry } from './settings.js';
import type { ModelProfile, TextApiFormat } from './settings.js';
import { describeHttpError } from './imageApi.js';
import { assertPromptAspect, assertPromptFacts, imageAspectPlan, imagePlanningTokenBudget, normalizeAspectRatio, PLANNED_IMAGE_RATIOS, promptAspectRatio } from './imagePlanning.js';
import { describeNetworkFailure } from './requestErrors.js';
import { compileVisualDesign, needsVisualReview, parseVisualDesign, parseVisualJson, visualDesignEnabled, visualDesignIssues, visualDesignRules, VISUAL_DESIGN_VERSION, VISUAL_REVIEW_RULES, type VisualDesign, type VisualDesignContext } from './visualDesign.js';

/** auto 的尝试顺序：先兼容面最广的 /chat/completions，路由类错误再回落 /responses。 */
const FORMAT_ORDER: Record<TextApiFormat, TextApiFormat[]> = {
  auto: ['chat', 'responses'],
  chat: ['chat'],
  responses: ['responses'],
};

/** 角色温度统一收口到 0-1。 */
function normalizeTemperature(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** 只识别明确的温度兼容性拒绝；提到 temperature 的其它参数错误不得触发重试。 */
export function isUnsupportedTemperatureError(detail: string): boolean {
  let message = detail;
  try {
    const payload = JSON.parse(detail) as { error?: { message?: string; param?: string; code?: string } };
    const error = payload.error;
    if (error?.param === 'temperature' && /unsupported|not_supported/i.test(error.code || '')) return true;
    message = error?.message || detail;
  } catch { /* 非 JSON 网关错误仍按明确文案判断。 */ }
  return /\btemperature\b[\s'":=-]*(?:is\s+)?(?:not supported|unsupported|not allowed|does not support|only supports)|(?:unsupported|unrecognized|unknown)\s+(?:parameter|argument|field|value)\s*:?\s*['"]?temperature\b|(?:does not support|not support)\s+(?:the\s+)?['"]?temperature\b/i.test(message);
}

/** 带状态码的调用失败：回落策略和报错文案都靠它判断。 */
class TextCallError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly format: TextApiFormat, readonly outputLimit = false) {
    super('text call failed');
  }
}

export interface EnhanceParams {
  signal?: AbortSignal;
  /** 参考图用法：缺省 'style'。由 bridge 入口规则预判或前端显式指定。 */
  usage?: ReferenceUsage;
  /** 用户在节点里写的原始提示词。 */
  prompt: string;
  /** 目标尺寸（1024x1024 / 1024x1536 / 1536x1024），用于让改写适配画幅。 */
  size?: string;
  aspectRatio?: string;
  referenceSize?: string;
  /** 上游参考图的 dataURL：带上后让语言模型先「看懂」参考图再融合。 */
  referenceDataUrls?: string[];
  /** 整理强度：高遵循 / 均衡 / 创意。 */
  level?: EnhanceLevel;
  /** 用户长期偏好档案；仅在开启时传入。 */
  preferences?: PreferenceEntry[];
  planningMode?: 'design' | 'legacy';
}

export interface PromptEnhancementResult {
  prompt: string;
  usage: ReferenceUsage;
  aspectRatio?: string;
  referenceRoles?: Array<{ index: number; role: string }>;
  design?: VisualDesign;
  planning?: { version: string; reviewed: boolean; repaired: boolean; issues: string[]; durationMs: number };
}

export const LEVEL_SPECS: Record<EnhanceLevel, { brief: string; words: string; freedom: string }> = {
  strict: {
    brief: '高遵循（尽量保持原文）',
    words: '清楚的原文可以原样返回，只补会影响执行的必要信息',
    freedom: '高遵循：保留用户的表达与全部已确定内容，只消除真实歧义、补充参考图对应及编辑边界；未指定的视觉细节交给生图模型，不新增设计方向',
  },
  balanced: {
    brief: '均衡（保留原意，补充必要信息）',
    words: '保留有效的原句，只为歧义、上下文或真实约束增加说明，不为短需求扩写',
    freedom: '均衡：以原文为基础，必要时整理文案分组、用途、参考关系和多轮修改要求；不主动指定用户未决定的主体、配色、字体、材质或布局，不把氛围要求换成具体物件清单',
  },
  creative: {
    brief: '创意（允许补充一个简短方向）',
    words: '需要构思时只补一个简短方向，保留视觉实现空间，不展开成逐项施工说明',
    freedom: '创意：用户尚无方案时可以补充一个服务目标的简短构思；不强行融合品牌名的每个字，不连带锁定整套颜色、字体、轮廓和布局。已有明确方案或局部编辑仍按原要求执行',
  },
};

/** 目标画幅 → 构图提示，改写时据此安排主体位置与留白。 */
function aspectHint(size: string): string {
  const [w, h] = size.split(/[x:]/).map((item) => Number(item));
  if (!w || !h) return `画幅为自动：依据用途、信息量、阅读顺序和构图选择适合的宽:高比例（${PLANNED_IMAGE_RATIOS.join('、')}），不要把未指定等同于 1:1。编辑已有图片时优先保留基准图画幅；仅借鉴风格时不必继承参考图比例。`;
  const ratio = w / h;
  if (ratio > 1.15) return `目标画幅 ${size}（${normalizeAspectRatio(size)} 横向宽画幅），这是已确定的生成参数；布局适配此画幅，不另写相反的比例。`;
  if (ratio < 0.87) return `目标画幅 ${size}（${normalizeAspectRatio(size)} 竖向画幅），这是已确定的生成参数；布局适配此画幅，不强制居中，不另写相反的比例。`;
  return `目标画幅 ${size}（${normalizeAspectRatio(size)}${ratio === 1 ? ' 方形' : ''}），这是已确定的生成参数，构图与其一致。`;
}

export function buildVisualPromptRules(size: string, level: EnhanceLevel): string {
  const spec = LEVEL_SPECS[level];
  return [
    '【以原文为基础】',
    '- 生图模型负责视觉构思和画面实现。你负责准确传递用户意图，处理真实歧义与上下文；优化不等于重写设计。原文已经清楚时可以原样返回；高遵循或均衡档位下，无需合并上下文、说明参考关系或消除歧义的单轮需求，必须逐字保留原文。',
    '- 保留原文中的目的、情绪、使用场景及表达重点，不能只留下物件和风格标签。只修改确实有歧义或缺少上下文的片段，其余原句保留；口语、短句、没有具体造型、文案较多，都不是必须改写的理由。不做同义润色，不增加通用设计口号。',
    '- 用户没想法、没有指定造型，不等于信息不足。将目标与期待感受交给生图模型构思，不默认由语言模型先锁定主体、配色、字体、光线、材质和布局。',
    '- 保留用户已经指定或明确采纳的设计。用户要求你构思一个方向或当前使用创意档位时，可以补一个简短方向；除此之外不增加未经要求的设计决定。不要把自己的建议当成用户确认的要求。',
    '- 多轮任务仅继承与当前作品有关的已确认内容，合并最新修改并去掉被明确替换的旧要求；新任务不继承上一张图的视觉方案。长期偏好仅在适用且不冲突时参考。',
    '',
    '【参考图用法】',
    '- 仅在有参考图时生效。图1、图2严格对应提供顺序；分别在最终提示词中说明各图需要借鉴或保留什么，一张图可承担多个作用，不把全部图片一律当风格参考。',
    '- 风格参考提取所需色彩、造型、媒介和质感，不自动复制无关主体或文字；主体 / 身份参考保护识别特征与必要内容；版式参考提取布局、对齐与层级，不照搬无关内容。',
    '- 原图编辑默认保护未要求修改的文字、Logo、UI、主体、构图和背景。用户明确要求改动某一项时按要求修改，该项不受默认保留规则限制。不要把“用户没再重复原图文字”理解为可以删掉文字。',
    '',
    '【忠实性红线】',
    '- 使用用户的主要语言，区分需求说明与图中文字。标题、品牌名、产品名、地址、声明及明确要求逐字呈现的内容一字不改，并用引号标明；不要把设计说明画进图中。未要求新文字时不自行新增文案。',
    '- 金额、日期、数量、限量、有效期及其条件关系必须保留。不能只保留数字而调换对应关系，不能把有条件赠送改成无条件赠送、概率奖励改成必得，不编造营销承诺。',
    '- 在不改变语义与精确文案的前提下允许分组和断行；非逐字指定的内容可以规范标点和日期格式（日期“号”与“日”等价，地址门牌号不等价）。',
    '- 用户明确的否定约束和必须保留项完整保留。除此之外优先正面描述，不自行禁止有价值的材质、颜色、光效或表现方式。缺少真实二维码等精确素材时预留空间，不伪造可验证信息。',
    '',
    '【整理强度】',
    `- 当前档位：${spec.brief}`,
    `- ${spec.freedom}`,
    `- 篇幅：${spec.words}`,
    '- 三档均保留事实与硬约束。不要套固定模板、堆形容词或罗列互斥备选；没有必要改动时，保留原文也是有效结果。',
    '',
    '【提交前自检】',
    '- 对照原文核对硬约束、精确文案、数值与条件关系、参考图用途和画幅。删除没有需求依据的新增限制，保留生图模型的视觉发挥空间；不因检查而再次扩写方案。',
    '- 这是生成前的文本检查，不代表成图已通过视觉验收。只有实际看到生成图片才能判断其画面与文字质量。',
    `- ${aspectHint(size)}`,
  ].join('\n');
}

export function buildSystemSpec(size: string, level: EnhanceLevel, hasReferenceImages: boolean = false): string {
  // ✅ 如果有参考图，先加视觉理解环节
  const visualAnalysisSection = hasReferenceImages ? `
【参考图分析流程】
依据用户要求判断每张图的作用，只分析与本次任务有关的特征；Logo不需要机械分析景深，摄影不需要套用标志设计清单。
风格、主体、版式、内容可分别参考或组合使用；把各图的实际用途和必须保留项写进最终prompt，不能只放在referenceRoles或分析说明中。
编辑时保护未要求修改的文字、Logo、UI及其他内容；用户明确要求修改的部分优先于默认保留规则。
` : '';

  return [
    '你是生图需求整理助手，保留用户表达，把准确的需求交给生图模型。',
    '你的唯一任务：以原文为基础，仅补执行所必需的信息，并返回匹配画幅；不默认重新设计。',
    '',
    visualAnalysisSection,
    '【输出格式】',
    '- 只输出一个 JSON 对象，不要 Markdown 代码块、解释、道歉或额外文字',
    '- JSON 必须包含 prompt（最终给生图模型的需求，可以与原文相同）、usage（style 或 edit）、aspectRatio（宽:高，如 2:3）',
    '- 已给目标尺寸时 aspectRatio 与其一致；画幅自动时按用途选择比例。画幅单独返回，不为补比例而重写原文，也不要在 prompt 写另一种画幅。',
    '- 可选字段 referenceRoles：数组元素为 {"index": number, "role": "style|identity|layout|object|background"}',
    hasReferenceImages ? '- 可选字段 analysisNotes（调试用）：对参考图的简短分析结论（50字内）' : '',
    '',
    buildVisualPromptRules(size, level),
  ].join('\n');
}

/**
 * 直连兜底：语言模型缺席时，用户只说了一句"按参考图风格生成呼应图"，
 * 生图模型会默认把参考图主体描出来。这里在 prompt 前补一段结构化场景指令——
 * 只加约束不改用户原意（与前端直连时注入的「参考图编号」段同类）。
 */
export function directStyleNote(prompt: string, usage: ReferenceUsage): string {
  if (usage !== 'style' || !/附带参考图编号/.test(String(prompt || ''))) return String(prompt || '');
  return `[参考图使用说明] 按用户要求借鉴参考图的风格、主体或版式；只参考风格时不自动复制无关主体与文字。用户明确要求保留的身份、内容和布局仍须保留，新作品不自动沿用整张参考图。\n${prompt}`;
}

export function preprocessDirectPrompt(
  prompt: string,
  _size?: string,
  _usage?: ReferenceUsage,
  _hasReference?: boolean
): string {
  return prompt.trim();
}

/**
 * GPT-image 官方语义（gpt-image-1 edits）：input_fidelity=high 时严格保留参考图中的
 * 主体 / 文字 / Logo 细节，low 时模型自由发挥。风格参考就该 low——从机制上松开复刻束缚，
 * 比在提示词里求它"别抄"有用得多；图生图才 high。
 */
export function fidelityForUsage(usage: ReferenceUsage): 'high' | 'low' {
  return usage === 'edit' ? 'high' : 'low';
}

/**
 * /api/generate 入口反推本次用法：优化后的 prompt 里带「本次用法」标记（最可信），
 * 直连时退回对用户原句做规则预判。
 */
export function usageForGenerateRequest(prompt: string, originalPrompt: string): ReferenceUsage {
  if (/本次用法：图生图/.test(String(prompt || ''))) return 'edit';
  if (/本次用法：风格参考/.test(String(prompt || ''))) return 'style';
  return detectReferenceUsage(originalPrompt || prompt);
}

/** 偏好档案注入：只在优化这一层生效，直连时整层被跳过。 */
function preferenceBlock(entries: PreferenceEntry[]): string {
  if (entries.length === 0) return '';
  return [
    '【用户长期偏好】以下是这位用户长期稳定的画面偏好，由他的历史生成归纳而来。',
    '这些偏好只在他本次没有明确要求时才遵循；与他本次的要求冲突时，一律以本次要求为准。',
    ...entries.map((entry) => `- ${entry.text}`),
  ].join('\n');
}

/**
 * 语言模型跑偏时的兜底：返回的不是可用提示词就抛错，调用方据此按原文发送。
 * 没有这道关，模型的道歉、说明文字、空结果会被原样发给生图模型。
 */
function assertUsablePrompt(text: string, original?: string): void {
  const cleaned = text.trim();
  if (!cleaned) throw new Error('语言模型没有返回内容');
  if (cleaned === original?.trim()) return;
  if (/\b(i'?m sorry|as an ai|cannot (?:assist|help|comply|generate)|unable to (?:assist|help|generate))\b/i.test(cleaned)
    || /作为(?:一个)?(?:人工智能|AI|语言模型)/.test(cleaned)
    || cleaned.startsWith('{') || cleaned.startsWith('[')) {
    throw new Error('语言模型返回的不是提示词（可能是说明文字或 JSON）');
  }
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk < 8 && words < 12) throw new Error('语言模型返回过短，无法作为提示词');
  if (cleaned.length > 24000) throw new Error('语言模型返回过长，已按原文发送');
}

/** 模型偶尔会把结果包在 ``` 里：剥掉码罩，取出纯提示词。 */
function stripFences(text: string): string {
  const fenced = /```(?:[a-zA-Z]*)\n?([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/** 兼容两种 content 形态：纯字符串，或 [{type:'text',text}] 分段。 */
function readContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

/** 拆出上游错误码（中转站爱把原因放在 error.code 里，如 ROUTER_INTERNAL_ERROR）。 */
function upstreamCode(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as { error?: { code?: unknown }; code?: unknown };
    const code = parsed?.error?.code || parsed?.code;
    return typeof code === 'string' && code ? code : '';
  } catch {
    return '';
  }
}

/** 这类状态码说明"这个接口路径不对 / 上游炸了"，换一种上游格式重试是有意义的。 */
function isRouteError(status: number): boolean {
  return status === 404 || status === 405 || status === 501 || status >= 500;
}

/** 把失败翻译成人话：除了上游原文，还告诉用户下一步该改哪里。 */
function describeTextError(err: TextCallError, fellBack: boolean): string {
  const head = describeHttpError('语言模型', err.status, err.detail);
  const code = upstreamCode(err.detail);
  const parts: string[] = [];
  if (fellBack && err.format === 'responses') parts.push('已自动改走 Responses 接口重试');
  if (code) parts.push(`上游错误码 ${code}`);
  if (err.outputLimit) {
    parts.push('输出上限不足，可能包含思考消耗；请提高输出上限或简化任务。本次未使用不完整提示词');
  } else if (err.status === 200 && /status=incomplete|没有最终 message|finish_reason=content_filter/i.test(err.detail)) {
    parts.push('未收到完整可用的最终回答，本次未使用该提示词');
  } else if (err.status === 200) {
    parts.push('响应结构对不上：这家中转站可能用了别的上游格式，去「生图设置」手动指定');
  } else if (err.status === 401 || err.status === 403) parts.push('Key 无效或没有该模型权限：确认这路配置填的是语言模型的 Key');
  else if (err.status === 404) parts.push('模型名或路径不对：点「获取模型」拿可用模型名，填「模型组名 / 可调用别名」');
  else if (err.status === 429) parts.push('被限流：稍后重试或换一路配置');
  else if (err.status === 400) parts.push('请求被上游拒绝：检查模型名与这路配置的上游格式');
  else if (err.status >= 500) parts.push('上游服务异常：稍后重试，或把「上游接口格式」改成 Responses / 换一路模型');
  return [head, ...parts].join('；');
}

interface TextRequest {
  url: string;
  body: unknown;
}

/** 候选 Base：用户常把 https://host 直接粘进来，而对方只开放 /v1 下的路由。
 *  实测 mdkj.lol 根路径被防护拦成 403 HTML，同 Key 打 /v1 完全正常——所以根路径不通时补 /v1 再试。 */
function baseCandidates(base: string): string[] {
  const list = [base];
  if (!/\/v1$/i.test(base)) list.push(`${base}/v1`);
  return list;
}

/** 值得换 Base 重试的失败：路由不存在，或根路径被网关 / 防护拦成 HTML 页。
 *  真正的鉴权失败回的是 JSON，不重试，避免同一错误打两遍。 */
function shouldRetryOtherBase(status: number, contentType: string): boolean {
  if (status === 404 || status === 405) return true;
  if (status === 401 || status === 403) return !/json/i.test(contentType || '');
  return false;
}

/** OpenAI 兼容 /chat/completions：messages 形式，参考图走 image_url 分段。 */
function chatRequest(base: string, model: string, systemSpec: string, userText: string, imageUrls: string[], maxTokens: number, temperature?: number): TextRequest {
  const normalizedTemperature = normalizeTemperature(temperature);
  const userContent: unknown = imageUrls.length > 0
    ? [
      { type: 'text', text: userText },
      ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ]
    : userText;
  return {
    url: `${base}/chat/completions`,
    body: {
      model,
      messages: [
        { role: 'system', content: systemSpec },
        { role: 'user', content: userContent },
      ],
      temperature: normalizedTemperature ?? 0.6,
      max_tokens: maxTokens,
    },
  };
}

/**
 * OpenAI /responses：instructions 放系统规范，input 是分段数组，
 * 参考图走 input_image。Codex 系路由器（只开放 Responses 的网关）只能走这条。
 */
function responsesRequest(base: string, model: string, systemSpec: string, userText: string, imageUrls: string[], maxTokens: number, temperature?: number): TextRequest {
  const normalizedTemperature = normalizeTemperature(temperature);
  const content: unknown[] = [{ type: 'input_text', text: userText }];
  imageUrls.forEach((url) => content.push({ type: 'input_image', image_url: url }));
  return {
    url: `${base}/responses`,
    body: {
      model,
      instructions: systemSpec,
      input: [{ role: 'user', content }],
      max_output_tokens: maxTokens,
      ...(typeof normalizedTemperature === 'number' ? { temperature: normalizedTemperature } : {}),
    },
  };
}

function readChatText(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> })?.choices;
  const finishReason = choices?.[0]?.finish_reason;
  if (finishReason === 'length' || finishReason === 'content_filter') {
    throw new TextCallError(200, `Chat 输出不完整或被过滤（finish_reason=${finishReason}），本次输出不可用`, 'chat', finishReason === 'length');
  }
  return stripFences(readContent(choices?.[0]?.message?.content));
}

function readResponsesText(body: unknown): string {
  if ((body as { status?: unknown })?.status === 'incomplete') {
    const outputLimit = (body as { incomplete_details?: { reason?: unknown } })?.incomplete_details?.reason === 'max_output_tokens';
    throw new TextCallError(200, 'Responses 返回 status=incomplete，没有生成完整最终回答', 'responses', outputLimit);
  }
  const payload = body as {
    output_text?: unknown;
    output?: Array<{
      type?: unknown;
      content?: Array<{ type?: string; text?: unknown } | string>;
    }>;
  };
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return stripFences(payload.output_text);
  }
  const parts: string[] = [];
  for (const item of payload?.output || []) {
    // Responses 会把 reasoning 和最终回答放在不同 output item 中。
    // 只能读取 message/output_text，不能把 reasoning_text 当成用户可见回复。
    if (item?.type && item.type !== 'message') continue;
    for (const part of item?.content || []) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      const type = String((part as { type?: unknown })?.type || '');
      if (type === 'reasoning_text' || type === 'reasoning') continue;
      if (type === 'output_text' || type === 'text' || !type) {
        const text = (part as { text?: unknown })?.text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  const text = stripFences(parts.join('\n'));
  if (!text) {
    throw new TextCallError(200, 'Responses 返回 200，但只有 reasoning 或没有最终 message 文本', 'responses');
  }
  return text;
}

interface TextCallParams {
  systemSpec: string;
  userText: string;
  imageUrls: string[];
  maxTokens: number;
  maxTokensOnTruncation?: number;
  /** 角色温度；chat 缺省 0.6，responses 仅在显式设置时发送。 */
  temperature?: number;
  signal?: AbortSignal;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 单次调用：按指定上游格式发请求，失败抛 TextCallError（带状态码与原文）。 */
async function callTextOnce(profile: ModelProfile, format: TextApiFormat, params: TextCallParams): Promise<string> {
  const base = profile.baseUrl.replace(/\/+$/, '');
  const model = String(profile.model || '').trim();
  if (!model) throw new Error(`语言模型「${profile.name}」还没填模型名`);
  const bases = baseCandidates(base);
  for (let index = 0; index < bases.length; index += 1) {
    const buildRequest = (includeTemperature: boolean): TextRequest => {
      const request = format === 'responses'
        ? responsesRequest(bases[index], model, params.systemSpec, params.userText, params.imageUrls, params.maxTokens, params.temperature)
        : chatRequest(bases[index], model, params.systemSpec, params.userText, params.imageUrls, params.maxTokens, params.temperature);
      if (!includeTemperature) delete (request.body as Record<string, unknown>).temperature;
      return request;
    };
    const signal = requestSignal(params.signal, format === 'responses' ? 120_000 : 90_000);
    const request = buildRequest(true);
    let response = await fetch(request.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal,
    });
    let detail = '';
    if (!response.ok) {
      detail = await response.text().catch(() => '');
      // 推理模型可能拒绝 temperature：去掉后重试一次。
      if (response.status === 400 && Object.hasOwn(request.body as object, 'temperature') && isUnsupportedTemperatureError(detail)) {
        const retry = buildRequest(false);
        response = await fetch(retry.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(retry.body),
          signal,
        });
        detail = '';
      }
    }
    if (!response.ok) {
      const finalDetail = detail || await response.text().catch(() => '');
      const contentType = response.headers.get('content-type') || '';
      const hasNextBase = index < bases.length - 1;
      // 根路径被拦 / 路由不存在时才换 /v1 重试；鉴权失败原样抛出
      if (hasNextBase && shouldRetryOtherBase(response.status, contentType)) continue;
      throw new TextCallError(response.status, finalDetail, format);
    }
    const parsed = await response.json().catch((error: unknown) => {
      if (error instanceof SyntaxError) return null;
      throw error;
    }) as unknown;
    const text = format === 'responses' ? readResponsesText(parsed) : readChatText(parsed);
    if (!text) throw new TextCallError(200, `接口返回 200 但解析不到文本（${format} 响应结构不匹配）`, format);
    return text;
  }
  throw new TextCallError(404, '语言模型接口地址不可达', format);
}

/** 按配置的上游格式调用；auto 会在路由类错误时自动换一种格式再试。 */
export async function callTextModel(profile: ModelProfile, params: TextCallParams): Promise<string> {
  const order = FORMAT_ORDER[profile.textFormat] || FORMAT_ORDER.auto;
  let lastError: TextCallError | null = null;
  let fellBack = false;
  for (const format of order) {
    let requestParams = params;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await callTextOnce(profile, format, requestParams);
      } catch (err) {
        if (!(err instanceof TextCallError)) throw describeNetworkFailure(err, 'text') || err;
        const retryBudget = Math.min(16000, Math.floor(params.maxTokensOnTruncation || 0));
        if (err.outputLimit && attempt === 0 && retryBudget > params.maxTokens && !params.signal?.aborted) {
          requestParams = { ...params, maxTokens: retryBudget };
          continue;
        }
        lastError = err;
        const isLast = format === order[order.length - 1];
        if (isLast || !isRouteError(err.status)) throw new Error(describeTextError(err, fellBack));
        fellBack = true;
        break;
      }
    }
  }
  throw new Error(describeTextError(lastError as TextCallError, fellBack));
}

/**
 * 参考图用法预判：不需要用户选，也不需要模型猜。
 * - edit：用户要改这张图本身（基于 / 改成 / 换上 / 去掉…）
 * - style：用户要的是气质呼应 / 新场景 / 背景 / 页面配图（默认走这路，
 *   参考图直传生图接口默认就是"改造这张图"，不显式声明必复刻）
 */
export type ReferenceUsage = 'style' | 'edit';

const EDIT_HINTS = /(基于|改成|改为|换成|换上|加上|去掉|去除|删掉|扩图|扩展画布|延展画布|补全画面|补足画面|把这张|在这张|修改|调整这|[余其]中|based on|modify|edit|replace|remove|add to|change|outpaint)/i;
const GEN_HINTS = /(生成|画一|做一|来一|创作|新的|generate|create|make a)/i;

export function detectReferenceUsage(prompt: string): ReferenceUsage {
  const text = String(prompt || '').trim();
  if (!text) return 'style';
  // 明确要改图本身、且没有"画一张新的"的意图才算 edit；
  // 其余（风格 / 呼应 / 做背景 / 无任何提示）一律 style——宁可少复刻主体，
  // 也不能把参考图原样描出来（用户实测最反感的结果）
  return EDIT_HINTS.test(text) && !GEN_HINTS.test(text) ? 'edit' : 'style';
}

function parseEnhancementResult(raw: string, fallbackUsage: ReferenceUsage): PromptEnhancementResult {
  const cleaned = stripFences(raw).trim();
  try {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    const parsed = JSON.parse(first >= 0 && last > first ? cleaned.slice(first, last + 1) : cleaned) as {
      prompt?: unknown;
      usage?: unknown;
      aspectRatio?: unknown;
      referenceRoles?: unknown;
    };
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
    if (prompt) {
      const usage = parsed.usage === 'edit' || parsed.usage === 'style' ? parsed.usage : fallbackUsage;
      const referenceRoles = Array.isArray(parsed.referenceRoles)
        ? parsed.referenceRoles.map((item) => {
          const entry = (item || {}) as Record<string, unknown>;
          const index = Number(entry.index);
          const role = String(entry.role || '').trim();
          return Number.isInteger(index) && index > 0 && role ? { index, role } : null;
        }).filter((item): item is { index: number; role: string } => Boolean(item))
        : undefined;
      return { prompt, usage, referenceRoles, aspectRatio: normalizeAspectRatio(parsed.aspectRatio) };
    }
  } catch {
    /* 兼容不支持结构化输出的中转站：下面按纯 prompt 处理。 */
  }
  return { prompt: cleaned, usage: fallbackUsage };
}

/**
 * 用语言 / 多模态模型整理提示词。
 * 带参考图时让它先「看懂」参考图再融合用户要求（chat 走 image_url、responses 走 input_image）。
 */
export async function enhancePromptDetailed(profile: ModelProfile, params: EnhanceParams): Promise<PromptEnhancementResult> {
  const apiKey = String(profile.apiKey || '').trim();
  if (!apiKey) {
    throw new Error(`尚未配置语言模型 Key：请在「生图设置」的「${profile.name}」里填写`);
  }
  const level = normalizeEnhanceLevel(params.level);
  const structured = params.planningMode === 'design' || (params.planningMode !== 'legacy' && visualDesignEnabled());
  const startedAt = Date.now();
  const userText = `用户想画的内容：\n${params.prompt.trim()}`;
  const imageUrls = (params.referenceDataUrls || []).filter((url) => url.startsWith('data:image/'));
  // 多张参考图必须带编号语义：用户嘴里的「图一 / 图二」就是画布 chips 上标的序号，
  // 而 chips 序号 = 本数组下标顺序。不写清楚，模型会按画面内容自行配对，张冠李戴。
  const numbering = imageUrls.map((_, index) => `参考图 ${index + 1} = 第 ${index + 1} 张图`).join('，');
  const usage = params.usage || 'style';
  const isOutpaintRequest = /(扩图|扩展画布|延展画布|补全画面|补足画面|扩展到|改为\s*\d{1,2}\s*[:：]\s*\d{1,2})/i.test(params.prompt);
  const usageRule = structured
    ? usage === 'edit'
      ? '\n\n本次是已有图的编辑：design.mode 使用 edit，记录 changes 和 preserve。扩图只新增画布区域，保留原图已有内容；其它编辑只改变用户指定部分。'
      : '\n\n依据用户目的选择 design.mode：借用参考创作为 reference，直接修改原图为 edit。逐张在 design.references 写明用途，不能把只参考风格变成复制原图主体。'
    : usage === 'edit'
    ? isOutpaintRequest
      ? `\n\n本次用法：扩图 / 画布延展。不是重绘，也不是风格参考。必须保留参考图中已有的主体、位置、比例、视角、光线、色彩和细节，原图区域只作为不可改动的已存在画面；只描述需要新增的画布区域及其与原图边缘的自然衔接。若用户指定主体位于左侧、右侧留白等空间关系，必须原样保留，不得把原图主体改成新的主体。`
      : `\n\n本次用法：图生图——按用户要求修改指定部分，保护其余内容，包括原有文字、Logo、UI和背景。若用户明确要求改主体或构图，按要求修改，不受默认保留规则限制。`
    : `\n\n本次整体用法预判：参考创作。以用户描述为准分别确定每张图的实际作用；风格、主体身份、版式和内容可以组合参考，不把全部图片强制当成纯风格。用户要求呼应但不同的新场景时，保留这个创作目标，不擅自锁定新的具体主体；明确指定的主体、布局和保留项仍须遵守。若实际是修改原图，usage应返回edit并保护未要求修改的内容。每张图的用途必须写进prompt，不只写在referenceRoles中。`;
  const referenceOutput = structured
    ? '在 design.references 中逐张写明用途与必要保留项，程序将这些结论编译到最终提示词。'
    : '请在 JSON 的 referenceRoles 中标注每张图的作用；各图用途与必要保留项写进prompt，其余分析过程不输出。';
  const referenceGuide = imageUrls.length > 1
      ? `\n\n（本次附带 ${imageUrls.length} 张参考图，按消息中的提供顺序编号：${numbering}。用户提到的「图一 / 图二 / 图1 / 图2」等说法一律按此编号对应，不要按画面内容自行调换顺序。${usageRule}\n${referenceOutput}）`
      : imageUrls.length === 1
      ? `\n\n（另附 1 张参考图。${usageRule}\n${referenceOutput}）`
      : '';
  // 参考图融合说明拼在用户段里：chat 只认 text 分段、responses 只认 input_text 分段
  const withReferences = imageUrls.length > 0
    ? `${userText}${referenceGuide}`
    : userText;
  // ✅ 检测是否有参考图
  const hasReferenceImages = Boolean(params.referenceDataUrls && params.referenceDataUrls.length > 0);
  const aspect = imageAspectPlan(params);
  const plannedSize = aspect.locked
    ? (normalizeAspectRatio(params.size) === aspect.aspectRatio ? params.size! : aspect.aspectRatio)
    : '';
  const spec = [
    structured ? visualDesignRules(LEVEL_SPECS[level].freedom, aspectHint(plannedSize)) : buildSystemSpec(plannedSize, level, hasReferenceImages),
    !aspect.locked && params.referenceSize ? `参考图尺寸 ${params.referenceSize} 仅作判断依据，不是固定输出尺寸；用途和用户本次需求优先。` : '',
    preferenceBlock(params.preferences || []),
  ].filter(Boolean).join('\n\n');
  const text = await callTextModel(profile, {
    systemSpec: spec,
    userText: withReferences,
    imageUrls,
    maxTokens: imagePlanningTokenBudget(params.prompt),
    maxTokensOnTruncation: 16000,
    temperature: level === 'strict' ? 0.2 : level === 'creative' ? 0.85 : 0.6,
    signal: params.signal,
  });
  if (structured) {
    let design: unknown;
    try { design = parseVisualJson(text).design; } catch { design = text; }
    const result = await finishVisualDesign(profile, design, {
      prompt: params.prompt,
      lockedAspect: aspect.locked ? aspect.aspectRatio : undefined,
      referenceCount: imageUrls.length,
      usage: imageUrls.length ? params.usage : undefined,
    }, { imageUrls, signal: params.signal });
    result.planning!.durationMs = Date.now() - startedAt;
    return result;
  }
  // 跑偏兜底：抛错让调用方按原文继续发，别把道歉发给生图模型
  const result = parseEnhancementResult(text, usage);
  assertUsablePrompt(result.prompt, params.prompt);
  result.aspectRatio = aspect.locked
    ? aspect.aspectRatio
    : result.aspectRatio || promptAspectRatio(result.prompt) || aspect.aspectRatio;
  assertPromptAspect(result.prompt, result.aspectRatio);
  assertPromptFacts(params.prompt, result.prompt);
  if (params.usage === 'edit') result.usage = 'edit';
  return result;
}

export async function finishVisualDesign(
  profile: ModelProfile,
  value: unknown,
  context: VisualDesignContext,
  options: { imageUrls: string[]; signal?: AbortSignal },
): Promise<PromptEnhancementResult> {
  const startedAt = Date.now();
  let design: VisualDesign | undefined;
  let issues: string[];
  try {
    design = parseVisualDesign(value);
    issues = visualDesignIssues(design, context);
  } catch (error) {
    issues = [error instanceof Error ? error.message : String(error)];
  }
  const reviewed = issues.length > 0 || (design ? needsVisualReview(design, context) : true);
  let repaired = false;
  if (reviewed) {
    const review = parseVisualJson(await callTextModel(profile, {
      systemSpec: `${visualDesignRules('只修正明确问题，保留原方案的创作方向。', context.lockedAspect ? aspectHint(context.lockedAspect) : '保留合理的已选画幅。')}\n\n本次是核对阶段，以下核对输出协议替代设计阶段的输出协议：\n${VISUAL_REVIEW_RULES}`,
      userText: JSON.stringify({ sourceText: context.sourceText || context.prompt, currentRequest: context.prompt, referenceCount: context.referenceCount, lockedAspect: context.lockedAspect, issues, design: design || value }),
      imageUrls: options.imageUrls,
      maxTokens: imagePlanningTokenBudget(context.prompt),
      maxTokensOnTruncation: 16000,
      temperature: 0.2,
      signal: options.signal,
    }));
    if (!Array.isArray(review.issues) || review.issues.some(issue => typeof issue !== 'string')) throw new Error('设计核对未返回有效问题清单，本次不采用未核对的改写');
    issues = [...issues, ...review.issues as string[]];
    if (review.design) {
      design = parseVisualDesign(review.design);
      repaired = true;
    } else if (issues.length) {
      throw new Error(`设计核对未能修正：${issues.join('；')}`);
    }
  }
  if (!design) throw new Error('没有可用设计结果');
  const remaining = visualDesignIssues(design, context);
  if (remaining.length) throw new Error(`设计核对后仍不符合需求：${remaining.join('；')}`);
  const prompt = compileVisualDesign(design);
  assertUsablePrompt(prompt);
  return {
    prompt, aspectRatio: design.aspectRatio, usage: design.mode === 'edit' ? 'edit' : 'style', design,
    referenceRoles: design.references.map(item => ({ index: item.index, role: item.use })),
    planning: { version: VISUAL_DESIGN_VERSION, reviewed, repaired, issues: [...new Set(issues)], durationMs: Date.now() - startedAt },
  };
}

export async function enhancePrompt(profile: ModelProfile, params: EnhanceParams): Promise<string> {
  return (await enhancePromptDetailed(profile, params)).prompt;
}

export function buildVideoPromptSpec(input: {
  ratio?: string;
  seconds?: number;
  resolution?: string;
  referenceMode?: string;
}): string {
  const referenceLabel = input.referenceMode === 'style'
    ? '风格参考图'
    : input.referenceMode === 'last_frame'
      ? '尾帧参考图'
      : '首帧参考图';
  return [
    '你是视频生成提示词编辑器。把用户原始描述整理成可直接提交给视频生成模型的一段提示词。',
    '只输出最终提示词，不要标题、解释、Markdown、JSON 或选项。保持用户使用的主要语言。',
    '完整保留用户指定的主体、动作、场景、风格和因果关系；不能替换主体，不能擅自增加角色、道具、剧情或场景。',
    '把描述整理为清楚的时间推进：开场状态、主要动作、镜头运动、结束状态。用户未指定的运动和节奏只做克制补充，不要堆叠多个互相冲突的运镜。',
    `目标参数：画幅 ${input.ratio || '16:9'}，时长 ${Number(input.seconds) || 5} 秒，清晰度 ${input.resolution || '480p'}。这些是生成参数，不要把它们变成画面中的文字。`,
    `本次如提供参考图片，按「${referenceLabel}」理解其用途。不要声称识别或看到了图片的具体内容；仅依据用户文字描述整理动作与镜头。`,
  ].join('\n');
}

export async function optimizeVideoPrompt(profile: ModelProfile, input: {
  prompt: string;
  ratio?: string;
  seconds?: number;
  resolution?: string;
  referenceMode?: string;
}): Promise<string> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw new Error('视频描述不能为空');
  const result = await callTextModel(profile, {
    systemSpec: buildVideoPromptSpec(input),
    userText: prompt,
    imageUrls: [],
    maxTokens: 1000,
  });
  const optimized = stripFences(result).trim();
  if (!optimized || optimized.startsWith('{') || /作为(?:一个)?(?:人工智能|AI|语言模型)/.test(optimized)) {
    throw new Error('语言模型没有返回可用的视频提示词');
  }
  if (optimized.length < 6 || optimized.split(/\s+/).filter(Boolean).length > 400) {
    throw new Error('视频提示词长度异常，请缩短原始描述后重试');
  }
  return optimized;
}

/** 通用文本问答：偏好归纳这类非生图任务复用同一条调用链（格式回落 + 人话报错）。 */
export async function askTextProfile(profile: ModelProfile, input: {
  systemSpec: string;
  userText: string;
  maxTokens?: number;
}): Promise<string> {
  return callTextModel(profile, {
    systemSpec: input.systemSpec,
    userText: input.userText,
    imageUrls: [],
    maxTokens: input.maxTokens || 800,
  });
}

/** 语言模型连通性测试：一次最小对话，不烧生图额度。 */
export async function testTextProfile(profile: ModelProfile): Promise<string> {
  const apiKey = String(profile.apiKey || '').trim();
  if (!apiKey) throw new Error(`尚未配置 API Key：请在「生图设置」的「${profile.name}」里填写`);
  const reply = await callTextModel(profile, {
    systemSpec: '你是连通性测试助手，只回复用户要求的两个字。',
    userText: '回复 OK 两个字符即可',
    imageUrls: [],
    // DeepSeek 的 Responses 会把预算分给 reasoning；64 在复杂路由上可能只够思考，
    // 导致测试误报或没有最终 message。连通测试使用小但足够的预算。
    maxTokens: 256,
  });
  return `语言模型连通正常，回复：${reply.slice(0, 40)}`;
}
