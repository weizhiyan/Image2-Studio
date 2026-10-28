import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const videoTaskMocks = vi.hoisted(() => ({
  getVideoTask: vi.fn(),
  VideoRequestError: class extends Error {
    constructor(readonly status: number, message: string) {
      super(message);
    }
    get definitiveFailure() {
      return this.status < 500 && this.status !== 408 && this.status !== 429;
    }
  },
  downloadVideoUrl: vi.fn(),
  downloadVideoContent: vi.fn(),
  readSettings: vi.fn(),
  findProfile: vi.fn(),
  pushVideo: vi.fn(),
  deleteMediaFile: vi.fn(),
}));

vi.mock('../bridge/videoApi.js', () => ({
  getVideoTask: videoTaskMocks.getVideoTask,
  VideoRequestError: videoTaskMocks.VideoRequestError,
  downloadVideoUrl: videoTaskMocks.downloadVideoUrl,
  downloadVideoContent: videoTaskMocks.downloadVideoContent,
  normalizeVideoRatio: (value: unknown) => value || '16:9',
  normalizeVideoResolution: (value: unknown) => value || '480p',
  normalizeVideoSeconds: (value: unknown) => Number(value) || 5,
}));
vi.mock('../bridge/settings.js', () => ({
  readSettings: videoTaskMocks.readSettings,
  findProfile: videoTaskMocks.findProfile,
}));
vi.mock('../bridge/hub.js', () => ({ pushVideo: videoTaskMocks.pushVideo }));
vi.mock('../bridge/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge/files.js')>()),
  deleteMediaFile: videoTaskMocks.deleteMediaFile,
}));

describe('视频任务记录', () => {
  let originalDataRoot: string | undefined;
  let tempDataRoot = '';
  let tasks: typeof import('../bridge/videoTasks');

  beforeEach(async () => {
    originalDataRoot = process.env.HUIBAN_DATA_ROOT;
    tempDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-video-tasks-'));
    process.env.HUIBAN_DATA_ROOT = tempDataRoot;
    vi.resetModules();
    vi.resetAllMocks();
    // 轮询器现在按 kind==='video' 找配置：mock 必须给出真实的 settings 形状
    videoTaskMocks.readSettings.mockResolvedValue({
      profiles: [{
        id: 'profile',
        kind: 'video',
        apiKey: 'key',
        baseUrl: 'https://provider.example/v1',
        model: 'video-model',
      }],
    });
    videoTaskMocks.findProfile.mockReturnValue({ id: 'profile', apiKey: 'key', baseUrl: 'https://provider.example/v1' });
    videoTaskMocks.getVideoTask.mockResolvedValue({ id: 'task', status: 'in_progress', progress: 10 });
    videoTaskMocks.downloadVideoUrl.mockResolvedValue({ fileName: 'video.mp4', url: '/api/files/video.mp4' });
    tasks = await import('../bridge/videoTasks');
  });

  afterEach(async () => {
    if (originalDataRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
    else process.env.HUIBAN_DATA_ROOT = originalDataRoot;
    await fs.rm(tempDataRoot, { recursive: true, force: true });
    tasks.__resetVideoPollerForTest();
    vi.resetModules();
  });

  it('按节点恢复最近一次任务，而不是旧任务', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '旧任务',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const latest = await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '新任务',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });

    expect((await tasks.findVideoTaskByNode('node'))?.createdAt).toBe(latest.createdAt);
  });

  it('提交回执绑定到最新占位任务，不误改旧任务', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '旧任务',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await new Promise((resolve) => setTimeout(resolve, 3));
    const latest = await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '新任务',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });

    await tasks.confirmVideoSubmission('node', 'task-new');
    const records = await tasks.listVideoTasks();
    const updated = records.find((record) => record.createdAt === latest.createdAt);
    const previous = records.find((record) => record.prompt === '旧任务');

    expect(updated?.taskId).toBe('task-new');
    expect(updated?.submissionUnknown).toBe(false);
    expect(updated?.error).toBeUndefined();
    expect(previous?.submissionUnknown).toBe(true);
  });

  it('结果未知时保留待核查标记', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.markVideoSubmissionUnknown('node', '提交结果未知');
    const record = await tasks.findVideoTaskByNode('node');

    expect(record?.submissionUnknown).toBe(true);
    expect(record?.error).toBe('提交结果未知');
  });

  it('拿到任务 ID 后清除结果未知错误并允许继续轮询', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.markVideoSubmissionUnknown('node', '提交结果未知');
    await tasks.confirmVideoSubmission('node', 'task-confirmed');
    const record = await tasks.findVideoTaskByNode('node');

    expect(record?.taskId).toBe('task-confirmed');
    expect(record?.submissionUnknown).toBe(false);
    expect(record?.error).toBeUndefined();
  });

  it('移除本地记录后查不到已丢弃的任务', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'task-to-remove');

    expect(await tasks.removeVideoTask('task-to-remove')).toBe(true);
    expect(await tasks.getVideoTaskRecord('task-to-remove')).toBeUndefined();
  });

  it('上游查询失败时持久化尝试次数，避免任务永远挂起', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'task-retry', { status: 'in_progress' });
    videoTaskMocks.getVideoTask.mockRejectedValueOnce(new Error('provider timeout'));

    await tasks.__tickVideoPollerForTest();

    await expect(tasks.getVideoTaskRecord('task-retry')).resolves.toMatchObject({
      status: 'in_progress',
      attempts: 1,
    });
  });

  it('达到轮询上限后将持续失败的任务标记失败', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'task-timeout', { status: 'in_progress' });
    const taskFile = path.join(tempDataRoot, 'video-tasks.json');
    const records = JSON.parse(await fs.readFile(taskFile, 'utf8')) as Array<{ taskId: string; attempts: number }>;
    records[0].attempts = 599;
    await fs.writeFile(taskFile, JSON.stringify(records), 'utf8');
    videoTaskMocks.getVideoTask.mockRejectedValueOnce(new Error('provider timeout'));

    await tasks.__tickVideoPollerForTest();

    await expect(tasks.getVideoTaskRecord('task-timeout')).resolves.toMatchObject({
      status: 'failed',
      attempts: 600,
      error: 'provider timeout',
    });
    expect(videoTaskMocks.pushVideo).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'failed',
      taskId: 'task-timeout',
    }));
  });

  it('视频任务超过 15 分钟会失败，不会跟随轮询退避挂数小时', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'task-too-old', { status: 'in_progress' });
    const taskFile = path.join(tempDataRoot, 'video-tasks.json');
    const records = JSON.parse(await fs.readFile(taskFile, 'utf8')) as Array<{ taskId: string; submittedAt: string }>;
    records[0].submittedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    await fs.writeFile(taskFile, JSON.stringify(records), 'utf8');

    await tasks.__tickVideoPollerForTest();

    await expect(tasks.getVideoTaskRecord('task-too-old')).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('超过 15 分钟'),
    });
    expect(videoTaskMocks.getVideoTask).not.toHaveBeenCalled();
  });

  it('任务状态查询返回明确 4xx 时立即失败，避免持续空轮询', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'task-rejected', { status: 'in_progress' });
    videoTaskMocks.getVideoTask.mockRejectedValueOnce(new videoTaskMocks.VideoRequestError(404, 'task not found'));

    await tasks.__tickVideoPollerForTest();

    await expect(tasks.getVideoTaskRecord('task-rejected')).resolves.toMatchObject({
      status: 'failed',
      error: 'task not found',
    });
  });

  it('同步结果下载失败后保留视频地址并在下一轮恢复', async () => {
    await tasks.reserveVideoTask({
      profileId: 'profile', nodeId: 'node', canvasId: 'canvas', prompt: '视频',
      model: 'video-model', seconds: 5, resolution: '480p', ratio: '16:9',
    });
    await tasks.confirmVideoSubmission('node', 'local-video-task', {
      status: 'in_progress',
      progress: 100,
      outputUrl: 'https://cdn.example/video.mp4',
    });
    videoTaskMocks.downloadVideoUrl
      .mockRejectedValueOnce(new Error('临时下载失败'))
      .mockResolvedValueOnce({ fileName: 'video.mp4', url: '/api/files/video.mp4' });

    await tasks.__tickVideoPollerForTest();
    await expect(tasks.getVideoTaskRecord('local-video-task')).resolves.toMatchObject({
      status: 'in_progress',
      attempts: 1,
      outputUrl: 'https://cdn.example/video.mp4',
    });

    await tasks.__tickVideoPollerForTest();

    const completed = await tasks.getVideoTaskRecord('local-video-task');
    expect(completed).toMatchObject({ status: 'completed', url: '/api/files/video.mp4' });
    expect(completed?.outputUrl).toBeUndefined();
    expect(videoTaskMocks.getVideoTask).not.toHaveBeenCalled();
  });
});
