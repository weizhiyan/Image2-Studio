/** 画布节点：生成输入 / 结果 / 参考素材 / 视频，以及仅用于承载成员的编组节点。 */
export type CanvasNodeKind = 'composer' | 'image' | 'reference' | 'video' | 'text' | 'group';

/** 编组标题栏可选颜色。neutral 不额外染色，其余映射到现有 accent token。 */
export type CanvasGroupColor = 'neutral' | 'blue' | 'green' | 'amber' | 'purple';

/**
 * 视频节点自成一套（kind: 'video'），不复用 composer/image 那套状态机：
 * 视频是长任务，节点上要挂「排队 / 生成中(进度) / 完成 / 失败」四态，
 * 而图片是同步等结果，两者生命周期不一样，硬塞进一个 kind 只会互相干扰。
 */
export type VideoNodeStatus = 'idle' | 'running' | 'done' | 'error';

/** 视频任务在中转站侧的状态：提交后由 bridge 轮询，经 SSE 推给节点。 */
export type VideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';

/** 视频宽高比：文档给的六个值，adaptive 需要有图输入，界面不暴露。 */
export const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export type VideoRatio = typeof VIDEO_RATIOS[number];

/** 视频清晰度：档位不是像素值，别传 1080x1920 那种字符串。 */
export const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export type VideoResolution = typeof VIDEO_RESOLUTIONS[number];
export type VideoReferenceMode = 'first_frame' | 'last_frame' | 'style';

/* ── 视频模型参数 schema ──
   中转站（/v1/skills/models/{name}）会给出每个模型自己的参数定义：
   seedance 叫 images、wan2.6 叫 img_url、gk-video 又不一样。
   界面不再写死「比例 / 画质 / 时长」三件套，而是按这份 schema 动态渲染。 */
export type VideoParamType = 'select' | 'radio' | 'switch' | 'upload' | 'textarea' | 'number' | 'segment';

export interface VideoParamOption {
  label: string;
  value: string;
}

export interface VideoParamSpec {
  /** 提交时 params 里的 key。 */
  name: string;
  label: string;
  type: VideoParamType;
  required?: boolean;
  description?: string;
  options?: VideoParamOption[];
}

export interface VideoModelSchema {
  name: string;
  displayName?: string;
  description?: string;
  inputHint?: string;
  tags?: string[];
  params: VideoParamSpec[];
}

/** 可选视频模型（设置面板 / 节点模型下拉用）。 */
export interface VideoModelInfo {
  name: string;
  displayName?: string;
  description?: string;
  /** 中转站标记当前 Key 能否调用；false 时不要放进可选列表。 */
  available: boolean;
}

/**
 * 语言模型的上游接口格式：chat = /chat/completions，responses = /responses，
 * auto = 先 chat，遇路由类错误自动回落 responses（Codex 系路由器只能走 responses）。
 */
export type TextApiFormat = 'chat' | 'responses' | 'auto';
export type ImageApiMode = 'images' | 'responses';

/**
 * composer 引用预览（灵枢同款）：图片引用带缩略图；
 * 文本引用（只有提示词、还没出图的生成节点）只展示 T 图标与文本，生成时合并进提示词。
 */
export interface CanvasReference {
  id: string;
  url: string;
  title: string;
  kind?: 'image' | 'text';
  text?: string;
  /** 图片来源节点的原始像素尺寸：自动比例按它推导宽高比（缺省时自动退回 1:1）。 */
  width?: number;
  height?: number;
}

/** 生成阶段：enhance = 语言模型整理提示词中；generate = 生图模型出图中。 */
export type ComposerStage = 'enhance' | 'generate';

/**
 * 结果节点上的一个版本：一次生成 / 一次二次编辑的产物，按时间正序存（新版本在末位）。
 * 同一张结果图反复迭代时不再新开节点，全部沉淀在这里，模型与用户都只面对一个节点。
 */
export interface CanvasNodeVersion {
  id: string;
  imageUrl: string;
  fileName: string;
  /** 这一版实际发出去的提示词。 */
  prompt: string;
  model: string;
  size: string;
  width?: number;
  height?: number;
  /** 这一版发起生成的时间。 */
  createdAt: string;
  /** 这一版出图完成的时间。 */
  finishedAt: string;
  enhancedPrompt?: string;
  revisedPrompt?: string;
  /** 由哪个版本二次编辑而来；首版为空。 */
  baseVersionId?: string;
  /** Responses API conversation context for editing this exact version. */
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
  responseProfileId?: string;
}

export interface CanvasNodeData {
  kind: CanvasNodeKind;
  label: string;
  /** group：标题栏色调；成员节点不读取。 */
  groupColor?: CanvasGroupColor;
  /** composer：正在编辑的提示词；image：生成用的提示词；reference：无。 */
  prompt?: string;
  /** text：Markdown 文本节点的原始内容；被模型节点连入时作为提示词引用。 */
  textContent?: string;
  status?: 'idle' | 'running' | 'done' | 'error';
  /** image 节点：媒体服务返回的文件 URL（/api/files/xxx）。 */
  imageUrl?: string;
  /** reference / 图生图：dataURL 形式的位图。 */
  referenceDataUrl?: string;
  /** composer：上游连线带来的引用（图片缩略图 / 纯文本引用），由边同步，随持久化保存。 */
  references?: CanvasReference[];
  /** composer：是否处于可输入状态（选中节点后再次点击输入区进入，方便直接拖动卡片）。 */
  composerEditing?: boolean;
  fileName?: string;
  model?: string;
  size?: string;
  /** composer：工具栏选中的画幅预设（"auto" = 按参考图自动推导；"16:9" / "1:1" / "9:16" 为手动锁定）。
   *  提示词里写明比例时始终优先于这里（对齐灵枢的优先级链）。 */
  ratio?: string;
  /** composer：分辨率档位（1K / 2K / 4K，长边像素），与比例共同决定发给生图模型的 size。 */
  resolution?: '1K' | '2K' | '4K';
  /** composer：一次生成几张（1~8），结果作为多个版本挂回同一节点。 */
  imageCount?: number;
  /** 兼容旧字段：true = Image API，false = Responses API；不设则跟随全局 API 模式。 */
  direct?: boolean;
  /**
   * 生成节点运行态的「本次实际直连与否」：决定流体描边 / 关联线条的颜色（白 = 直连，
   * 紫 = 模型优化在跑）。只在生成入口写、结束或出错时清，不随节点级 direct 覆盖变粘滞。
   */
  runningDirect?: boolean;
  /**
   * composer：用户手动拖拽调整过的参考图顺序（reference id 数组）。缺省时仍按源节点
   * 位置排序；有值时 chips 编号与发给模型的图片数组都照它来。
   */
  referenceOrder?: string[];
  /** composer：生成阶段，驱动运行态的文案。 */
  stage?: ComposerStage;
  /** image：经语言模型优化后实际发出、浏览器原始输入的提示词。 */
  enhancedPrompt?: string;
  /** image：语言模型优化失败、按原文发送时的标记。 */
  enhanceFailed?: boolean;
  /** image：生图模型服务端润色后的提示词（revised_prompt）。 */
  revisedPrompt?: string;
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
  responseProfileId?: string;
  /** 卡片宽度（px）：与 width/height（位图像素）分开存，避免把卡片撑成原图尺寸。 */
  cardWidth?: number;
  /**
   * image：历次生成沉淀成的版本链（新的在末位）。老节点没有这个字段，
   * 读取时按「当前这张图」补一版（见 lib/versions 的 normalizeVersions）。
   */
  versions?: CanvasNodeVersion[];
  /** image：当前作为主图展示的版本 id；缺省取最后一版（即最新版）。 */
  activeVersionId?: string;
  /**
   * 二次编辑态：被钉进输入区的基准图版本 id。
   * kind === 'composer' 且该字段有值时，节点就是「在原图上迭代」的编辑态——
   * 输入区里那张不可移除的引用就是它，生成完成后字段清空、节点回到图片态。
   */
  reditBaseVersionId?: string;
  error?: string;
  /** composer：手动拉伸后的卡片高度（px），配 nodeHeightManual 使用。 */
  nodeHeight?: number;
  /** composer：是否手动拉伸过高度；为 true 时卡片高度不再跟随内容自适应。 */
  nodeHeightManual?: boolean;
  /** composer：开始生成的时间，同时驱动运行计时与预览里的「用时」。 */
  createdAt?: string;
  /** image：生成完成的时间。 */
  finishedAt?: string;
  /** 外部来源：mcp = Codex / 其他 Agent 推来的图。 */
  source?: 'browser' | 'mcp';
  width?: number;
  height?: number;

  /* ── 视频节点（kind: 'video'）──
     与图片字段分开存，避免两类媒体在同一份 data 上互相踩。
     videoUrl 走 /api/files/<name>，由 bridge 轮询到完成后落盘推来。 */
  /** 视频成品地址（/api/files/vid_xxx.mp4）。 */
  videoUrl?: string;
  /** 视频文件名：删节点时按它清文件，与 imageUrl 同一套清理逻辑。 */
  videoFileName?: string;
  /** 视频时长（秒）：提交时定的，完成后仍带在节点上供展示。 */
  videoSeconds?: number;
  /** 清晰度档位（480p / 720p / 1080p）。 */
  videoResolution?: VideoResolution;
  /** 提交请求超时或连接中断，服务端可能已受理；需要用户核查后才能重试。 */
  videoSubmissionUnknown?: boolean;
  /** 宽高比（16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9）。 */
  videoRatio?: VideoRatio;
  /** 是否生成声音。 */
  videoAudio?: boolean;
  /** 连接到视频节点的图片用途。 */
  videoReferenceMode?: VideoReferenceMode;
  /** 按模型 schema 选出的参数值（key = VideoParamSpec.name），原样进 /media/generate 的 params。 */
  videoParams?: Record<string, unknown>;
  /** 该模型里承载参考图的 upload 参数名（images / img_url …），bridge 据此把图床上传结果落位。 */
  videoImageParamName?: string;
  /** 视频节点自己的状态：视频是长任务，不用图片那套 running/done。 */
  videoStatus?: VideoNodeStatus;
  /** 中转站任务 id：刷新后靠它把节点和 bridge 里的任务重新对上。 */
  videoTaskId?: string;
  /** 0–100 生成进度，中转站直接给。 */
  videoProgress?: number;
  /** 视频模型名（与图片的 model 分开，因为可能是另一路配置）。 */
  videoModel?: string;
  /** 这一路视频配置的 id。 */
  videoProfileId?: string;
  /** 首帧 / 参考图：公网 HTTPS 地址（本机图先过图床）。提交时确定，不带原始 /api/files 引用。 */
  videoImageUrls?: string[];
  /** 首帧来源的说明文案，展示给用户看「这张图是从哪个节点连过来的」。 */
  videoSourceLabel?: string;
  /** 视频任务的失败原因。 */
  videoError?: string;
  /** 视频提示词整理状态，属于运行态。 */
  videoPromptOptimizing?: boolean;
  videoPromptError?: string;
  /** 脚本优化后的撤销快照。 */
  videoPromptOriginal?: string;
  videoPromptOptimized?: boolean;
  /** React Flow v12 要求节点 data 满足 Record<string, unknown>。 */
  [key: string]: unknown;
}

export interface CanvasDoc {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
  updatedAt: string;
}

/** 与 @xyflow/react 的 RF 节点同构，这里只声明自用字段；渲染层再收窄。 */
export interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: CanvasNodeData;
  /** React Flow 层级：编组低于成员，保证 8% 彩色底不污染节点卡片。 */
  zIndex?: number;
  width?: number;
  height?: number;
  /** group 成员指向父组；position 为相对父组坐标。仅允许一层。 */
  parentId?: string;
  extent?: 'parent';
  expandParent?: boolean;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

/** 配置种类：image = 生图模型；text = 语言 / 多模态模型（发送前整理提示词）；video = 视频生成模型。 */
export type ProfileKind = 'image' | 'text' | 'video';

/** 视频配置的请求协议；auto 会按 Base URL / 模型名选择适配器。 */
export type VideoApiMode = 'auto' | 'openai-videos' | 'xai-videos' | 'grsai-generate' | 'media-v1' | 'custom';

export interface CustomVideoApiConfig {
  createPath: string;
  pollPath: string;
  imageTransport: 'public-url' | 'data-url';
  headersTemplate: string;
  requestBodyTemplate: string;
  taskIdPath: string;
  statusPath: string;
  progressPath: string;
  outputUrlPath: string;
  errorPath: string;
  statusMap: string;
}

/** 一路生图模型配置（Base URL / Key / 模型列表独立，可同时存在多路）。 */
export interface ModelProfileView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  defaultSize: string;
  /** 从服务端拉取到的候选模型列表。 */
  models: string[];
  /** 勾选启用的模型；默认模型从其中选择。 */
  enabledModels: string[];
  /** 在配置卡片里展示的模型（内层勾选）；缺省时回落到 enabledModels。 */
  selectedModels?: string[];
  /** 这路配置的用途。 */
  kind: ProfileKind;
  /** 该路是否已存 Key（不回显 key 本身）。 */
  keyConfigured: boolean;
  /** false = 停用这路配置：不参与默认竞选（界面置灰）；缺省视为启用 */
  enabled?: boolean;
  /** 语言模型的上游接口格式；生图配置恒为 auto。 */
  textFormat: TextApiFormat;
  /** Image API (default) or conversational Responses image-generation tool. */
  imageApiMode?: ImageApiMode;
  /** Mainline model for Responses API; separate from the image tool model. */
  responsesModel?: string;
  /** 视频配置的上游协议。 */
  videoApiMode?: VideoApiMode;
  videoCustomConfig?: CustomVideoApiConfig;
}

/** 提示词整理强度：只影响语言模型那一次对话，不改变生图模型参数。 */
export type EnhanceLevel = 'strict' | 'balanced' | 'creative';

/** 偏好档案的一条：manual = 灯箱手动录入；auto = 由生成记录归纳。 */
export interface PreferenceEntry {
  id: string;
  text: string;
  source: 'manual' | 'auto';
  createdAt: string;
}

export interface PreferenceProfile {
  /** 是否注入语言模型优化对话；未调用优化时无副作用。 */
  enabled: boolean;
  entries: PreferenceEntry[];
  updatedAt: string;
}

export interface MemorySettings {
  enabled: boolean;
  shortTermMessageLimit: number;
  shortTermTokenBudget: number;
  summaryTriggerTokens: number;
  summaryTargetTokens: number;
  maxRecentOutputs: number;
}

export interface ChatRuntimeSettings {
  maxModelRounds: number;
  maxToolCalls: number;
  maxImagesPerRun: number;
  confirmImagesAbove: number;
  maxOutputTokens: number;
}

export interface MediaSettings {
  /** 全部生图配置；「生图设置」里可增删改。 */
  profiles: ModelProfileView[];
  /** 当前生效的那一路：浏览器生成与 Codex 生成都默认走它。 */
  activeProfileId: string;
  /** 兼容旧字段：true = Image API；false = Responses 智能生成。 */
  direct: boolean;
  /** 是否在浏览器生图前额外调用一次语言模型整理提示词。 */
  promptOptimizationEnabled: boolean;
  /** 优化提示词用的语言模型 id；为空时取第一把可用的语言模型。 */
  textProfileId: string;
  /** 整理强度：高遵循 / 均衡 / 创意。 */
  enhanceLevel: EnhanceLevel;
  /** 用户偏好档案：归纳 + 手动录入，注入优化对话。 */
  preferences: PreferenceProfile;
  chatMemory: MemorySettings;
  chatRuntime: ChatRuntimeSettings;
}

export interface ImageResult {
  fileName: string;
  url: string;
  revisedPrompt?: string;
  responseId?: string;
  imageGenerationCallId?: string;
  responseModel?: string;
}

export type GenerateOutcome =
  | { ok: true; jobId: string; images: ImageResult[] }
  | { ok: false; error: string };

/** 生成历史的一条：全部画布的图片与视频汇成的时间线（bridge /api/history）。 */
export interface HistoryItem {
  mediaType?: 'image' | 'video';
  url: string;
  prompt: string;
  /** 该图在所属结果节点版本链里的序号（1 起）；没有版本链的老节点为空。 */
  versionIndex?: number;
  /** 所属结果节点的版本总数；大于 1 说明这个节点被二次编辑过。 */
  versionCount?: number;
  /** 这一版是由哪个版本二次编辑来的（同链内的版本 id）。 */
  baseVersionId?: string;
  /** 该图所属的结果节点 id，用于从历史面板定位回画布。 */
  nodeId?: string;
  /** 版本链里这一版的 id，配合 baseVersionId 解析“基于 Vx”。 */
  versionId?: string;
  enhancedPrompt: string;
  revisedPrompt: string;
  model: string;
  size: string;
  fileName: string;
  canvasId: string;
  canvasName: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  videoSeconds?: number;
  videoResolution?: VideoResolution;
  videoRatio?: VideoRatio;
  videoAudio?: boolean;
  source: 'browser' | 'mcp' | string;
}

/* ── 对话（全局独立线程）──
   线程由自身 id 标识，与画布生命周期无关；canvasId 仅记录最近的画布/结果落点。
   图片引用继续携带来源画布和版本，删除画布不应删除对话历史。 */

/** 对话消息里引用的画布图片：版本级引用。
 *  用户引的是具体版本，不是"当前节点"——节点后来产生新版本，历史消息仍指向发送当时的版本。 */
export interface ChatImageRef {
  canvasId: string;
  nodeId: string;
  /** 具体版本 id；缺省 = 发送时节点的当前主图版本。 */
  versionId?: string;
  /** 仅用于当前界面缩略图，不能作为唯一事实源（事实源是画布节点）。 */
  url?: string;
  title?: string;
  /** 引用在用户输入纯文本中的插入位置，用于在编辑器与历史消息里内联展示。 */
  position?: number;
}

/** 对话消息里的生成结果：指向画布上的节点 + 版本（通过 nodeId + versionId 关联）。 */
export interface ChatMessageMedia {
  url: string;
  fileName: string;
  /** 生成结果所在节点：点图定位落它。 */
  nodeId: string;
  /** 结果落点画布；线程独立于画布，单个线程的结果可分布在不同画布。 */
  canvasId?: string;
  /** 版本链里的版本 id：下一轮上下文续接取它的 responseId。 */
  versionId: string;
  /** Agent 交给提示词优化器前的原始意图。 */
  originalPrompt?: string;
  /** 优化器实际交给生图接口的提示词；为空时表示优化失败并回退原文。 */
  enhancedPrompt?: string;
  referenceUsage?: 'style' | 'edit';
  enhancementWarning?: string;
  prompt: string;
  model: string;
  size: string;
}

/** 长对话的持久化记忆：原始消息始终保留，摘要和当前目标只作为压缩上下文。 */
export interface ChatThreadMemory {
  version?: number;
  memoryRevision?: number;
  summaryThroughMessageId?: string;
  clearedThroughMessageId?: string;
  /** Last run's observed window; estimates are not billing data. */
  windowMessageCount?: number;
  windowEstimatedTokens?: number;
  compactionStatus?: 'idle' | 'pending' | 'complete' | 'failed';
  warning?: string;
  summary?: string;
  summaryMessageCount?: number;
  summaryUpdatedAt?: string;
  goal?: {
    mode?: string;
    statement?: string;
    deliverable?: string;
    confirmed?: string[];
    preserve?: string[];
    change?: string[];
    rejected?: string[];
    openQuestions?: string[];
    updatedAt?: string;
  };
  visualWorkingSet?: {
    base?: Record<string, unknown>;
    sourceAnchor?: Record<string, unknown>;
    references?: Array<Record<string, unknown>>;
    recentOutputs?: Array<Record<string, unknown>>;
    inheritMode?: 'auto' | 'edit' | 'new';
    explicitNewRequest?: boolean;
  };
  lastCompactionAt?: string;
}

/** 本轮实际用的上下文：给用户看"模型记得什么"，断链时讲清原因。 */
export interface ChatMessageContext {
  /** 续接了哪个画布版本的 responseId；空 = 本轮是全新上下文。 */
  baseVersionId?: string;
  responseId?: string;
  /** 作为参考图发给模型的图片数。 */
  referenceCount: number;
  /** 上下文被重置的原因（换配置 / 跨模式）；空 = 正常续接或首轮。 */
  resetReason?: string;
}

/** 工具调用记录（generate_image）：折叠过程卡的数据。 */
export interface ChatToolCall {
  id: string;
  name: string;
  /** 参数摘要：prompt / 参考图张数 / 比例 / 张数 / 是否续接。 */
  args: Record<string, unknown>;
  status: 'running' | 'done' | 'error' | 'stopped';
  /** 过程步骤文案（已理解方向 / 正在准备参考图 / 正在调用生图工具 / 已生成 N 张候选图）。 */
  steps: string[];
  /** 工具产出的图（指向画布节点版本，与画布节点通过 nodeId + versionId 关联）。 */
  media?: ChatMessageMedia[];
  error?: string;
  /** 本次调用实际使用的生图模型。 */
  model?: string;
  /** 模型配置名称，便于失败时定位是哪一路配置。 */
  profileName?: string;
  /** 生图开始时间与耗时。 */
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** 预估/实际输出尺寸。 */
  size?: string;
}

export interface ChatClarificationOption {
  label: string;
  value: string;
  description?: string;
  recommended?: boolean;
}

export interface ChatClarificationQuestion {
  id: string;
  title: string;
  description?: string;
  type?: 'single' | 'multiple' | 'text';
  optional?: boolean;
  multiple: boolean;
  options: ChatClarificationOption[];
}

export interface ChatClarification {
  callId: string;
  questions: ChatClarificationQuestion[];
  answers?: Record<string, string[]>;
  status: 'awaiting_input' | 'answered' | 'cancelled';
}

/** 用户提交结构化询问后的可展开摘要，作为一条用户消息显示并回喂后续对话。 */
export interface ChatAskResponseSummary {
  title: string;
  questions: Array<{
    id: string;
    title: string;
    answers: string[];
  }>;
}

export interface ChatModelSelection {
  textProfileId?: string;
  textModel?: string;
  imageProfileId?: string;
  imageModel?: string;
}

export interface ChatRoleSkill {
  id: string;
  name: string;
  content: string;
}

/** 发送时的角色快照：重试与历史回放不依赖角色之后是否被编辑或删除。 */
export interface ChatRoleSnapshot {
  id: string;
  name: string;
  avatarUrl?: string;
  category?: string;
  systemPrompt: string;
  skills: ChatRoleSkill[];
  /** 对话采样温度 0-1；缺省按 0.6。 */
  temperature?: number;
}

/** 消息运行态：运行中 / 完成 / 失败 / 已停止 / 刷新后状态未知（不伪装成完成）。 */
export type ChatMessageStatus = 'running' | 'awaiting_input' | 'done' | 'error' | 'stopped' | 'unknown';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** assistant：模型显式返回的思考过程（不是隐藏推理；上游不返回时为空）。 */
  reasoning?: string;
  /** user：发送时引用的画布图片快照（版本级）。 */
  attachments?: ChatImageRef[];
  /** assistant：生成的图（指向画布节点版本）。 */
  media?: ChatMessageMedia[];
  /** assistant：本轮 agent 的工具调用痕迹。 */
  toolCalls?: ChatToolCall[];
  /** Agent 的结构化追问和用户回答；不参与图像提示词优化，只作为对话上下文。 */
  clarifications?: ChatClarification[];
  /** 用户提交结构化追问后的答案摘要。 */
  askResponse?: ChatAskResponseSummary;
  /** 发送这轮消息时选择的语言模型 / 生图模型。 */
  modelSelection?: ChatModelSelection;
  /** 发送这轮消息时选中的角色；未选择时表示通用模式。 */
  agentRole?: ChatRoleSnapshot;
  runId?: string;
  requestId?: string;
  retrySource?: {
    content: string;
    attachments?: ChatImageRef[];
    modelSelection?: ChatModelSelection;
    agentRole?: ChatRoleSnapshot;
    answers?: Record<string, string[]>;
  };
  /** 本轮上下文徽标：续接了哪一版 / 断链原因。 */
  context?: ChatMessageContext;
  status?: ChatMessageStatus;
  error?: string;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  revision?: number;
  generation?: number;
  /** 最近的画布/默认生成落点，不代表线程归属；独立对话可以没有画布。 */
  canvasId?: string;
  /** 本线程使用的语言模型配置与具体模型；发出第一条消息后锁定，换模型需新建对话。 */
  textProfileId?: string;
  textModel?: string;
  /** Agent 出图使用的生图配置与模型；可随时切换，新对话继承。 */
  imageProfileId?: string;
  imageModel?: string;
  title: string;
  messages: ChatMessage[];
  memory?: ChatThreadMemory;
  createdAt: string;
  updatedAt: string;
}
