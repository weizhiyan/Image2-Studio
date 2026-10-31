import fs from 'node:fs/promises';
import { VIDEO_TASKS_FILE } from './paths.js';
import { readSettings, type CustomVideoApiConfig, type ModelProfile, type VideoApiMode } from './settings.js';
import { downloadVideoContent, downloadVideoUrl, getVideoTask, normalizeVideoRatio, normalizeVideoResolution, normalizeVideoSeconds, VideoRequestError, type VideoTaskSnapshot, type VideoTaskStatus } from './videoApi.js';
import { pushVideo } from './hub.js';
import { deleteMediaFile, type SavedFile } from './files.js';

/**
 * 视频任务态：图片生成是「请求-响应」一次完，视频是「提交 → 轮询 → 下载」的长任务，
 * 所以必须把中间态落盘。三个后果都靠这个文件兜住：
 *   1. bridge 重启后接着轮询（不等用户重新点生成）；
 *   2. 浏览器关了 / 刷新了，回来进度还在；
 *   3. 「POST 发出但没拿到 id」这种断线情况有据可查——文档明确说不许自动重发，
 *      那就只能落一个 submissionUnknown 标记，让前端提示人去核查。
 *
 * 写入走串行链 + 原子 rename，与 settings.ts 同款：并发轮询 tick 不能把彼此的结果写丢。
 */

export interface VideoTaskRecord {
  /** 中转站返回的任务 id；submissionUnknown 时为空串。 */
  taskId: string;
  profileId: string;
  nodeId: string;
  canvasId: string;
  prompt: string;
  model: string;
  seconds: number;
  resolution: string;
  ratio: string;
  referenceMode?: 'first_frame' | 'last_frame' | 'style';
  /** 模型自己的参数（media-v1），原样留存便于诊断与重试。 */
  params?: Record<string, unknown>;
  /** 提交时实际使用的协议：轮询/下载沿用同一协议，避免 auto 在两次请求间猜出不同结果。 */
  apiMode?: VideoApiMode;
  /** 自定义协议快照：模型设置变更后，已提交任务仍沿原接口继续轮询。 */
  videoCustomConfig?: CustomVideoApiConfig;
  /** 承载参考图的参数名（images / img_url …）。 */
  imageParamName?: string;
  /** 已上传图床拿到的公网地址（原始 /api/files 引用不在这里）。 */
  imageUrls: string[];
  /** 本机参考图片文件名；不把可能含 Base64 的请求素材写进任务记录。 */
  imageFileNames?: string[];
  /** 上游直接返回的视频地址；先持久化，下载失败或 bridge 重启后可继续接收。 */
  outputUrl?: string;
  status: VideoTaskStatus;
  progress: number;
  /** 上游受理时间：任务等待上限从这里计算，不把首个提交请求时间算进去。 */
  submittedAt?: string;
  fileName?: string;
  url?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  /** POST 超时 / 断线，没拿到 id：留着提醒，绝不自动重发。 */
  submissionUnknown?: boolean;
  /** 轮询计数，兜底防上游卡死不结束。 */
  attempts?: number;
  /** 上次轮询时间：用于按次数退避，避免对慢任务每 5 秒打一次。 */
  lastPolledAt?: string;
  /** 下载占位：POST 路由与轮询器可能同时发现「已完成」，只允许一方真正下载。 */
  downloadClaimedAt?: string;
}

/** 轮询间隔：文档建议 5 秒。再快上游也未必更新，还容易踩 429。 */
const POLL_INTERVAL_MS = 5_000;
/** 单个视频最多等 15 分钟，避免已崩溃的上游任务在画布里挂数小时。 */
const MAX_TASK_RUNTIME_MS = 15 * 60 * 1000;
/** 次数上限只作损坏时间戳时的最后保险；正常任务由绝对运行时长收敛。 */
const MAX_POLL_ATTEMPTS = 600;
/** 完成记录保留 7 天：够用户回来找结果，又不让文件无限涨。 */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;

let writeChain: Promise<unknown> = Promise.resolve();

function withVideoTaskWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readTaskFile(): Promise<VideoTaskRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(VIDEO_TASKS_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as VideoTaskRecord[]) : [];
  } catch {
    // 文件损坏时先留一份原件，避免「任务全消失」这种事后再也查不到线索
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(VIDEO_TASKS_FILE, `${VIDEO_TASKS_FILE}.corrupt-${stamp}`).catch(() => undefined);
    return [];
  }
}

/** 原子写入：先写临时文件再 rename，进程被杀不会留下半截 JSON。 */
async function writeTaskFile(records: VideoTaskRecord[]): Promise<void> {
  const tmp = `${VIDEO_TASKS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmp, VIDEO_TASKS_FILE);
}

export async function listVideoTasks(): Promise<VideoTaskRecord[]> {
  return readTaskFile();
}

export async function getVideoTaskRecord(taskId: string): Promise<VideoTaskRecord | undefined> {
  const records = await readTaskFile();
  return records.find((item) => item.taskId === taskId);
}

/** 按节点找任务：前端刷新后靠 nodeId 把任务和画布节点重新对上。 */
export async function findVideoTaskByNode(nodeId: string): Promise<VideoTaskRecord | undefined> {
  const records = await readTaskFile();
  return records
    .filter((item) => item.nodeId === nodeId)
    .reduce<VideoTaskRecord | undefined>((latest, item) => (
      !latest || Date.parse(item.createdAt) >= Date.parse(latest.createdAt) ? item : latest
    ), undefined);
}

/**
 * 落一条任务。**提交之前就先占位**（taskId 空、submissionUnknown 未定）——
 * 否则 POST 成功但进程崩在拿到响应之前，这条任务就凭空消失了，用户看到的是
 * 「点了生成什么都没发生」，而上游已经在计费。
 *
 * 「查重 + 占位」必须在同一把写锁里完成：分成两步时，两个并发请求会同时通过查重、
 * 各自向上游下单，重复计费。reserved=false 表示该节点已有在途 / 结果未知任务。
 */
export interface VideoTaskReservation {
  record: VideoTaskRecord;
  reserved: boolean;
}

export async function reserveVideoTask(input: {
  profileId: string;
  nodeId: string;
  canvasId: string;
  prompt: string;
  model: string;
  seconds: number;
  resolution: string;
  ratio: string;
  referenceMode?: 'first_frame' | 'last_frame' | 'style';
  params?: Record<string, unknown>;
  apiMode?: VideoApiMode;
  videoCustomConfig?: CustomVideoApiConfig;
  imageParamName?: string;
  imageUrls?: string[];
  imageFileNames?: string[];
}): Promise<VideoTaskReservation> {
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const existing = [...records].reverse().find((item) => (
      item.nodeId === input.nodeId
      && (item.submissionUnknown || (!item.url && (item.status === 'queued' || item.status === 'in_progress')))
    ));
    if (existing) return { record: existing, reserved: false };

    const record: VideoTaskRecord = {
      taskId: '',
      profileId: input.profileId,
      nodeId: input.nodeId,
      canvasId: input.canvasId,
      prompt: input.prompt,
      model: input.model,
      seconds: normalizeVideoSeconds(input.seconds),
      resolution: normalizeVideoResolution(input.resolution),
      ratio: normalizeVideoRatio(input.ratio),
      referenceMode: input.referenceMode || 'first_frame',
      ...(input.params && Object.keys(input.params).length > 0 ? { params: input.params } : {}),
      ...(input.apiMode && input.apiMode !== 'auto' ? { apiMode: input.apiMode } : {}),
      ...(input.videoCustomConfig ? { videoCustomConfig: { ...input.videoCustomConfig } } : {}),
      ...(input.imageParamName ? { imageParamName: input.imageParamName } : {}),
      imageUrls: input.imageUrls || [],
      ...(input.imageFileNames?.length ? { imageFileNames: input.imageFileNames } : {}),
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      submissionUnknown: true,
    };
    records.push(record);
    await writeTaskFile(prune(records));
    return { record, reserved: true };
  });
}

/** 提交成功拿到 id：清掉「结果未知」标记，任务进入可轮询状态。 */
export async function confirmVideoSubmission(
  nodeId: string,
  taskId: string,
  patch: Partial<Pick<VideoTaskRecord, 'status' | 'progress' | 'outputUrl'>> = {},
): Promise<void> {
  await withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = [...records].reverse().find((item) => (
      item.nodeId === nodeId && (item.submissionUnknown || item.taskId === taskId)
    ));
    if (!hit) return;
    hit.taskId = taskId;
    hit.submissionUnknown = false;
    hit.error = undefined;
    hit.submittedAt = new Date().toISOString();
    hit.status = patch.status || 'queued';
    if (typeof patch.progress === 'number') hit.progress = patch.progress;
    if (patch.outputUrl) hit.outputUrl = patch.outputUrl;
    await writeTaskFile(records);
  });
}

/** 提交确认失败（拿到明确错误）：把任务标失败，让节点显示错误而不是干等。 */
export async function failVideoSubmission(nodeId: string, error: string): Promise<void> {
  await withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = [...records].reverse().find((item) => item.nodeId === nodeId && item.submissionUnknown);
    if (!hit) return;
    hit.submissionUnknown = false;
    hit.status = 'failed';
    hit.error = error;
    hit.finishedAt = new Date().toISOString();
    await writeTaskFile(records);
  });
}

/** POST 状态不确定时保留占位任务，让刷新后的节点继续提示用户先核查，避免重复扣费。 */
export async function markVideoSubmissionUnknown(nodeId: string, error: string): Promise<void> {
  await withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = [...records].reverse().find((item) => item.nodeId === nodeId && item.submissionUnknown);
    if (!hit) return;
    hit.error = error;
    await writeTaskFile(records);
  });
}

/** 删除本地关注记录；写锁避免和轮询状态更新并发覆盖。 */
export async function removeVideoTask(taskId: string): Promise<boolean> {
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const kept = records.filter((item) => item.taskId !== taskId);
    if (kept.length === records.length) return false;
    await writeTaskFile(kept);
    return true;
  });
}

/**
 * 按节点删除全部任务记录。
 * submissionUnknown 的占位 taskId 为空，删不掉也没法轮询——必须提供这条路，
 * 否则一次「明确拒绝」就能把节点永久锁死在「提交结果未知」。
 */
export async function removeVideoTaskByNode(nodeId: string): Promise<boolean> {
  const target = String(nodeId || '').trim();
  if (!target) return false;
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const kept = records.filter((item) => item.nodeId !== target);
    if (kept.length === records.length) return false;
    await writeTaskFile(kept);
    return true;
  });
}

/** 删除整张画布的任务记录（画布删除时级联，避免轮询器永远查一个不存在的画布）。 */
export async function removeVideoTasksByCanvas(canvasId: string): Promise<number> {
  const target = String(canvasId || '').trim();
  if (!target) return 0;
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const kept = records.filter((item) => item.canvasId !== target);
    await writeTaskFile(kept);
    return records.length - kept.length;
  });
}

/** 下载占位：POST 路由与轮询器同一时刻都发现「已完成」时，只让一方真正下载。 */
const DOWNLOAD_CLAIM_TTL_MS = 10 * 60_000;

export async function claimVideoDownload(taskId: string): Promise<boolean> {
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = records.find((item) => item.taskId === taskId);
    if (!hit) return false;
    if (hit.status === 'completed' || hit.url) return false;
    const claimedAt = Date.parse(hit.downloadClaimedAt || '');
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < DOWNLOAD_CLAIM_TTL_MS) return false;
    hit.downloadClaimedAt = new Date().toISOString();
    await writeTaskFile(records);
    return true;
  });
}

export async function releaseVideoDownload(taskId: string): Promise<void> {
  await withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = records.find((item) => item.taskId === taskId);
    if (!hit) return;
    delete hit.downloadClaimedAt;
    await writeTaskFile(records);
  });
}

async function patchTask(taskId: string, patch: Partial<VideoTaskRecord>): Promise<VideoTaskRecord | undefined> {
  return withVideoTaskWriteLock(async () => {
    const records = await readTaskFile();
    const hit = records.find((item) => item.taskId === taskId);
    if (!hit) return undefined;
    Object.assign(hit, patch);
    await writeTaskFile(prune(records));
    return hit;
  });
}

/** 清掉过期记录：完成/失败的留 7 天；「提交结果未知」的占位留 24 小时（足够人工核查，又不永久堆积）。 */
function prune(records: VideoTaskRecord[]): VideoTaskRecord[] {
  const finishedCutoff = Date.now() - KEEP_FINISHED_MS;
  const unknownCutoff = Date.now() - 24 * 60 * 60 * 1000;
  return records.filter((item) => {
    const created = Date.parse(item.createdAt || '');
    if (item.submissionUnknown) {
      return !Number.isFinite(created) || created > unknownCutoff;
    }
    if (item.status !== 'completed' && item.status !== 'failed') return true;
    const stamp = Date.parse(item.finishedAt || item.createdAt || '');
    return !Number.isFinite(stamp) || stamp > finishedCutoff;
  });
}

/* ── 轮询器 ── */

let poller: NodeJS.Timeout | null = null;
let ticking = false;

/**
 * 只有真正绑住 3788 的那个进程才轮询。MCP stdio 进程起来时端口常被占用，
 * 若它也跑轮询，同一个任务会被查询两遍、下载两遍（文档说下载可以重试，
 * 但没必要白白翻倍）。
 */
export function startVideoPoller(): void {
  if (poller) return;
  void tick();
  poller = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
  // 别让这个定时器把进程吊着不放：测试和退出时要能干净关掉
  poller.unref?.();
}

export function stopVideoPoller(): void {
  if (!poller) return;
  clearInterval(poller);
  poller = null;
}

/** 按轮询次数退避：慢任务不必每 5 秒打一次上游（也更容易踩 429）。 */
function pollBackoffMs(attempts: number): number {
  if (attempts < 20) return POLL_INTERVAL_MS;
  if (attempts < 60) return 10_000;
  if (attempts < 120) return 20_000;
  return 30_000;
}

/** 单轮最多同时推进几条：避免一条卡在 180 秒下载上拖住所有任务。 */
const MAX_CONCURRENT_POLLS = 3;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const records = await readTaskFile();
    const now = Date.now();
    const pending = records.filter((item) => {
      if (!isPending(item)) return false;
      // 前 20 次立即按 tick 节奏跑（下载失败能马上重试）；之后按次数退避
      const attempts = item.attempts || 0;
      if (attempts < 20) return true;
      const last = Date.parse(item.lastPolledAt || '');
      return !Number.isFinite(last) || now - last >= pollBackoffMs(attempts);
    });
    for (let index = 0; index < pending.length; index += MAX_CONCURRENT_POLLS) {
      await Promise.all(pending.slice(index, index + MAX_CONCURRENT_POLLS).map((item) => advance(item)));
    }
  } catch {
    /* 单轮失败不该中断后续轮询 */
  } finally {
    ticking = false;
  }
}

function isPending(record: VideoTaskRecord): boolean {
  // 已完成的任务(有成品或明确失败)不再轮询
  if (record.status === 'completed' || record.status === 'failed') return false;
  if (record.url) return false;
  if (record.submissionUnknown) return false;
  return record.status === 'queued' || record.status === 'in_progress';
}

async function advance(record: VideoTaskRecord): Promise<void> {
  if (!record.taskId) return;
  const attempts = (record.attempts || 0) + 1;
  const acceptedAt = Date.parse(record.submittedAt || record.createdAt || '');
  if (Number.isFinite(acceptedAt) && Date.now() - acceptedAt >= MAX_TASK_RUNTIME_MS) {
    const message = `视频任务等待超过 15 分钟（任务 ${record.taskId}），请到中转站后台核查`;
    const failed = await patchTask(record.taskId, {
      status: 'failed',
      error: message,
      attempts,
      finishedAt: new Date().toISOString(),
    });
    if (!failed) return;
    pushVideo({
      type: 'video',
      phase: 'failed',
      canvasId: record.canvasId,
      nodeId: record.nodeId,
      taskId: record.taskId,
      status: 'failed',
      error: '视频任务等待超过 15 分钟，请到中转站后台核查',
    });
    return;
  }
  // 记录本次轮询时间（退避判据）；同时确保下面的查询失败也不会被立刻重复打
  await patchTask(record.taskId, { lastPolledAt: new Date().toISOString() });
  try {
    const settings = await readSettings();
    // 必须按 kind 找视频配置：配置被删后 findProfile 会静默回落到图片配置，
    // 结果就是拿图片 Key/Base URL 去查视频任务，永远失败且原因诡异。
    const profile = settings.profiles.find((item) => item.id === record.profileId);
    if (!profile || profile.kind !== 'video') {
      const message = '这条视频任务对应的模型配置已被删除，请重新提交';
      const failed = await patchTask(record.taskId, {
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
        attempts,
      });
      if (!failed) return;
      pushVideo({
        type: 'video',
        phase: 'failed',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: 'failed',
        error: message,
      });
      return;
    }
    // 提交时记录的协议优先：auto 在不同进程/不同时刻可能猜出不同结果
    const effectiveProfile: ModelProfile = {
      ...profile,
      ...(record.apiMode ? { videoApiMode: record.apiMode } : {}),
      ...(record.videoCustomConfig ? { videoCustomConfig: record.videoCustomConfig } : {}),
    };
    if (record.outputUrl) {
      await finishTask(record, effectiveProfile, { id: record.taskId, status: 'completed', progress: 100, outputUrl: record.outputUrl });
      return;
    }
    const snapshot = await getVideoTask(effectiveProfile, record.taskId, record.model);
    if (snapshot.status === 'completed') {
      await finishTask(record, effectiveProfile, snapshot);
      return;
    }
    if (snapshot.status === 'failed') {
      const updated = await patchTask(record.taskId, {
        status: 'failed',
        progress: snapshot.progress,
        error: snapshot.error || '视频生成失败',
        finishedAt: new Date().toISOString(),
        attempts,
      });
      if (!updated) return;
      pushVideo({
        type: 'video',
        phase: 'failed',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: 'failed',
        error: snapshot.error || '视频生成失败',
      });
      return;
    }
    const nextStatus: VideoTaskStatus = snapshot.status === 'queued' ? 'queued' : 'in_progress';
    const changed = record.status !== nextStatus || record.progress !== snapshot.progress;
    const updated = await patchTask(record.taskId, { status: nextStatus, progress: snapshot.progress, attempts });
    if (!updated) return;
    if (changed || attempts === 1) {
      pushVideo({
        type: 'video',
        phase: 'progress',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: nextStatus,
        progress: snapshot.progress,
      });
    }
    if (attempts >= MAX_POLL_ATTEMPTS) {
      const failed = await patchTask(record.taskId, {
        status: 'failed',
        error: `轮询 ${MAX_POLL_ATTEMPTS} 次仍未完成，请到中转站后台核查任务 ${record.taskId}`,
        finishedAt: new Date().toISOString(),
      });
      if (!failed) return;
      pushVideo({
        type: 'video',
        phase: 'failed',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: 'failed',
        error: '等待超时，请到中转站后台核查该任务',
      });
    }
  } catch (err) {
    // 认证、参数、任务不存在等明确 4xx 立刻停止；超时、限流、服务端错误和网络抖动重试。
    const definitiveFailure = err instanceof VideoRequestError && err.definitiveFailure;
    if (record.outputUrl && !definitiveFailure) {
      const message = err instanceof Error ? err.message : '视频已生成，但文件接收失败';
      const updated = await patchTask(record.taskId, { attempts, error: message });
      if (!updated) return;
      pushVideo({
        type: 'video',
        phase: 'download-failed',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: 'in_progress',
        progress: 100,
        error: message,
        recoverable: true,
      });
      return;
    }
    if (definitiveFailure || attempts >= MAX_POLL_ATTEMPTS) {
      const message = err instanceof Error ? err.message : '视频任务查询失败';
      const failed = await patchTask(record.taskId, {
        status: 'failed',
        error: message,
        attempts,
        finishedAt: new Date().toISOString(),
      });
      if (!failed) return;
      pushVideo({
        type: 'video',
        phase: 'failed',
        canvasId: record.canvasId,
        nodeId: record.nodeId,
        taskId: record.taskId,
        status: 'failed',
        error: message,
      });
    } else {
      // 必须把失败次数落盘；否则每一轮都从相同 attempts 重新开始，永远到不了超时上限。
      await patchTask(record.taskId, { attempts });
    }
  }
}

export async function completeVideoTask(taskId: string, saved: SavedFile): Promise<void> {
  const record = await getVideoTaskRecord(taskId);
  if (!record) {
    await deleteMediaFile(saved.fileName);
    return;
  }
  // 并发防护：另一条路径已经落过成品，这一份是重复下载，删掉多余文件即可
  if (record.url && record.url !== saved.url) {
    await deleteMediaFile(saved.fileName);
    return;
  }
  const finishedAt = new Date().toISOString();
  const updated = await patchTask(taskId, {
    status: 'completed',
    progress: 100,
    fileName: saved.fileName,
    url: saved.url,
    outputUrl: undefined,
    downloadClaimedAt: undefined,
    error: undefined,
    finishedAt,
  });
  if (!updated) {
    await deleteMediaFile(saved.fileName);
    return;
  }
  pushVideo({
    type: 'video',
    phase: 'done',
    canvasId: record.canvasId,
    nodeId: record.nodeId,
    taskId,
    status: 'completed',
    progress: 100,
    fileName: saved.fileName,
    url: saved.url,
    finishedAt,
  });
}

async function finishTask(record: VideoTaskRecord, profile: ModelProfile, snapshot: VideoTaskSnapshot): Promise<void> {
  // 只允许一方下载：POST 路由和轮询器可能同时看到「已完成」
  const claimed = await claimVideoDownload(record.taskId);
  if (!claimed) return;
  try {
    const saved = snapshot.outputUrl
      ? await downloadVideoUrl(snapshot.outputUrl, profile.apiKey, profile.baseUrl)
      : await downloadVideoContent(profile, record.taskId, record.model);
    await completeVideoTask(record.taskId, saved);
  } catch (err) {
    // 释放占位，下一轮继续重试（下载失败不该判死任务）
    await releaseVideoDownload(record.taskId);
    throw err;
  }
}

/** 供测试与退出时清场。 */
export function __resetVideoPollerForTest(): void {
  stopVideoPoller();
}

export function __tickVideoPollerForTest(): Promise<void> {
  return tick();
}
