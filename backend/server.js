import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createDefaultAgentMemory, runAgentSkills, summarizeGeneration, updateMemory } from "./mini-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const imageIndexPath = path.join(dataDir, "images.json");
const skillsDir = path.join(dataDir, "skills");
const promptLogsDir = path.join(dataDir, "prompt-logs");
const errorLogsDir = path.join(dataDir, "error-logs");
const errorLogJsonPath = path.join(errorLogsDir, "errors.json");
const feedbackLogPath = path.join(dataDir, "feedback.json");
const agentMemoryPath = path.join(skillsDir, "agent-memory.json");
const generationHistoryPath = path.join(dataDir, "generation-history.json");
const frontendDir = path.join(rootDir, "frontend");

loadEnv(path.join(rootDir, ".env"));

const config = readRuntimeConfig();

function readRuntimeConfig() {
  return {
  host: process.env.SERVER_HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787),
  publicBaseUrl: trimSlash(process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8787"),
  providerBase: trimSlash(process.env.IMAGE_PROVIDER_BASE || "https://api.openai.com/v1"),
  providerKey: process.env.IMAGE_PROVIDER_API_KEY || "",
  providerModel: process.env.IMAGE_PROVIDER_MODEL || "gpt-image-2",
  providerName: process.env.IMAGE_PROVIDER_NAME || "openai-compatible",
  defaultSize: process.env.IMAGE_DEFAULT_SIZE || "1024x1024",
  defaultQuality: process.env.IMAGE_DEFAULT_QUALITY || "high",
  imageRequestTimeoutMs: readTimeout(process.env.IMAGE_REQUEST_TIMEOUT_MS, 180000),
  languageRequestTimeoutMs: readTimeout(process.env.LANGUAGE_REQUEST_TIMEOUT_MS, 18000),
  languageModelBase: trimSlash(process.env.LANGUAGE_MODEL_BASE || ""),
  languageModelKey: process.env.LANGUAGE_MODEL_API_KEY || "",
  languageModelName: process.env.LANGUAGE_MODEL_NAME || "gpt-4.1-mini",
  agentEndpoint: process.env.AGENT_ENDPOINT || "",
  agentKey: process.env.AGENT_API_KEY || ""
  };
}

ensureDir(dataDir);
ensureDir(path.join(dataDir, "images"));
ensureDir(skillsDir);
ensureDir(promptLogsDir);
ensureDir(errorLogsDir);
if (!existsSync(imageIndexPath)) writeJson(imageIndexPath, []);
if (!existsSync(generationHistoryPath)) writeJson(generationHistoryPath, []);
if (!existsSync(agentMemoryPath)) writeJson(agentMemoryPath, createDefaultAgentMemory());
if (!existsSync(errorLogJsonPath)) writeJson(errorLogJsonPath, []);
if (!existsSync(feedbackLogPath)) writeJson(feedbackLogPath, []);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, getPublicConfig());
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJsonBody(req, 300_000);
      updateEnvConfig(body);
      Object.assign(config, readRuntimeConfig());
      return sendJson(res, { ok: true, config: getPublicConfig() });
    }

    if (req.method === "GET" && url.pathname === "/api/logs/errors") {
      return sendJson(res, { items: readJsonFile(errorLogJsonPath, []).slice(-50).reverse() });
    }

    if (req.method === "GET" && url.pathname === "/api/images/history") {
      const items = readIndex().filter((item) => item.kind === "output").sort((a, b) => b.createdAt - a.createdAt);
      return sendJson(res, { items });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/images/file/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      return serveIndexedImage(res, id);
    }

    if (req.method === "POST" && url.pathname === "/api/images/upload") {
      const body = await readJsonBody(req);
      const record = saveDataUrlImage({
        dataUrl: body.dataUrl,
        fileName: body.fileName || "upload.png",
        source: body.source || "upload",
        sourcePrompt: body.sourcePrompt || ""
      });
      return sendJson(res, record);
    }

    if (req.method === "POST" && url.pathname === "/api/images/optimize-prompt") {
      const body = await readJsonBody(req);
      const result = await optimizePrompt(body);
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/images/feedback") {
      const body = await readJsonBody(req, 300_000);
      appendImageFeedback(body);
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/images/generate") {
      const body = await readJsonBody(req, 2_000_000);
      const result = await generateImage(body);
      return sendJson(res, result);
    }

    if (req.method === "GET") return serveStatic(res, url.pathname);

    sendJson(res, { error: "Not found" }, 404);
  } catch (error) {
    const errorId = appendErrorLog(error, { method: req.method, url: req.url });
    console.error(safeError(error));
    sendJson(res, { error: error.message || "Server error", errorId }, 500);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Image Studio running at http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`);
});

async function generateImage(body) {
  if (!config.providerKey) throw new Error("IMAGE_PROVIDER_API_KEY is not configured");
  const timings = { startedAt: Date.now() };

  const sourcePrompt = String(body.sourcePrompt || body.prompt || "").trim();
  const finalPrompt = String(body.prompt || sourcePrompt).trim();
  if (!finalPrompt) throw new Error("Prompt is required");

  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
  const attachments = attachmentIds.map(getImageById).filter(Boolean);
  const size = getSizeFromPrompt(finalPrompt) || body.size || config.defaultSize;
  const ratio = body.ratio || getRatioFromSize(size);
  const jobStartedAt = Date.now();

  timings.providerStartAt = Date.now();
  const providerResult = attachments.length
    ? await callImageEdit(finalPrompt, attachments, size)
    : await callImageGeneration(finalPrompt, size);
  timings.providerMs = Date.now() - timings.providerStartAt;

  const outputs = [];
  for (const image of providerResult.images.slice(0, 1)) {
    const saved = await saveOutputImage({
      image,
      sourcePrompt,
      prompt: finalPrompt,
      optimizedByAgent: Boolean(body.optimizedByAgent),
      inputs: attachments,
      model: providerResult.model || config.providerModel,
      provider: config.providerName,
      size,
      ratio
    });
    outputs.push(saved);
  }

  const summary = summarizeGeneration({ sourcePrompt, finalPrompt, size, ratio, attachments, outputs, providerResult, providerName: config.providerName, providerModel: config.providerModel });
  timings.totalMs = Date.now() - timings.startedAt;
  appendGenerationHistory({
    id: `job_${dateCompact()}_${shortId()}`,
    sourcePrompt,
    prompt: finalPrompt,
    optimizedByAgent: Boolean(body.optimizedByAgent),
    size,
    ratio,
    model: providerResult.model || config.providerModel,
    provider: config.providerName,
    attachmentIds,
    inputs: attachments.map(publicRecord),
    outputs,
    summary,
    timings,
    startedAt: jobStartedAt,
    completedAt: Date.now()
  });
  appendPromptTimeline({
    sourcePrompt,
    prompt: finalPrompt,
    optimizedByAgent: Boolean(body.optimizedByAgent),
    size,
    ratio,
    model: providerResult.model || config.providerModel,
    provider: config.providerName,
    outputs,
    summary,
    createdAt: Date.now()
  });
  updateAgentMemory({ sourcePrompt, finalPrompt, size, ratio, attachments, outputs, summary });

  return {
    model: providerResult.model || config.providerModel,
    provider: config.providerName,
    prompt: finalPrompt,
    sourcePrompt,
    optimizedByAgent: Boolean(body.optimizedByAgent),
    size,
    ratio,
    summary,
    timings,
    inputs: attachments.map(publicRecord),
    outputs
  };
}

async function callImageGeneration(prompt, size) {
  const payload = {
    model: config.providerModel,
    prompt,
    size,
    n: 1,
    quality: config.defaultQuality,
    response_format: "b64_json"
  };

  const json = await postJsonWithRetry(`${config.providerBase}/images/generations`, payload);
  return { model: json.model, images: extractImages(json).slice(0, 1) };
}

async function callImageEdit(prompt, attachments, size) {
  const form = await createEditForm(prompt, attachments, size, true);

  let response = await fetchWithTimeout(`${config.providerBase}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.providerKey}` },
    body: form
  }, config.imageRequestTimeoutMs);

  let json = await response.json().catch(() => ({}));
  if (!response.ok && /response_format|quality/i.test(json?.error?.message || "")) {
    const retryForm = await createEditForm(prompt, attachments, size, false);
    response = await fetchWithTimeout(`${config.providerBase}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.providerKey}` },
      body: retryForm
    }, config.imageRequestTimeoutMs);
    json = await response.json().catch(() => ({}));
  }

  if (!response.ok) throw new Error(json?.error?.message || `Image edit failed: ${response.status}`);
  return { model: json.model, images: extractImages(json).slice(0, 1) };
}

async function createEditForm(prompt, attachments, size, includeOptionalFields) {
  const form = new FormData();
  form.set("model", config.providerModel);
  form.set("prompt", prompt);
  form.set("size", size);
  form.set("n", "1");
  if (includeOptionalFields) {
    form.set("quality", config.defaultQuality);
    form.set("response_format", "b64_json");
  }

  for (const item of attachments.slice(0, 16)) {
    const buffer = await readFile(item.path);
    const blob = new Blob([buffer], { type: item.mime || "image/png" });
    form.append("image", blob, item.originalName || item.filename || `${item.id}.png`);
  }
  return form;
}

async function postJsonWithRetry(url, payload) {
  let json = await postJson(url, payload);
  if (json.ok) return json.body;

  const message = json.body?.error?.message || "";
  if (/response_format|quality/i.test(message)) {
    const retryPayload = { ...payload };
    delete retryPayload.response_format;
    if (/quality/i.test(message)) delete retryPayload.quality;
    json = await postJson(url, retryPayload);
    if (json.ok) return json.body;
  }

  throw new Error(json.body?.error?.message || `Provider request failed: ${json.status}`);
}

async function postJson(url, payload) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.providerKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, config.imageRequestTimeoutMs);
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function extractImages(json) {
  const images = [];
  for (const item of json.data || []) {
    if (item.b64_json) images.push({ b64: item.b64_json, mime: mimeFromB64(item.b64_json) || "image/png" });
    if (item.url) images.push({ url: item.url, mime: "image/png" });
  }
  if (!images.length) throw new Error("Provider returned no images");
  return images;
}

async function optimizePrompt(body) {
  const sourcePrompt = String(body.userPrompt || body.prompt || "").trim();
  const basePrompt = String(body.prompt || sourcePrompt).trim();
  const skillContext = runAgentSkills({
    sourcePrompt,
    basePrompt,
    previousPrompt: body.previousPrompt || "",
    attachments: body.attachments || [],
    memory: readAgentMemory()
  });

  try {
    if (config.languageModelBase && config.languageModelKey) {
      const optimized = await optimizeWithLanguageModel({ sourcePrompt, basePrompt, body, skillContext });
      return { prompt: optimized || skillContext.prompt, sourcePrompt, usedAgent: Boolean(optimized), fallback: !optimized, skills: skillContext.skills, error: "" };
    }

    if (!config.agentEndpoint) {
      return { prompt: skillContext.prompt, sourcePrompt, usedAgent: true, fallback: false, skills: skillContext.skills, error: "" };
    }

    const response = await fetch(config.agentEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.agentKey ? { Authorization: `Bearer ${config.agentKey}` } : {})
      },
      body: JSON.stringify({
        task: "optimize_image_prompt",
        sourcePrompt,
        basePrompt,
        previousPrompt: body.previousPrompt || "",
        images: body.attachments || [],
        skills: skillContext.skills,
        memory: skillContext.memory,
        rules: ["不改变用户核心意图", "只输出最终提示词", "不调用工具", "不写文件"]
      })
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Agent failed: ${response.status}`);
    const maybeJson = tryJson(text);
    const optimized = cleanPrompt(maybeJson?.prompt || text);
    return { prompt: optimized || skillContext.prompt, sourcePrompt, usedAgent: Boolean(optimized), fallback: !optimized, skills: skillContext.skills, error: "" };
  } catch (error) {
    return { prompt: skillContext.prompt, sourcePrompt, usedAgent: true, fallback: true, skills: skillContext.skills, error: error.message || "Agent unavailable" };
  }
}

async function optimizeWithLanguageModel({ sourcePrompt, basePrompt, body, skillContext }) {
  const userContent = buildPromptOptimizationContent({ sourcePrompt, basePrompt, body, skillContext });
  const response = await fetchWithTimeout(`${config.languageModelBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.languageModelKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.languageModelName,
      temperature: 0.4,
      messages: [
        {
          role: "system",
          content: [
            "你是图像生成提示词优化助手。必须保留用户核心意图，不编造主体、品牌、文字和人物身份。可以补充构图、光线、风格、材质、镜头和质量要求。",
            "文字策略：海报、封面、宣传图、活动图允许用户明确指定的标题、标语、品牌名、活动信息和排版文字；不要因为用户说海报就默认加入‘无文字/不要文字’。",
            "只有用户明确说‘不要文字、无文字、不加字、no text、without text’时，才严格禁止文字。",
            "如果用户没有指定文字，只需避免随机乱码、错别字、无意义小字、水印和额外文字；如果用户指定了文字，必须保留原文且少量清晰准确。",
            "只输出最终提示词，不要 Markdown，不要解释。"
          ].join("\n")
        },
        {
          role: "user",
          content: userContent
        }
      ]
    })
  }, config.languageRequestTimeoutMs);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || `Language model failed: ${response.status}`);
  return cleanPrompt(json.choices?.[0]?.message?.content || "");
}

function buildPromptOptimizationContent({ sourcePrompt, basePrompt, body, skillContext }) {
  const text = [
    `用户原始需求：${sourcePrompt}`,
    `本轮合成提示词草稿：${basePrompt}`,
    `上一轮提示词：${body.previousPrompt || "无"}`,
    `本地 skills 建议：${skillContext.prompt}`,
    `参考图片数量：${(body.attachments || []).length}`,
    `用户记忆：${JSON.stringify(skillContext.memory)}`,
    "如果存在参考图，请先观察图片主体、构图、颜色、材质、文字和风格，再结合用户需求优化提示词。"
  ].join("\n\n");

  const images = (body.attachments || [])
    .slice(0, 3)
    .map((item) => getImageById(item.id) || item)
    .map(imageToDataUrl)
    .filter(Boolean);

  if (!images.length) return text;
  return [
    { type: "text", text },
    ...images.map((url) => ({ type: "image_url", image_url: { url } }))
  ];
}

function imageToDataUrl(item) {
  try {
    if (!item?.path) return "";
    const resolved = path.resolve(item.path);
    const safeRoot = path.resolve(path.join(dataDir, "images"));
    if (!resolved.startsWith(safeRoot)) return "";
    const buffer = readFileSync(resolved);
    return `data:${item.mime || "image/png"};base64,${buffer.toString("base64")}`;
  } catch {
    return "";
  }
}

function saveDataUrlImage({ dataUrl, fileName, source, sourcePrompt }) {
  const parsed = parseDataUrl(dataUrl);
  const id = `in_${dateCompact()}_${shortId()}`;
  const ext = extFromMime(parsed.mime) || path.extname(fileName) || ".png";
  const dir = monthDir("inputs");
  const filename = `${id}${ext}`;
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, parsed.buffer);

  const record = {
    id,
    kind: "input",
    filename,
    originalName: fileName,
    mime: parsed.mime,
    size: parsed.buffer.length,
    source,
    path: filePath,
    url: `/api/images/file/${id}`,
    publicUrl: `${config.publicBaseUrl}/api/images/file/${id}`,
    sourcePrompt,
    prompt: sourcePrompt,
    createdAt: Date.now()
  };
  appendIndex(record);
  return publicRecord(record);
}

async function saveOutputImage({ image, sourcePrompt, prompt, optimizedByAgent, inputs, model, provider, size, ratio }) {
  const id = `out_${dateCompact()}_${shortId()}`;
  const buffer = image.b64 ? Buffer.from(image.b64, "base64") : await downloadImage(image.url);
  if (!buffer) throw new Error("Provider returned an image that could not be saved");

  const mime = image.mime || "image/png";
  const ext = extFromMime(mime) || ".png";
  const filename = `${dateStamp()}_${slug(sourcePrompt || prompt)}_${shortId()}${ext}`;
  const filePath = path.join(monthDir("outputs"), filename);
  writeFileSync(filePath, buffer);

  const record = {
    id,
    kind: "output",
    filename,
    originalName: filename,
    mime,
    size: buffer.length,
    path: filePath,
    url: `/api/images/file/${id}`,
    publicUrl: `${config.publicBaseUrl}/api/images/file/${id}`,
    sourcePrompt,
    prompt,
    optimizedByAgent,
    model,
    provider,
    generationSize: size,
    ratio,
    inputs: inputs.map(({ id: inputId, path: inputPath, url, publicUrl, originalName }) => ({ id: inputId, path: inputPath, url, publicUrl, name: originalName })),
    createdAt: Date.now()
  };
  appendIndex(record);
  return publicRecord(record);
}

function serveIndexedImage(res, id) {
  const item = getImageById(id);
  if (!item) return sendJson(res, { error: "Image not found" }, 404);
  const resolved = path.resolve(item.path);
  const safeRoot = path.resolve(path.join(dataDir, "images"));
  if (!resolved.startsWith(safeRoot)) return sendJson(res, { error: "Forbidden" }, 403);
  res.writeHead(200, { "Content-Type": item.mime || "application/octet-stream", "Cache-Control": "private, max-age=31536000" });
  createReadStream(resolved).pipe(res);
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(frontendDir, `.${decodeURIComponent(cleanPath)}`);
  if (!resolved.startsWith(frontendDir)) return sendJson(res, { error: "Forbidden" }, 403);
  if (!existsSync(resolved)) return sendJson(res, { error: "Not found" }, 404);
  const fileStat = await stat(resolved);
  if (!fileStat.isFile()) return sendJson(res, { error: "Not found" }, 404);
  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream" });
  createReadStream(resolved).pipe(res);
}

function readIndex() {
  return JSON.parse(readFileSync(imageIndexPath, "utf8") || "[]");
}

function appendIndex(record) {
  const items = readIndex();
  items.push(record);
  writeJson(imageIndexPath, items);
}

function appendGenerationHistory(record) {
  const items = readJsonFile(generationHistoryPath, []);
  items.push(record);
  writeJson(generationHistoryPath, items);
}

function appendErrorLog(error, context = {}) {
  const record = {
    id: `err_${dateCompact()}_${shortId()}`,
    message: error.message || String(error),
    stack: error.stack || "",
    context,
    createdAt: Date.now()
  };
  const items = readJsonFile(errorLogJsonPath, []);
  items.push(record);
  writeJson(errorLogJsonPath, items.slice(-300));
  const now = new Date(record.createdAt);
  const filePath = path.join(errorLogsDir, `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`);
  appendFileSync(filePath, `## ${now.toLocaleString("zh-CN", { hour12: false })}\n\n- ID：${record.id}\n- 错误：${record.message}\n- 接口：${context.method || ""} ${context.url || ""}\n\n\`\`\`text\n${record.stack}\n\`\`\`\n\n`, "utf8");
  return record.id;
}

function appendImageFeedback(body) {
  const value = body?.feedback === "like" ? "like" : body?.feedback === "dislike" ? "dislike" : "unknown";
  const record = {
    id: `fb_${dateCompact()}_${shortId()}`,
    imageId: String(body?.imageId || ""),
    feedback: value,
    prompt: String(body?.prompt || ""),
    createdAt: Date.now()
  };
  const items = readJsonFile(feedbackLogPath, []);
  items.push(record);
  writeJson(feedbackLogPath, items.slice(-1000));
  const now = new Date(record.createdAt);
  const filePath = path.join(dataDir, `feedback-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`);
  appendFileSync(filePath, `## ${now.toLocaleString("zh-CN", { hour12: false })}\n\n- 图片ID：${record.imageId}\n- 反馈：${record.feedback}\n- 提示词：${record.prompt}\n\n` , "utf8");
}

function appendPromptTimeline(record) {
  const now = new Date(record.createdAt);
  const fileName = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
  const filePath = path.join(promptLogsDir, fileName);
  const outputLines = record.outputs.map((item) => `- 图片：${item.filename}\n  - 地址：${item.url}`).join("\n");
  const block = [
    `## ${now.toLocaleString("zh-CN", { hour12: false })}`,
    "",
    `- 原始提示词：${record.sourcePrompt}`,
    `- Agent 优化提示词：${record.prompt}`,
    `- 优化方式：${record.optimizedByAgent ? "Agent/语言模型" : "直连/本地"}`,
    `- 模型：${record.model}`,
    `- Provider：${record.provider}`,
    `- 比例/尺寸：${record.ratio} / ${record.size}`,
    `- 总结：${record.summary?.learning || ""}`,
    "- 输出：",
    outputLines || "- 无",
    ""
  ].join("\n");
  appendFileSync(filePath, `${block}\n`, "utf8");
}

function readAgentMemory() {
  return readJsonFile(agentMemoryPath, createDefaultAgentMemory());
}

function updateAgentMemory({ sourcePrompt, finalPrompt, ratio, summary }) {
  const memory = readAgentMemory();
  writeJson(agentMemoryPath, updateMemory(memory, { sourcePrompt, finalPrompt, ratio, summary }));
}

function readJsonFile(filePath, fallback) {
  try { return JSON.parse(readFileSync(filePath, "utf8") || JSON.stringify(fallback)); } catch { return fallback; }
}

function getImageById(id) {
  return readIndex().find((item) => item.id === id);
}

function publicRecord(record) {
  const { path: filePath, ...safe } = record;
  return { ...safe, path: filePath };
}

async function readJsonBody(req, limit = 25_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function getPublicConfig() {
  return {
    serverVersion: "2026-05-14-timeout-fix-1",
    providerConfigured: Boolean(config.providerKey),
    agentConfigured: Boolean(config.languageModelBase && config.languageModelKey) || Boolean(config.agentEndpoint),
    model: config.providerModel,
    languageModel: config.languageModelName,
    provider: config.providerName,
    providerBase: config.providerBase,
    providerName: config.providerName,
    languageModelBase: config.languageModelBase,
    imageRequestTimeoutMs: config.imageRequestTimeoutMs,
    languageRequestTimeoutMs: config.languageRequestTimeoutMs,
    defaultSize: config.defaultSize,
    agentMode: config.languageModelBase && config.languageModelKey ? "language-model" : (config.agentEndpoint ? "external-agent" : "built-in-skills")
  };
}

function updateEnvConfig(body) {
  const envPath = path.join(rootDir, ".env");
  const allowed = {
    IMAGE_PROVIDER_BASE: body.imageProviderBase,
    IMAGE_PROVIDER_API_KEY: body.imageProviderApiKey,
    IMAGE_PROVIDER_MODEL: body.imageProviderModel,
    IMAGE_PROVIDER_NAME: body.imageProviderName,
    LANGUAGE_MODEL_BASE: body.languageModelBase,
    LANGUAGE_MODEL_API_KEY: body.languageModelApiKey,
    LANGUAGE_MODEL_NAME: body.languageModelName
  };
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  let next = current;
  for (const [key, value] of Object.entries(allowed)) {
    if (typeof value !== "string") continue;
    const line = `${key}=${value.trim()}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    next = pattern.test(next) ? next.replace(pattern, line) : `${next.trimEnd()}\n${line}\n`;
    process.env[key] = value.trim();
  }
  writeFileSync(envPath, next, "utf8");
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const safeTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 180000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), safeTimeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`Request timed out after ${Math.round(safeTimeoutMs / 1000)}s: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readTimeout(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid dataUrl");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

function cleanPrompt(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ""))
    .replace(/^\s*(最终提示词|提示词|prompt)\s*[:：]\s*/i, "")
    .replace(/^['"“”]+|['"“”]+$/g, "")
    .trim()
    .slice(0, 32000);
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function monthDir(type) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dir = path.join(dataDir, "images", type, month);
  ensureDir(dir);
  return dir;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function loadEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function slug(text) {
  const cleaned = String(text || "image")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 42);
  return cleaned || "image";
}

function dateStamp() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function dateCompact() {
  const now = new Date();
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

function pad(value) { return String(value).padStart(2, "0"); }
function shortId() { return randomBytes(3).toString("hex"); }
function trimSlash(value) { return String(value || "").replace(/\/+$/, ""); }
function extFromMime(mime) { return { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[mime]; }
function mimeFromB64() { return "image/png"; }
function getRatioFromSize(size) { return ({ "1024x1024": "1:1", "1536x864": "16:9", "864x1536": "9:16", "1536x1024": "3:2", "1024x1536": "2:3" })[size] || "1:1"; }
function getSizeFromPrompt(prompt) {
  const text = String(prompt || "").replace(/[：]/g, ":").toLowerCase();
  const rules = [
    { pattern: /(?:16\s*[:：比]\s*9|横版|宽屏|横屏|banner|封面横图|横版海报)/i, size: "1536x864" },
    { pattern: /(?:9\s*[:：比]\s*16|竖版|竖屏|手机壁纸|短视频|竖版海报)/i, size: "864x1536" },
    { pattern: /(?:1\s*[:：比]\s*1|正方形|方图|头像)/i, size: "1024x1024" },
    { pattern: /(?:3\s*[:：比]\s*2|摄影横图)/i, size: "1536x1024" },
    { pattern: /(?:2\s*[:：比]\s*3|人像竖图)/i, size: "1024x1536" }
  ];
  return rules.find((rule) => rule.pattern.test(text))?.size || "";
}
function safeError(error) { return { message: error.message, stack: error.stack?.split("\n").slice(0, 3).join("\n") }; }

async function downloadImage(url) {
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download provider image: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
