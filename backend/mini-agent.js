import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const localStyleIndexPath = path.join(rootDir, "skills", "gpt-image-2-studio", "vendor", "awesome-gpt-image-2", "data", "local-style-index.json");

export function createDefaultAgentMemory() {
  return {
    version: 1,
    profile: {
      preferredStyles: ["高端", "个性", "光影强", "主体突出", "干净构图"],
      preferredRatios: ["1:1"]
    },
    lessons: [],
    updatedAt: Date.now()
  };
}

export function runAgentSkills({ sourcePrompt, basePrompt, previousPrompt, attachments, memory }) {
  const safeMemory = memory || createDefaultAgentMemory();
  const matchedStyle = matchLocalStylePreset(sourcePrompt);
  const textPolicy = buildTextPolicy(sourcePrompt);
  const skills = [
    skillExtractIntent(sourcePrompt),
    skillApplyLocalStylePreset(matchedStyle),
    skillApplyTextPolicy(textPolicy),
    skillApplyVisualMemory(safeMemory),
    skillRespectReferenceImages(attachments),
    skillComposePrompt({ basePrompt, previousPrompt, matchedStyle, textPolicy })
  ];
  const prompt = skills.map((skill) => skill.output).filter(Boolean).join("，");
  return { prompt: cleanPrompt(prompt || basePrompt), skills, memory: safeMemory.profile };
}

function buildTextPolicy(sourcePrompt) {
  const text = String(sourcePrompt || "");
  const wantsPoster = /海报|封面|poster|banner|标题图|宣传图|主视觉/i.test(text);
  const explicitNoText = /不要文字|无文字|不加文字|no text|without text/i.test(text);
  const explicitText = /文字|标题|文案|标语|slogan|logo|品牌名|写上|加上|包含|字体|排版/i.test(text);
  if (explicitNoText) {
    return { mode: "no-text", output: "用户明确要求无文字：画面中不要出现文字、标题、标语或 Logo" };
  }
  if (explicitText || wantsPoster) {
    return {
      mode: "controlled-text",
      output: "海报/封面场景允许出现用户明确要求的标题、标语、品牌名和排版文字；文字必须清晰、少量、准确，不要生成乱码、错别字、无意义小字或额外文字"
    };
  }
  return { mode: "avoid-random-text", output: "非文字设计场景：不要随机生成无意义文字；如果用户没有指定文字，画面以主体和氛围为主" };
}

function matchLocalStylePreset(sourcePrompt) {
  const index = readLocalStyleIndex();
  const text = String(sourcePrompt || "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const preset of index.presets || []) {
    const score = (preset.keywords || []).reduce((total, keyword) => total + (text.includes(String(keyword).toLowerCase()) ? 1 : 0), 0);
    if (score > bestScore) {
      best = preset;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function readLocalStyleIndex() {
  try {
    if (!existsSync(localStyleIndexPath)) return { presets: [] };
    return JSON.parse(readFileSync(localStyleIndexPath, "utf8"));
  } catch {
    return { presets: [] };
  }
}

export function summarizeGeneration({ sourcePrompt, finalPrompt, size, ratio, attachments, outputs, providerResult, providerName, providerModel }) {
  const features = extractFeatureTags(`${sourcePrompt} ${finalPrompt}`);
  return {
    title: sourcePrompt.slice(0, 48) || "未命名生图",
    features,
    parameters: {
      size,
      ratio,
      model: providerResult.model || providerModel,
      provider: providerName,
      referenceCount: attachments.length,
      outputCount: outputs.length
    },
    learning: `本次偏好体现为：${features.join("、") || "主体明确、画质优先"}；后续优化会优先保留这些倾向。`
  };
}

export function updateMemory(memory, { sourcePrompt, finalPrompt, ratio, summary }) {
  const nextMemory = memory || createDefaultAgentMemory();
  nextMemory.profile.preferredStyles = mergeUnique(nextMemory.profile.preferredStyles, extractFeatureTags(`${sourcePrompt} ${finalPrompt}`)).slice(0, 18);
  nextMemory.profile.preferredRatios = mergeUnique([ratio], nextMemory.profile.preferredRatios).slice(0, 8);
  nextMemory.lessons.unshift({ at: Date.now(), sourcePrompt, finalPrompt, ratio, summary });
  nextMemory.lessons = nextMemory.lessons.slice(0, 100);
  nextMemory.updatedAt = Date.now();
  return nextMemory;
}

function skillExtractIntent(sourcePrompt) {
  const tags = [];
  if (/海报|poster|封面/i.test(sourcePrompt)) tags.push("海报构图");
  if (/产品|商品|物体/i.test(sourcePrompt)) tags.push("产品主视觉");
  if (/人像|人物|角色/i.test(sourcePrompt)) tags.push("人物主体");
  if (/黑金|高级|奢华|高端/i.test(sourcePrompt)) tags.push("高端黑金质感");
  if (/霓虹|未来|科技|AI/i.test(sourcePrompt)) tags.push("未来科技氛围");
  return { name: "intent.extract", input: sourcePrompt, output: tags.length ? `核心意图：${sourcePrompt}；识别标签：${tags.join("、")}` : `核心意图：${sourcePrompt}` };
}

function skillApplyVisualMemory(memory) {
  const styles = memory.profile.preferredStyles.slice(0, 5).join("、") || "高级、清晰、主体突出";
  const ratios = memory.profile.preferredRatios.slice(0, 3).join("、") || "1:1";
  return { name: "memory.apply", input: memory.profile, output: `延续用户偏好：${styles}；常用比例：${ratios}` };
}

function skillApplyLocalStylePreset(preset) {
  if (!preset) return { name: "style-library.match", input: null, output: "未命中本地风格索引，使用通用高质量图像规则" };
  const blocks = preset.promptBlocks || {};
  return {
    name: "style-library.match",
    input: preset.id,
    output: `命中风格：${preset.name}；${blocks.style || ""}；${blocks.composition || ""}；${blocks.lighting || ""}；${blocks.materials || ""}；${blocks.negative || ""}`
  };
}

function skillApplyTextPolicy(textPolicy) {
  return { name: "text.policy", input: textPolicy.mode, output: textPolicy.output };
}

function skillRespectReferenceImages(attachments) {
  if (!attachments?.length) return { name: "reference.guard", input: [], output: "无参考图时保持主体明确、画面干净、不要凭空添加品牌和文字" };
  return { name: "reference.guard", input: attachments.map((item) => item.id), output: `参考 ${attachments.length} 张图片，保持主体连续性、构图关系和关键视觉特征` };
}

function skillComposePrompt({ basePrompt, previousPrompt, matchedStyle, textPolicy }) {
  const continuity = previousPrompt ? `保留上一轮主体连续性：${previousPrompt}` : "";
  const presetNegative = matchedStyle?.promptBlocks?.negative ? `，${matchedStyle.promptBlocks.negative}` : "";
  const randomTextGuard = textPolicy?.mode === "controlled-text"
    ? "，保留并强化用户指定文字的海报排版，避免乱码、错别字、无意义小字和额外文字"
    : "，避免随机文字、乱码、错别字、水印";
  return { name: "prompt.compose", input: basePrompt, output: `${basePrompt}${continuity ? `，${continuity}` : ""}，电影级光影，主体清晰，高质感材质，精致构图，避免低清晰度、畸形结构${randomTextGuard}${presetNegative}` };
}

function extractFeatureTags(text) {
  const rules = [
    ["高端", /高端|高级|奢华|质感|premium/i],
    ["黑金", /黑金|金色|gold/i],
    ["霓虹", /霓虹|neon/i],
    ["科技", /科技|AI|未来|芯片|数字/i],
    ["电影光影", /电影|光影|布光|cinematic/i],
    ["产品主视觉", /产品|商品|立方体|物体/i],
    ["人物主体", /人物|人像|角色/i],
    ["海报构图", /海报|封面|poster|banner/i],
    ["极简", /极简|简洁|minimal/i]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function cleanPrompt(value) {
  return String(value || "").replace(/^['"“”]+|['"“”]+$/g, "").trim().slice(0, 32000);
}

function mergeUnique(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}
