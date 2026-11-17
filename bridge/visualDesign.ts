import { assertPromptAspect, assertPromptFacts, normalizeAspectRatio } from './imagePlanning.js';

export const VISUAL_DESIGN_VERSION = 'design-brief-v1';

export function visualDesignEnabled(): boolean {
  return process.env.HUIBAN_VISUAL_DESIGN === '1';
}

export interface VisualDesign {
  task: 'information' | 'identity' | 'illustration' | 'product' | 'background' | 'edit' | 'other';
  mode: 'create' | 'reference' | 'edit';
  goal: string;
  aspectRatio: string;
  requirements: Array<{ source: string; instruction: string }>;
  exactText: string[];
  copy: Array<{ source: string; text: string }>;
  openDecisions: string[];
  visual: {
    idea: string;
    focus: string;
    composition: string;
    appearance: string;
    typography: string;
    changes: string;
    preserve: string;
  };
  references: Array<{ index: number; use: string }>;
}

const textSchema = { type: 'string' };
const textArraySchema = { type: 'array', items: textSchema };

export const visualDesignSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task: { type: 'string', enum: ['information', 'identity', 'illustration', 'product', 'background', 'edit', 'other'] },
    mode: { type: 'string', enum: ['create', 'reference', 'edit'] },
    goal: textSchema,
    aspectRatio: textSchema,
    requirements: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { source: textSchema, instruction: textSchema }, required: ['source', 'instruction'],
    } },
    exactText: textArraySchema,
    copy: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { source: textSchema, text: textSchema }, required: ['source', 'text'],
    } },
    openDecisions: textArraySchema,
    visual: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(['idea', 'focus', 'composition', 'appearance', 'typography', 'changes', 'preserve'].map(key => [key, textSchema])),
      required: ['idea', 'focus', 'composition', 'appearance', 'typography', 'changes', 'preserve'],
    },
    references: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { index: { type: 'integer' }, use: textSchema }, required: ['index', 'use'],
    } },
  },
  required: ['task', 'mode', 'goal', 'aspectRatio', 'requirements', 'exactText', 'copy', 'openDecisions', 'visual', 'references'],
};

export function visualDesignRules(freedom: string, aspect: string, tool = false): string {
  return [
    '你是作品的设计者。交付一份已经作出决定、可以直接执行的设计稿描述，不是需求分析、风格词清单或通用排版教程。',
    '先理解作品要替用户完成什么：哪些是不可变的事实与设计，哪些口语可以整理，哪些尚未决定且需要你创作。用户没有想法时，你负责给出想法；不要把未决定等同于不允许创作。',
    '在 design 中记录需求与设计结论，再由程序组装最终提示词。这里只记录可核对的结论和原文出处，不输出思考过程、备选方案或质量评分。',
    '',
    '需求字段：',
    '- task 选择当前任务；mode=create 为独立新创作，reference 为使用给定图的部分特征来创作，edit 为修改现有作品。新任务不能继承无关旧图。',
    '- goal 简述用途与预期观感，不加入未经提供的业务事实。aspectRatio 只填数字比例，例如 "2:3"，不要附加方向或像素说明。',
    '- requirements 只记录必须遵守的非文案要求，每项 source 逐字摘自用户原文，instruction 准确表达约束；没有出处的设计选择不能假装成硬要求。',
    '- exactText 仅放用户已经给定且必须逐字出现在画面的标题、品牌、名称、地址、声明或明确指定逐字保留的文案；元素必须是原文中的连续片段。不要把用户给你的口语说明或所有活动介绍都当作逐字文案。日期、金额等可规范格式的信息通常只放在 copy 中，不要两处重复。',
    '- copy 把其余需要上图的信息整理成简洁正式文案，每项 source 为对应原文的连续片段，text 为最终画面文字；金额、日期、数量、条件和对应关系不改变。允许在信息设计需要时拟定有依据的短标题，此时 source 留空；不能虚构名称、卖点、承诺或事实。不要重复 exactText 中已提供的内容。仅需无字图时 exactText 和 copy 均为空。',
    '- openDecisions 简短列出需要你决定的事项，具体答案必须已经落实到 visual；不是向用户提问。',
    '',
    '设计字段 visual：',
    '- idea 描述一个能画出来的完整视觉想法。让对象、动作、形状或空间关系共同表达主题；读完能想象作品，不只是物件与配色枚举。用户已有成熟方案时落实该方案，局部编辑时不另起创意。',
    '- focus 确定首先看到什么、其次看到什么。composition 描述主体形态、视角、前后与疏密关系，信息与图形如何构成整体；不要仅按条目数切成同样的盒子。',
    '- appearance 选择与构思一致的媒介、造型、色彩与质感；需要的光照也在此统一。不要默认某行业固定配色。决定关键关系，留给生图模型合理的局部表现空间。',
    '- typography 在有字作品中安排实际文案、层级、分组、字号关系、可读性及容纳长短文案的空间；需要引用文案时使用 exactText/copy 中的原文，不能在此另造一版。不把所有信息放成等权横栏，不为了装饰挤压必要文字。无字任务留空。',
    '- changes/preserve 仅记录本次编辑的改动与保留项；用户指定的改动优先于历史保留要求。新任务无此需求时留空。',
    '- 品牌标识关注轮廓、负空间、识别性和小尺寸表现；不机械套入海报场景。背景处理画面节奏和可放内容的干净区域；产品与摄影处理形体、镜头与材质。任务需要什么才决定什么。',
    '- 所有字段一起表达一套已经决定的方案，不留“左侧或右侧”“可以选择”等未定分支。不要靠“高级、精美、高清”代替具体设计，也不要新增无来源的禁止清单。缺少用户实际二维码素材时，仅预留待放区域，不生成仿真二维码。',
    '',
    '参考图：references 中 index 严格对应传入编号，use 写清只借鉴什么、保留什么和允许改变什么。仅风格参考不复制无关主体；原图编辑保护未要求改变的内容。没有实际参考图时 references 为空，不虚构参考。',
    freedom,
    aspect,
    tool
      ? '需要生图时把下述结构放进 generate_image.design；每个字段都需要提供，不适用的字符串留空、数组留空。直接调用工具，不先展示设计草稿。'
      : '输出一个 JSON 对象，形状为 {"design": <下述结构>}；每个字段都需要提供，不适用的字符串留空、数组留空。',
    JSON.stringify(visualDesignSchema),
  ].join('\n');
}

export function parseVisualJson(raw: string): Record<string, unknown> {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const parsed: unknown = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设计结果不是有效对象');
  return parsed as Record<string, unknown>;
}

export function parseVisualDesign(value: unknown): VisualDesign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('缺少结构化设计结果');
  const record = value as Record<string, unknown>;
  const requiredString = (input: unknown, label: string, allowEmpty = false): string => {
    if (typeof input !== 'string' || (!allowEmpty && !input.trim())) throw new Error(`设计字段 ${label} 缺失`);
    return input.trim();
  };
  const array = (input: unknown, label: string): unknown[] => {
    if (!Array.isArray(input) || input.length > 100) throw new Error(`设计字段 ${label} 不是有效列表`);
    return input;
  };
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设计条目格式错误');
    return input as Record<string, unknown>;
  };
  if (!visualDesignSchema.properties.task.enum.includes(String(record.task))) throw new Error('设计任务类型无效');
  if (!visualDesignSchema.properties.mode.enum.includes(String(record.mode))) throw new Error('设计上下文用法无效');
  const aspectRatio = normalizeAspectRatio(record.aspectRatio);
  if (!aspectRatio) throw new Error('设计缺少有效画幅');
  const visual = object(record.visual);
  return {
    task: record.task as VisualDesign['task'], mode: record.mode as VisualDesign['mode'],
    goal: requiredString(record.goal, 'goal'), aspectRatio,
    requirements: array(record.requirements, 'requirements').map(item => {
      const entry = object(item);
      return { source: requiredString(entry.source, 'source'), instruction: requiredString(entry.instruction, 'instruction') };
    }),
    exactText: array(record.exactText, 'exactText').map(item => requiredString(item, 'exactText')),
    copy: array(record.copy, 'copy').map(item => {
      const entry = object(item);
      return { source: requiredString(entry.source, 'copy.source', true), text: requiredString(entry.text, 'copy.text') };
    }),
    openDecisions: array(record.openDecisions, 'openDecisions').map(item => requiredString(item, 'openDecisions')),
    visual: Object.fromEntries(Object.keys(visualDesignSchema.properties.visual.properties).map(key => [key, requiredString(visual[key], `visual.${key}`, !['idea', 'composition'].includes(key))])) as unknown as VisualDesign['visual'],
    references: array(record.references, 'references').map(item => {
      const entry = object(item);
      if (!Number.isInteger(entry.index) || Number(entry.index) < 1) throw new Error('参考图编号无效');
      return { index: Number(entry.index), use: requiredString(entry.use, 'references.use') };
    }),
  };
}

export function compileVisualDesign(design: VisualDesign): string {
  return [
    `创作目标：${design.goal}\n画幅：${design.aspectRatio}。`,
    design.mode === 'edit' ? '在提供的基准图上完成本次修改，未要求改变的内容沿用原图。' : '',
    `画面方案：\n${design.visual.idea}`,
    design.visual.focus && `视觉重点：\n${design.visual.focus}`,
    `构图与空间：\n${design.visual.composition}`,
    design.visual.appearance && `表现方式：\n${design.visual.appearance}`,
    design.visual.typography && `图文编排：\n${design.visual.typography}`,
    design.exactText.length ? `以下画面文字逐字保留：\n${design.exactText.map(text => JSON.stringify(text)).join('\n')}` : '',
    design.copy.length ? `其他画面文案（按上述层级编排）：\n${design.copy.map(item => JSON.stringify(item.text)).join('\n')}` : '',
    design.references.length ? `参考图用途：\n${design.references.map(item => `图${item.index}：${item.use}`).join('\n')}` : '',
    design.visual.changes && `本次修改：${design.visual.changes}`,
    design.visual.preserve && `保持不变：${design.visual.preserve}`,
    design.requirements.length ? `用户原文中的硬要求：\n${[...new Set(design.requirements.map(item => item.source))].join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export interface VisualDesignContext {
  prompt: string;
  sourceText?: string;
  lockedAspect?: string;
  referenceCount: number;
  usage?: 'style' | 'edit';
}

export function visualDesignIssues(design: VisualDesign, context: VisualDesignContext): string[] {
  const issues: string[] = [];
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
  const source = normalize(context.sourceText || context.prompt);
  for (const excerpt of [...design.requirements.map(item => item.source), ...design.copy.map(item => item.source).filter(Boolean), ...design.exactText]) {
    if (!source.includes(normalize(excerpt))) issues.push(`原文中找不到该出处，不能据此新增事实或硬约束：${excerpt}`);
  }
  for (const item of design.copy) {
    if (!item.source) continue;
    try { assertPromptFacts(item.source, item.text); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
    const scopes: Array<[RegExp, RegExp, string]> = [
      [/单张/, /单张|每张|每一张/, '单张条件'],
      [/整本/, /整本|全本|一整本/, '整本条件'],
      [/每人/, /每人|每位|每个[用户人]|每一[人位]/, '每人条件'],
      [/每日|每天/, /每日|每天|每个自然日/, '每日条件'],
      [/有机会|概率|可能获得/, /有机会|概率|可能|抽取|抽奖/, '概率条件'],
      [/最多|不超过|至多|上限/, /最多|不超过|至多|上限|限[带购领取量]/, '数量上限'],
      [/至少|不少于/, /至少|不少于|起[购订]/, '数量下限'],
    ];
    for (const [condition, equivalent, label] of scopes) {
      if (condition.test(item.source) && !equivalent.test(item.text)) issues.push(`文案遗漏${label}：${item.source}`);
    }
    for (const fact of item.source.matchAll(/(\d+(?:\.\d+)?)(本|人|件|张|次|个)/g)) {
      if (!normalize(item.text).includes(fact[0])) issues.push(`文案遗漏数量：${fact[0]}`);
    }
  }
  const actualCopy = normalize(design.copy.map(item => item.text).join('\n'));
  for (const exact of design.exactText) {
    if (actualCopy.includes(normalize(exact))) issues.push(`逐字文案与整理文案重复：${exact}；同一信息只保留一份，在排版中引用`);
  }
  if (context.lockedAspect && normalizeAspectRatio(context.lockedAspect) !== design.aspectRatio) issues.push(`画幅必须是 ${context.lockedAspect}，当前设计为 ${design.aspectRatio}`);
  if (context.usage === 'edit' && design.mode !== 'edit') issues.push('本次是明确的原图编辑，不能改为全新创作');
  const indices = design.references.map(item => item.index);
  if (new Set(indices).size !== indices.length) issues.push('参考图编号重复');
  if (indices.some(index => index > context.referenceCount)) issues.push('设计引用了未提供的图片');
  if (context.referenceCount > 0 && (indices.length !== context.referenceCount || design.mode === 'create')) issues.push('需逐张明确实际参考图用途，并使用 reference 或 edit 模式');
  if (!context.referenceCount && design.mode !== 'create') issues.push('没有提供参考图，不能声称参考或修改原图');
  const prompt = compileVisualDesign(design);
  for (const check of [
    () => assertPromptAspect(design.visual.composition, design.aspectRatio),
    () => assertPromptAspect(prompt, design.aspectRatio),
    () => assertPromptFacts(context.prompt, prompt),
  ]) {
    try { check(); } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  return [...new Set(issues)];
}

export function needsVisualReview(design: VisualDesign, context: VisualDesignContext): boolean {
  return context.referenceCount > 1 || context.prompt.length > 280 || design.copy.length + design.exactText.length > 5
    || /或|或者|可以(?:放|用|选择)|可选/.test(Object.values(design.visual).join('\n'));
}

export const VISUAL_REVIEW_RULES = [
  '你负责设计交付前的核对，不负责重新发明创意，不对审美打分。输入包含用户原文、需求与设计结论、实际参考图和程序发现的问题。',
  '按原文检查：遗漏或改变的事实与条件关系；把口语误当逐字文案；擅自补入的业务事实或禁止项；精确文字；画幅；参考图编号和用途；编辑边界。检查设计是否留下互斥备选、明显矛盾，或只有物件颜色和容器而没有具体的视觉关系，长文案是否有空间容纳。',
  '不因个人偏好更换已有概念，不把复杂作品一律简化，不向原文添加新限制。设计者自主选择无人场景、暖色或少量细节等是允许的，不是用户没有写就算错误；只拦截与需求冲突、伪装成用户硬要求、或无助于既定方案的额外禁令。只对有原文或设计内容可举证的问题做最小修正；若缺少必要设计决定，把它明确下来。',
  '返回 JSON {"issues":["具体问题与依据"],"design":null}；无问题时 issues=[]、design=null。若有问题且可以修正，design 返回完整的修正后结构，issues 记录修正前的问题；无法忠实修正则 design=null 并说明。不要返回评分、保证或思考过程。',
].join('\n');
