const state = {
  attachments: [],
  results: [],
  previousOutput: null,
  previousPrompt: "",
  config: null,
  ratio: "自动",
  ratioMode: "auto",
  autoSize: "1024x1024",
  historyItems: [],
  historyVisible: 8,
  previewItem: null,
  busy: false
};

const $ = (selector) => document.querySelector(selector);
const form = $("#generateForm");
const promptInput = $("#promptInput");
const dropZone = $("#dropZone");
const fileInput = $("#fileInput");
const attachmentList = $("#attachmentList");
const referenceModeHint = $("#referenceModeHint");
const sizeSelect = $("#sizeSelect");
const ratioButton = $("#ratioButton");
const ratioLabel = $("#ratioLabel");
const ratioMenu = $("#ratioMenu");
const optimizePromptButton = $("#optimizePromptButton");
const generateButton = $("#generateButton");
const jobStatus = $("#jobStatus");
const loadingStage = $("#loadingStage");
const loadingTitle = $("#loadingTitle");
const loadingHint = $("#loadingHint");
const resultLoading = $("#resultLoading");
const resultLoadingTitle = $("#resultLoadingTitle");
const resultLoadingHint = $("#resultLoadingHint");
const resultsGrid = $("#resultsGrid");
const historyList = $("#historyList");
const loadMoreHistory = $("#loadMoreHistory");
const providerDot = $("#providerDot");
const providerText = $("#providerText");
const agentText = $("#agentText");
const configOpenButton = $("#configOpenButton");
const configModal = $("#configModal");
const configForm = $("#configForm");
const configStatus = $("#configStatus");
const previewModal = $("#previewModal");
const previewImage = $("#previewImage");
const previewMeta = $("#previewMeta");
const previewFeedback = $("#previewFeedback");
const loadingHints = [
  "正在把你的想法压缩成视觉关键词...",
  "光影师已就位，正在调整高级感...",
  "构图正在对齐，主体正在变清晰...",
  "材质和氛围正在叠加，马上出片...",
  "最后给画面加一点灵魂和锋芒..."
];
let loadingTimer = null;

init();

async function init() {
  bindEvents();
  await loadConfig();
  await loadHistory().catch(() => renderHistory(getPreviewHistory()));
}

function bindEvents() {
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
    await addFiles([...event.dataTransfer.files]);
  });
  fileInput.addEventListener("change", async () => {
    await addFiles([...fileInput.files]);
    fileInput.value = "";
  });
  document.addEventListener("paste", async (event) => {
    const files = [...event.clipboardData?.files || []].filter((file) => file.type.startsWith("image/"));
    if (files.length) await addFiles(files, "clipboard");
  });
  form.addEventListener("submit", submitJob);
  optimizePromptButton.addEventListener("click", optimizePromptInPlace);
  configOpenButton.addEventListener("click", openConfigModal);
  $("#closeConfig").addEventListener("click", closeConfigModal);
  configForm.addEventListener("submit", saveModelConfig);
  $("#refreshHistory").addEventListener("click", refreshHistoryWithFeedback);
  loadMoreHistory.addEventListener("click", () => {
    state.historyVisible += 8;
    renderHistory(state.historyItems);
  });
  ratioButton.addEventListener("click", toggleRatioMenu);
  document.querySelectorAll(".ratio-menu-item").forEach((button) => {
    button.addEventListener("click", () => selectRatio(button));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#ratioButton, #ratioMenu")) closeRatioMenu();
  });
  $("#closePreview").addEventListener("click", closePreview);
  previewModal.addEventListener("click", (event) => {
    if (event.target === previewModal) closePreview();
  });
  previewFeedback.querySelectorAll(".feedback-button").forEach((button) => {
    button.addEventListener("click", () => submitImageFeedback(button.dataset.feedback));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeRatioMenu();
    if (event.key === "Escape") closePreview();
    if (event.key === "Escape") closeConfigModal();
  });
}

async function loadConfig() {
  try {
    const config = await api("/api/config");
    state.config = config;
    providerDot.classList.toggle("ready", config.providerConfigured);
    providerText.textContent = config.providerConfigured ? `${config.model} 已就绪` : "未配置生图 Key";
    agentText.textContent = config.agentConfigured ? "Agent 优化已连接" : "未绑定 Agent，将自动直连";
    fillConfigForm(config);
  } catch {
    state.config = { providerConfigured: false, agentConfigured: false, model: "Preview Mode" };
    providerText.textContent = "配置读取失败";
    agentText.textContent = "离线预览模式，可直接查看界面";
  }
}

function fillConfigForm(config) {
  $("#imageProviderBase").value = config.providerBase || "";
  $("#imageProviderModel").value = config.model || "";
  $("#imageProviderName").value = config.providerName || config.provider || "";
  $("#languageModelBase").value = config.languageModelBase || "";
  $("#languageModelName").value = config.languageModel || "";
}

function openConfigModal() {
  configModal.hidden = false;
  configStatus.textContent = "Key 留空表示不修改当前密钥。";
}

function closeConfigModal() {
  configModal.hidden = true;
}

async function saveModelConfig(event) {
  event.preventDefault();
  configStatus.textContent = "正在保存配置...";
  const payload = Object.fromEntries(new FormData(configForm).entries());
  try {
    const result = await api("/api/config", { method: "POST", body: payload });
    state.config = result.config;
    fillConfigForm(result.config);
    providerText.textContent = `${result.config.model} 已就绪`;
    agentText.textContent = result.config.agentConfigured ? `语言模型：${result.config.languageModel}` : "未配置语言模型，使用本地小 Agent";
    providerDot.classList.toggle("ready", result.config.providerConfigured);
    configStatus.textContent = "配置已保存并立即生效。";
  } catch (error) {
    configStatus.textContent = `保存失败：${error.message}`;
  }
}

async function loadHistory() {
  const { items } = await api("/api/images/history");
  state.historyItems = items || [];
  state.historyVisible = Math.min(Math.max(state.historyVisible, 8), Math.max(state.historyItems.length, 8));
  renderHistory(items || []);
}

async function refreshHistoryWithFeedback() {
  const button = $("#refreshHistory");
  button.classList.add("is-refreshing");
  button.textContent = "刷新中...";
  setStatus("refreshing", "正在同步历史作品库...");
  try {
    await loadHistory();
    setStatus("idle", `历史作品已刷新，共 ${state.historyItems.length} 张`);
  } catch (error) {
    renderHistory(getPreviewHistory());
    setStatus("idle", "离线预览：已载入示例历史");
  } finally {
    setTimeout(() => {
      button.classList.remove("is-refreshing");
      button.textContent = "刷新";
    }, 420);
  }
}

async function addFiles(files, source = "upload") {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;
  setStatus("uploading", `正在保存 ${images.length} 张参考图...`);

  for (const file of images) {
    const dataUrl = await fileToDataUrl(file);
    const dimensions = await getImageDimensions(dataUrl).catch(() => null);
    const uploaded = await api("/api/images/upload", {
      method: "POST",
      body: { dataUrl, fileName: file.name || "clipboard.png", mime: file.type, source }
    });
    state.attachments.push({ ...uploaded, previewUrl: dataUrl, dimensions });
    if (state.ratioMode === "auto" && dimensions) applyAutoRatio(dimensions);
  }

  renderAttachments();
  setStatus("idle", "参考图已准备好");
}

async function submitJob(event) {
  event.preventDefault();
  if (state.busy) return;

  const sourcePrompt = promptInput.value.trim();
  if (!sourcePrompt) return;

  state.busy = true;
  generateButton.disabled = true;

  try {
    const attachments = [...state.attachments];
    const finalPrompt = sourcePrompt;

    setStatus("generating", "????????????...");
    startLoading("??????", "??????????????...");
    generateButton.classList.add("is-generating");
    const result = await api("/api/images/generate", {
      method: "POST",
      body: {
        prompt: finalPrompt,
        sourcePrompt,
        optimizedByAgent: false,
        attachmentIds: attachments.map((item) => item.id),
        ratio: getEffectiveRatio(),
        size: getEffectiveSize()
      }
    });

    state.results = dedupeById(result.outputs).slice(0, 1);
    state.previousOutput = result.outputs[0] || state.previousOutput;
    state.previousPrompt = result.prompt || sourcePrompt;
    state.attachments = [];
    renderAttachments();
    await loadHistory();
    stopLoading();
    renderResults();
    setStatus("done", result.summary?.learning || "??????????????????????");
  } catch (error) {
    const message = error.message || "????";
    setStatus("error", `?????${message}`);
    resultsGrid.classList.add("empty");
    resultsGrid.innerHTML = `<div class="error-card"><strong>????</strong><small>${escapeHtml(message)}</small></div>`;
  } finally {
    state.busy = false;
    generateButton.disabled = false;
    generateButton.classList.remove("is-generating");
    stopLoading();
  }
}

async function optimizePromptInPlace() {
  if (state.busy) return;
  const sourcePrompt = promptInput.value.trim();
  if (!sourcePrompt) {
    setStatus("error", "????????????");
    return;
  }

  state.busy = true;
  optimizePromptButton.disabled = true;
  optimizePromptButton.classList.add("is-optimizing");
  setStatus("optimizing", state.attachments.length ? "????????????..." : "???????...");

  try {
    const result = await api("/api/images/optimize-prompt", {
      method: "POST",
      body: {
        prompt: sourcePrompt,
        userPrompt: sourcePrompt,
        previousPrompt: state.previousPrompt,
        attachments: [...state.attachments]
      }
    });
    if (result.prompt) {
      promptInput.value = result.prompt;
      promptInput.focus();
      promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    }
    setStatus("done", "?????????????????");
  } catch (error) {
    setStatus("error", `????????${error.message}`);
  } finally {
    state.busy = false;
    optimizePromptButton.disabled = false;
    optimizePromptButton.classList.remove("is-optimizing");
  }
}

function renderAttachments() {
  attachmentList.innerHTML = "";
  for (const item of state.attachments) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<img src="${item.previewUrl || item.url}" alt=""><span>${escapeHtml(item.name || item.originalName || item.id)}</span><button type="button" aria-label="移除">×</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      state.attachments = state.attachments.filter((attachment) => attachment.id !== item.id);
      renderAttachments();
    });
    attachmentList.appendChild(chip);
  }
  updateGenerationModeUI();
}

function renderResults() {
  if (!resultLoading.hidden) {
    resultsGrid.classList.remove("empty");
    resultsGrid.innerHTML = "";
    return;
  }
  resultsGrid.classList.toggle("empty", state.results.length === 0);
  resultsGrid.innerHTML = state.results.length ? "" : "结果会出现在这里";
  for (const item of dedupeById(state.results).slice(0, 1)) resultsGrid.appendChild(createResultCard(item));
}

function dedupeById(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = item.id || item.url || item.filename;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderHistory(items) {
  state.historyItems = items;
  const visibleItems = items.slice(0, state.historyVisible);
  historyList.classList.toggle("empty", visibleItems.length === 0);
  historyList.innerHTML = visibleItems.length ? "" : "??????";
  loadMoreHistory.hidden = items.length <= visibleItems.length;
  for (const item of visibleItems) {
    const card = document.createElement("article");
    card.className = "history-item";
    const title = item.filename || item.sourcePrompt || item.prompt || item.id;
    card.innerHTML = `<img src="${item.url}" alt=""><button class="history-reference-button" type="button">??????</button><div class="history-info"><strong title="${escapeHtml(item.sourcePrompt || item.prompt || "")}">${escapeHtml(title)}</strong><small>${formatTime(item.createdAt)} ? ????</small></div>`;
    card.querySelector(".history-reference-button").addEventListener("click", (event) => {
      event.stopPropagation();
      useHistoryAsReference(item);
    });
    card.addEventListener("click", () => {
      openPreview(item);
    });
    historyList.appendChild(card);
  }
}

function useHistoryAsReference(item) {
  if (!state.attachments.some((attachment) => attachment.id === item.id)) {
    state.attachments.push({ ...item, name: item.filename });
  }
  state.previousOutput = item;
  state.previousPrompt = item.prompt || item.sourcePrompt || "";
  renderAttachments();
  setStatus("idle", `??? ${state.attachments.length} ????`);
}

function updateGenerationModeUI() {
  const count = state.attachments.length;
  referenceModeHint.textContent = count ? `??? ${count} ?????????????????` : "??????????????";
  generateButton.textContent = count ? "???????" : "?????";
}

function createResultCard(item) {
  const card = document.createElement("article");
  card.className = "result-card";
  card.innerHTML = `
    <img src="${item.url}" alt="????">
    <div class="result-body">
      <strong>${escapeHtml(item.sourcePrompt || item.prompt || item.filename)}</strong>
      <small>${escapeHtml(item.model || "image model")} ? ${escapeHtml(item.ratio || getRatioFromSize(item.size) || "1:1")} ? ${item.optimizedByAgent ? "Agent ??" : "??"}</small>
      <div class="result-actions">
        <a href="${item.url}" download="${escapeHtml(item.filename || "image.png")}">??</a>
        <button type="button">????</button>
      </div>
    </div>`;
  card.querySelector("img").addEventListener("click", () => openPreview(item));
  card.querySelector("button").addEventListener("click", async () => {
    await navigator.clipboard.writeText(new URL(item.url, location.origin).href);
    setStatus("idle", "???????");
  });
  return card;
}

function openPreview(item) {
  state.previewItem = item;
  previewImage.src = item.url;
  previewMeta.textContent = item.prompt || item.sourcePrompt || "";
  previewFeedback.hidden = false;
  previewFeedback.querySelectorAll(".feedback-button").forEach((button) => {
    button.classList.toggle("active", item.feedback?.value === button.dataset.feedback);
  });
  previewModal.hidden = false;
}

function toggleRatioMenu() {
  ratioMenu.hidden = !ratioMenu.hidden;
}

function closeRatioMenu() {
  ratioMenu.hidden = true;
}

function selectRatio(button) {
  document.querySelectorAll(".ratio-menu-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  sizeSelect.value = button.dataset.size;
  state.ratio = button.dataset.label;
  state.ratioMode = button.dataset.size === "auto" ? "auto" : "fixed";
  ratioLabel.textContent = state.ratio;
  if (state.ratioMode === "auto" && state.attachments[0]?.dimensions) applyAutoRatio(state.attachments[0].dimensions);
  setStatus("idle", state.ratioMode === "auto" ? `已选择自动比例：${getEffectiveRatio()}` : `已选择 ${state.ratio} 比例`);
  closeRatioMenu();
}

function applyAutoRatio(dimensions) {
  state.autoSize = getAutoSizeFromDimensions(dimensions.width, dimensions.height);
  ratioLabel.textContent = `自动 ${getRatioFromSize(state.autoSize)}`;
}

function getEffectiveSize() {
  if (state.ratioMode !== "auto") return sizeSelect.value;
  return getSizeFromPrompt(promptInput.value) || state.autoSize;
}

function getEffectiveRatio() {
  if (state.ratioMode !== "auto") return state.ratio;
  return getRatioFromSize(getEffectiveSize());
}

function closePreview() {
  previewModal.hidden = true;
  state.previewItem = null;
}

async function submitImageFeedback(value) {
  const item = state.previewItem;
  if (!item?.id || !["like", "dislike"].includes(value)) return;
  previewFeedback.querySelectorAll(".feedback-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.feedback === value);
  });
  item.feedback = { value, createdAt: Date.now() };
  try {
    await api("/api/images/feedback", {
      method: "POST",
      body: { imageId: item.id, feedback: value, prompt: item.prompt || item.sourcePrompt || "" }
    });
  } catch {
    previewFeedback.querySelectorAll(".feedback-button").forEach((button) => button.classList.remove("active"));
  }
}

function setStatus(type, message) {
  jobStatus.textContent = message;
  jobStatus.dataset.type = type;
}

function startLoading(title, hint) {
  loadingStage.hidden = false;
  resultLoading.hidden = false;
  resultsGrid.classList.remove("empty");
  resultsGrid.innerHTML = "";
  loadingTitle.textContent = title;
  loadingHint.textContent = hint;
  resultLoadingTitle.textContent = title;
  resultLoadingHint.textContent = hint;
  let index = 0;
  clearInterval(loadingTimer);
  loadingTimer = setInterval(() => {
    loadingHint.textContent = loadingHints[index % loadingHints.length];
    resultLoadingHint.textContent = loadingHints[index % loadingHints.length];
    index += 1;
  }, 1800);
}

function stopLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
  loadingStage.hidden = true;
  resultLoading.hidden = true;
}

async function api(url, options = {}) {
  if (location.protocol === "file:") throw new Error("Offline preview mode");
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function getPreviewHistory() {
  const now = Date.now();
  return [
    {
      id: "preview_01",
      url: demoImage("黑金 AI 产品海报"),
      filename: "preview-luxury-ai-poster.svg",
      sourcePrompt: "黑金风格 AI 产品海报，玻璃立方体，电影级布光",
      prompt: "高端黑金视觉，发光玻璃立方体，奢华产品发布会氛围，强对比，电影级布光",
      model: "Preview Mode",
      optimizedByAgent: true,
      ratio: "1:1",
      size: "1024x1024",
      createdAt: now - 180000
    },
    {
      id: "preview_02",
      url: demoImage("霓虹未来城市"),
      filename: "preview-neon-city.svg",
      sourcePrompt: "未来城市里的 AI 工作台，霓虹光，高级科技感",
      prompt: "未来城市，霓虹玻璃界面，紫金渐变，极简高端科技美学",
      model: "Preview Mode",
      optimizedByAgent: false,
      ratio: "16:9",
      size: "1536x864",
      createdAt: now - 460000
    }
  ];
}

function demoImage(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><radialGradient id="g" cx="50%" cy="30%" r="70%"><stop offset="0" stop-color="#e7c873"/><stop offset="0.35" stop-color="#fb5fb8"/><stop offset="0.7" stop-color="#151522"/><stop offset="1" stop-color="#07070a"/></radialGradient><filter id="blur"><feGaussianBlur stdDeviation="18"/></filter></defs><rect width="1024" height="1024" fill="url(#g)"/><circle cx="700" cy="260" r="190" fill="#62e6ff" opacity="0.35" filter="url(#blur)"/><rect x="230" y="230" width="564" height="564" rx="96" fill="rgba(255,255,255,0.09)" stroke="rgba(255,255,255,0.32)" stroke-width="3"/><path d="M300 650 C420 470 570 800 742 370" fill="none" stroke="#fff1b8" stroke-width="18" stroke-linecap="round" opacity="0.9"/><text x="512" y="880" fill="#f7f4ec" font-size="48" font-family="Arial, sans-serif" font-weight="800" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getImageDimensions(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function getAutoSizeFromDimensions(width, height) {
  const ratio = width / Math.max(height, 1);
  if (ratio >= 1.55) return "1536x864";
  if (ratio <= 0.68) return "864x1536";
  if (ratio >= 1.18) return "1536x1024";
  if (ratio <= 0.84) return "1024x1536";
  return "1024x1024";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function getRatioFromSize(size) {
  return ({ "1024x1024": "1:1", "1536x864": "16:9", "864x1536": "9:16", "1536x1024": "3:2", "1024x1536": "2:3", auto: "自动" })[size];
}

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

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}
