import { normalizeEnhanceLevel, type EnhanceLevel, type PreferenceEntry } from './settings.js';
import type { ModelProfile, TextApiFormat } from './settings.js';
import { describeHttpError } from './imageApi.js';

/** auto 的尝试顺序：先兼容面最广的 /chat/completions，路由类错误再回落 /responses。 */
const FORMAT_ORDER: Record<TextApiFormat, TextApiFormat[]> = {
  auto: ['chat', 'responses'],
  chat: ['chat'],
  responses: ['responses'],
};

/** 带状态码的调用失败：回落策略和报错文案都靠它判断。 */
class TextCallError extends Error {
  constructor(readonly status: number, readonly detail: string, readonly format: TextApiFormat) {
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
  /** 上游参考图的 dataURL：带上后让语言模型先「看懂」参考图再融合。 */
  referenceDataUrls?: string[];
  /** 整理强度：高遵循 / 均衡 / 创意。 */
  level?: EnhanceLevel;
  /** 用户长期偏好档案；仅在开启时传入。 */
  preferences?: PreferenceEntry[];
}

export interface PromptEnhancementResult {
  prompt: string;
  usage: ReferenceUsage;
  referenceRoles?: Array<{ index: number; role: string }>;
}

/**
 * 三档整理强度。只改"这次对话怎么改写"的松紧，不碰生图模型的任何参数：
 * - strict：用户写什么画什么，只补光线与画幅这类必要维度；
 * - balanced：用户没提到的重要维度才补，已提的尊重原意；
 * - creative：允许在用户意图内补氛围、环境细节与风格联想，主体不得替换。
 */
export const LEVEL_SPECS: Record<EnhanceLevel, { brief: string; words: string; freedom: string }> = {
  strict: {
    brief: '高遵循（用户写什么就画什么）',
    words: '60–100 词',
    freedom: '只做轻度整理：可补光线与画幅构图，其余用户没提的元素一律不加，措辞尽量保留原样',
  },
  balanced: {
    brief: '均衡（补齐必要细节，不改变意图）',
    words: '80–150 词',
    freedom: '用户没提到的重要视觉维度才补；已提到的一律尊重原意；不引入用户没说的新主体',
  },
  creative: {
    brief: '创意（在用户意图内主动发挥）',
    words: '120–180 词',
    freedom: '可补充氛围、环境细节、次要道具与风格联想来强化画面；主体与核心动作不得替换或增加',
  },
};

/** 目标画幅 → 构图提示，改写时据此安排主体位置与留白。 */
function aspectHint(size: string): string {
  const [w, h] = size.split('x').map((item) => Number(item));
  if (!w || !h) return '画幅未指定，按 1:1 方形构图';
  const ratio = w / h;
  if (ratio > 1.15) return `目标画幅 ${size}（${ratio.toFixed(2)}:1 横向宽画幅）：横向展开构图，主体与地平线沿画面左右方向铺陈`;
  if (ratio < 0.87) return `目标画幅 ${size}（${ratio.toFixed(2)}:1 竖向画幅）：纵向构图，主体居中或置于画面中轴线，利用上下空间表现层次`;
  return `目标画幅 ${size}（1:1 方形）：主体居中或对角线构图，注意四角留白`;
}

/**
 * 提示词工程规范：来源是 OpenAI 官方对 gpt-image 系列公开的生图提示词建议
 * （自然语言完整描述 / 具体细节 / 图内文字加引号 / 媒介与镜头词 / 空间位置描述 /
 *  说"要什么"而非"不要什么"）+ ChatGPT 网页版生图的编排层行为（理解意图 →
 *  补齐缺失视觉维度 → 输出单段详细提示词 → 内容安全红线）。
 */
export function buildSystemSpec(size: string, level: EnhanceLevel): string {
  const spec = LEVEL_SPECS[level];
  return [
    '你是图像生成模型的提示词工程师。用户会给一句想画的内容（可能很短、很口语），也可能是中文。',
    '你的唯一任务：把它改写成一段高质量的生图提示词，原文语义一个不丢。',
    '',
    '【输出格式】',
    '- 只输出一个 JSON 对象，不要 Markdown 代码块、解释、道歉或额外文字',
    '- JSON 必须包含 prompt（最终给生图模型的一段自然语言提示词）和 usage（style 或 edit）',
    '- 可选字段 referenceRoles：数组元素为 {"index": number, "role": "style|identity|layout|object|background"}',
    '- prompt 使用用户描述的主要语言；用户要求图中文字时按原语言用英文引号 "..." 精确保留，一字不改',
    '- prompt 是一段连贯的自然语言，完整句子；不要关键词堆砌、标签列表或分点',
    '- 图中的文字内容用英文引号包裹，例如：a neon sign reading "OPEN 24H"',
    '',
    '【描述结构：用户没提到的维度才补，已提到的一律尊重原意】',
    '1. 主体：谁 / 什么，外貌、姿态、表情、服饰、材质',
    '2. 动作与场景：在做什么、环境、时间、天气、季节',
    '3. 构图与镜头：景别（特写 / 半身 / 全身 / 全景）、机位、视角、空间关系（如 "positioned in the left third"）',
    '4. 光线：光源方向、软硬、色温、时段氛围',
    '5. 色彩与影调：主色、对比度、饱和度倾向',
    '6. 媒介与风格：具体媒介（如 35mm film photography, watercolor, 3D render, flat vector illustration）',
    '7. 质感与细节：纹理、精度程度（如 highly detailed, soft focus）',
    '',
    '【参考图用法（只在附带参考图时生效）】',
    '- 判断依据是用户的措辞：用户说"根据…风格 / 呼应 / 同样的感觉 / 调性像" → 只迁移参考图的氛围、色系、光线、质感与图层结构（天地海如何分层、主体偏左还是居中），绝不复刻参考图里的具体主体、构图、文字与版式元素',
    '- 用户说"基于这张图 / 把这张图改成 / 加上" → 图生图模式：保留参考图的主体与构图，只应用用户要求的改动',
    '- 用户指定用途（做背景 / 放在某页 / 结尾用）时，必须在提示词里写明为文字预留的干净区域的位置与大致占比',
    '- 参考图里出现的文字、Logo、UI 元素一律不进最终提示词（用户没要求图内文字时）',
    '',
    '【忠实性红线】',
    '- 用户明确要的元素一个不少；用户没提的重要元素一个不加（没说人就不加人，没说文字就不加文字）',
    '- 用户输入已足够详细（超过 40 词，或已含镜头 / 媒介 / 风格描述）时只做轻度整理：补光线与构图，保留原有措辞与细节',
    '- 描述"要什么"而不是"不要什么"；最多保留一处关键排除（如 "no text, no watermark"）',
    '- 用户明确提供的本人品牌 Logo / 标识应按原样保留，不擅自改写；要求复制未提供的第三方受保护角色或标识时，改写成气质相近的原创元素',
    '- 不使用在世艺术家的姓名作为风格词；用流派或视觉特征描述替代',
    '',
    '【整理强度】',
    `- 当前档位：${spec.brief}`,
    `- ${spec.freedom}`,
    `- 输出长度：${spec.words}`,
    '【现实约束】',
    '- 生图模型内部还会再润色一次提示词，所以不要写过度精细到互相冲突的细节',
    `- ${aspectHint(size)}`,
  ].join('\n');
}

/**
 * 直连兜底：语言模型缺席时，用户只说了一句"按参考图风格生成呼应图"，
 * 生图模型会默认把参考图主体描出来。这里在 prompt 前补一段结构化场景指令——
 * 只加约束不改用户原意（与前端直连时注入的「参考图编号」段同类）。
 */
export function directStyleNote(prompt: string, usage: ReferenceUsage): string {
  if (usage !== 'style' || !/附带参考图编号/.test(String(prompt || ''))) return String(prompt || '');
  return `[风格参考约束] 附带图片只提供风格（色系、光线氛围、质感），请生成一个主体与构图都不同于参考图的全新场景，并正面写清新场景里有什么；不要以原参考图的主体作画面主角。\n${prompt}`;
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
function assertUsablePrompt(text: string): void {
  const cleaned = text.trim();
  if (!cleaned) throw new Error('语言模型没有返回内容');
  if (/\b(i'?m sorry|as an ai|cannot (?:assist|help|comply|generate)|unable to (?:assist|help|generate))\b/i.test(cleaned)
    || /作为(?:一个)?(?:人工智能|AI|语言模型)/.test(cleaned)
    || cleaned.startsWith('{') || cleaned.startsWith('[')) {
    throw new Error('语言模型返回的不是提示词（可能是说明文字或 JSON）');
  }
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  const cjk = (cleaned.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk < 8 && words < 12) throw new Error('语言模型返回过短，无法作为提示词');
  if (words > 400) throw new Error('语言模型返回过长，已按原文发送');
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
  if (err.status === 200 && /status=incomplete|思考输出耗尽|没有最终 message/i.test(err.detail)) {
    parts.push('模型只完成了思考，没有生成最终回答：请提高输出上限，或把「上游接口格式」改成 Chat Completions');
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
function chatRequest(base: string, model: string, systemSpec: string, userText: string, imageUrls: string[], maxTokens: number): TextRequest {
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
      temperature: 0.6,
      max_tokens: maxTokens,
    },
  };
}

/**
 * OpenAI /responses：instructions 放系统规范，input 是分段数组，
 * 参考图走 input_image。Codex 系路由器（只开放 Responses 的网关）只能走这条。
 */
function responsesRequest(base: string, model: string, systemSpec: string, userText: string, imageUrls: string[], maxTokens: number): TextRequest {
  const content: unknown[] = [{ type: 'input_text', text: userText }];
  imageUrls.forEach((url) => content.push({ type: 'input_image', image_url: url }));
  return {
    url: `${base}/responses`,
    body: {
      model,
      instructions: systemSpec,
      input: [{ role: 'user', content }],
      max_output_tokens: maxTokens,
    },
  };
}

function readChatText(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices;
  return stripFences(readContent(choices?.[0]?.message?.content));
}

function readResponsesText(body: unknown): string {
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
  const incomplete = (body as { status?: unknown })?.status === 'incomplete';
  if (!text && incomplete) {
    throw new TextCallError(200, 'Responses 返回 status=incomplete，思考输出耗尽预算，没有生成最终回答', 'responses');
  }
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
    const { url, body } = format === 'responses'
      ? responsesRequest(bases[index], model, params.systemSpec, params.userText, params.imageUrls, params.maxTokens)
      : chatRequest(bases[index], model, params.systemSpec, params.userText, params.imageUrls, params.maxTokens);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal(params.signal, format === 'responses' ? 120_000 : 90_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const contentType = response.headers.get('content-type') || '';
      const hasNextBase = index < bases.length - 1;
      // 根路径被拦 / 路由不存在时才换 /v1 重试；鉴权失败原样抛出
      if (hasNextBase && shouldRetryOtherBase(response.status, contentType)) continue;
      throw new TextCallError(response.status, detail, format);
    }
    const parsed = await response.json().catch(() => null) as unknown;
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
    try {
      return await callTextOnce(profile, format, params);
    } catch (err) {
      if (!(err instanceof TextCallError)) throw err;
      lastError = err;
      const isLast = format === order[order.length - 1];
      // 路由类错误（404/405/5xx）才值得换格式重试；400/401/429 换了也是同样结果
      if (isLast || !isRouteError(err.status)) throw new Error(describeTextError(err, fellBack));
      fellBack = true;
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
      return { prompt, usage, referenceRoles };
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
  const userText = `用户想画的内容：\n${params.prompt.trim()}`;
  const imageUrls = (params.referenceDataUrls || []).filter((url) => url.startsWith('data:image/'));
  // 多张参考图必须带编号语义：用户嘴里的「图一 / 图二」就是画布 chips 上标的序号，
  // 而 chips 序号 = 本数组下标顺序。不写清楚，模型会按画面内容自行配对，张冠李戴。
  const numbering = imageUrls.map((_, index) => `参考图 ${index + 1} = 第 ${index + 1} 张图`).join('，');
  const usage = params.usage || 'style';
  const isOutpaintRequest = /(扩图|扩展画布|延展画布|补全画面|补足画面|扩展到|改为\s*\d{1,2}\s*[:：]\s*\d{1,2})/i.test(params.prompt);
  const usageRule = usage === 'edit'
    ? isOutpaintRequest
      ? `\n\n本次用法：扩图 / 画布延展。不是重绘，也不是风格参考。必须保留参考图中已有的主体、位置、比例、视角、光线、色彩和细节，原图区域只作为不可改动的已存在画面；只描述需要新增的画布区域及其与原图边缘的自然衔接。若用户指定主体位于左侧、右侧留白等空间关系，必须原样保留，不得把原图主体改成新的主体。`
      : `\n\n本次用法：图生图——保留参考图的主体与构图，只把用户要求的改动应用上去，其余保持原样。`
    : `\n\n本次用法：风格参考。请按这个思路写提示词：参考图只贡献色系、光线氛围、质感与情绪，最终提示词必须正面描述一个与参考图主体不同的全新场景——新的主体、新的视角或新的构图完整写出来（比如把灯塔换成一道从云海中崛起的山脊），不要只换角度保留原主体，也不要罗列"不要出现什么"，用"画面里有什么"来写。若用户要求这张图"做背景 / 放在某页 / 结尾用"，在提示词里写明为文字预留的干净区域的位置与大致占比（如 upper third in deep blue for a title, lower two thirds calm）。若同时给了页面参考图：把它当版式锚点，描述它的留白结构让新图适配，而不要复刻页面里的内容。`;
  const referenceGuide = imageUrls.length > 1
      ? `\n\n（本次附带 ${imageUrls.length} 张参考图，按消息中的提供顺序编号：${numbering}。用户提到的「图一 / 图二 / 图1 / 图2」等说法一律按此编号对应，不要按画面内容自行调换顺序。${usageRule}\n请在 JSON 的 referenceRoles 中标注每张图的作用；不要把参考图分析或说明文字写进 prompt。）`
      : imageUrls.length === 1
      ? `\n\n（另附 1 张参考图。${usageRule}\n请在 JSON 的 referenceRoles 中标注它的作用；不要把参考图分析或说明文字写进 prompt。）`
      : '';
  // 参考图融合说明拼在用户段里：chat 只认 text 分段、responses 只认 input_text 分段
  const withReferences = imageUrls.length > 0
    ? `${userText}${referenceGuide}`
    : userText;
  const spec = [
    buildSystemSpec(String(params.size || ''), level),
    preferenceBlock(params.preferences || []),
  ].filter(Boolean).join('\n\n');
  const text = await callTextModel(profile, {
    systemSpec: spec,
    userText: withReferences,
    imageUrls,
    maxTokens: 1400,
    signal: params.signal,
  });
  // 跑偏兜底：抛错让调用方按原文继续发，别把道歉发给生图模型
  const result = parseEnhancementResult(text, usage);
  assertUsablePrompt(result.prompt);
  return result;
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
    `如有连接图片，按「${referenceLabel}」理解用户希望的用途。不要声称看到了图片内容；只依据用户文本描述整理动作与镜头。`,
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
