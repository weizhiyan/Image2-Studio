export const PLANNED_IMAGE_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16'] as const;

export function normalizeAspectRatio(value: unknown): string | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*[:：xX×/]\s*(\d+(?:\.\d+)?)$/.exec(String(value || '').trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height || !Number.isFinite(width / height) || Math.max(width / height, height / width) > 3) return undefined;
  for (const preset of PLANNED_IMAGE_RATIOS) {
    const [presetWidth, presetHeight] = preset.split(':').map(Number);
    if (Math.abs(width / height - presetWidth / presetHeight) < 0.015) return preset;
  }
  return `${width}:${height}`;
}

export function promptAspectRatio(prompt: string): string | undefined {
  const text = String(prompt || '').replace(/[“「『"]([^”」』"\n]*)[”」』"]/g, '');
  const pixels = /(?:尺寸|分辨率|画幅|size|resolution)\s*[:：为是]?\s*(\d{3,5})\s*[xX×]\s*(\d{3,5})/i.exec(text);
  if (pixels) return normalizeAspectRatio(`${pixels[1]}:${pixels[2]}`);
  for (const match of text.matchAll(/\b(\d{1,2})\s*[:：]\s*(\d{1,2})\b/g)) {
    const candidate = normalizeAspectRatio(`${match[1]}:${match[2]}`);
    if (!candidate) continue;
    const prefix = text.slice(Math.max(0, match.index! - 24), match.index);
    if (/(?:时间|开业|营业|上午|下午|晚上|am|pm)\s*[:：]?\s*$/i.test(prefix)) continue;
    if ((PLANNED_IMAGE_RATIOS as readonly string[]).includes(candidate) || /(?:比例|画幅|aspect|ratio)\s*[:：为是]?\s*$/i.test(prefix)) return candidate;
  }
  if (/(?:正方形|方形(?:构图|画幅|海报|图片)|\bsquare\s+(?:image|canvas|format|poster))/i.test(text)) return '1:1';
  if (/(?:竖(?:版|构图|幅|图)|竖向(?:画幅|构图|海报|图片|封面)|\bportrait\s+(?:orientation|format|composition)|\bvertical\s+(?:image|canvas|format|poster))/i.test(text)) return '3:4';
  if (/(?:横(?:版|构图|幅|图)|横向(?:画幅|构图|海报|图片|封面)|宽幅|\blandscape\s+(?:orientation|format|composition)|\bhorizontal\s+(?:image|canvas|format|poster))/i.test(text)) return '4:3';
  return undefined;
}

export function fallbackImageAspect(prompt: string, referenceSize?: string, usage?: string, defaultSize?: string): string {
  const explicit = promptAspectRatio(prompt);
  if (explicit) return explicit;
  const reference = normalizeAspectRatio(referenceSize);
  if (usage === 'edit' && reference) return reference;
  if (/\b(?:ppt|powerpoint|slide|slides|presentation)\b|演示文稿|幻灯片|演示背景/i.test(prompt)) return '16:9';
  if (/\b(?:logo|icon|avatar)\b|标志设计|标识设计|图标|头像/i.test(prompt)) return '1:1';
  if (/\b(?:poster|flyer)\b|海报|宣传单/i.test(prompt)) return '2:3';
  if (/\b(?:banner|panorama)\b|横幅|全景/i.test(prompt)) return '16:9';
  return reference || normalizeAspectRatio(defaultSize) || '1:1';
}

export function imageAspectPlan(input: {
  prompt: string;
  size?: string;
  aspectRatio?: string;
  referenceSize?: string;
  usage?: string;
}): { aspectRatio: string; locked: boolean } {
  const explicit = promptAspectRatio(input.prompt);
  const fixed = normalizeAspectRatio(input.size);
  if (explicit) return { aspectRatio: explicit, locked: true };
  if (input.aspectRatio !== 'auto' && fixed) return { aspectRatio: fixed, locked: true };
  const preset = normalizeAspectRatio(input.aspectRatio);
  if (preset) return { aspectRatio: preset, locked: true };
  const reference = normalizeAspectRatio(input.referenceSize);
  if (input.usage === 'edit' && reference) return { aspectRatio: reference, locked: true };
  return { aspectRatio: fallbackImageAspect(input.prompt, input.referenceSize, input.usage), locked: false };
}

export function assertPromptAspect(prompt: string, aspectRatio: string): void {
  const described = promptAspectRatio(prompt);
  const expected = normalizeAspectRatio(aspectRatio);
  if (!described || !expected) return;
  const [describedWidth, describedHeight] = described.split(':').map(Number);
  const [expectedWidth, expectedHeight] = expected.split(':').map(Number);
  const hasNumericAspect = /\d\s*[:：xX×]\s*\d/.test(prompt.replace(/[“「『"]([^”」』"\n]*)[”」』"]/g, ''));
  const compatible = hasNumericAspect
    ? Math.abs(describedWidth / describedHeight - expectedWidth / expectedHeight) < 0.025
    : Math.sign(describedWidth - describedHeight) === Math.sign(expectedWidth - expectedHeight);
  if (!compatible) throw new Error(`提示词画幅 ${described} 与生成参数 ${expected} 不一致`);
}

export function assertPromptFacts(original: string, planned: string): void {
  const compact = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
  const source = compact(original)
    .replace(/(?:不要|不再|不用|去掉|删除|取消)(?:原来(?:的)?|原有(?:的)?|旧的)?\d+(?:\.\d+)?(?:元|份|注|号|日|月|年|%)/g, '')
    .replace(/\d+(?:\.\d+)?(?:元|份|注|号|日|月|年|%)(?=(?:改为|改成|改到|换成|调整为|调整到|变成|替换为))/g, '');
  const output = compact(planned);
  const facts = numericFacts(source);
  const outputFacts = new Set(numericFacts(output).map(fact => fact.normalized));
  const missing = [...new Set(facts.filter(fact => !outputFacts.has(fact.normalized)).map(fact => fact.original))];
  if (missing.length) throw new Error(`优化提示词遗漏或改动了原始数值：${missing.slice(0, 6).join('、')}`);
}

function numericFacts(text: string): Array<{ original: string; normalized: string }> {
  return [...text.matchAll(/(\d+(?:\.\d+)?)(元|份|注|号|日|月|年|%)/g)].map(match => {
    let normalized = match[0];
    if (match[2] === '号' && Number(match[1]) >= 1 && Number(match[1]) <= 31) {
      const prefix = text.slice(Math.max(0, match.index! - 48), match.index);
      const clause = prefix.split(/[，,。；;\n“”「」『』"]/).pop() || '';
      const dateCue = /(?:\d{1,2}月|(?:时间|日期|开业|活动|截止|截至)[^，,。；;]{0,30}|\d{1,2}[日号](?:到|至|—|–|-))$/.test(clause);
      const dateRange = /^\d{1,2}号(?:到|至|—|–|-)\d{1,2}[日号]/.test(text.slice(match.index));
      const identifier = /(?:地址|地点|路|街|巷|弄|门牌|房间|楼|室|编号|号码|车牌|车次)[^，,。；;]*$/.test(clause);
      if ((dateCue || dateRange) && !identifier) normalized = `${Number(match[1])}日`;
    }
    return { original: match[0], normalized };
  });
}

export function imagePlanningTokenBudget(prompt: string): number {
  const cjkCount = (prompt.match(/[\u3400-\u9fff]/g) || []).length;
  const inputTokens = cjkCount * 1.5 + (prompt.length - cjkCount) / 4;
  return Math.min(16000, Math.max(8192, Math.ceil(inputTokens * 1.4 + 6000)));
}
