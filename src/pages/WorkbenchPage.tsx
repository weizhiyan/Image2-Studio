import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import type { CSSProperties } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import type {
  HistoryItem,
  ImageResult,
  VideoModelSchema,
  VideoParamSpec,
  VideoRatio,
  VideoReferenceMode,
  VideoResolution,
} from '@/types';
import {
  enhancePromptApi,
  enhanceVideoPromptApi,
  fetchVideoModelSchema,
  generate,
  getAgentStatus,
  getHistory,
  saveImageDataUrl,
  submitVideoTask,
  subscribePushedVideos,
  type AgentStatus,
  type PushedVideoEvent,
} from '@/lib/bridge';
import {
  RATIO_PRESETS,
  RESOLUTION_OPTIONS,
  pickSizeForResolution,
  ratioToNumber,
  type ResolutionLabel,
} from '@/lib/aspect';

function choiceThumbStyle(total: number, index: number): CSSProperties {
  return { '--choice-count': total, '--choice-index': index } as CSSProperties;
}

const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
import { pickTextProfile, resolveDirect } from '@/lib/enhance';
import { imageModelOptionsOf, type ImageModelOption } from '@/lib/imageModelOptions';
import { fillVideoSchemaDefaults, videoUploadParamForMode } from '@/lib/videoSchemaDefaults';
import { buildVideoPrompt } from '@/lib/videoPrompt';
import { profileReady, useSettingsStore, videoProfileOf } from '@/stores/settingsStore';
import ImagePreviewLightbox, {
  type ImagePreviewItem,
} from '@/components/canvas/ImagePreviewLightbox';
import HistoryPanel from '@/components/canvas/HistoryPanel';
import ImageAnnotator from '@/components/canvas/ImageAnnotator';
import OutpaintEditor, { type OutpaintResult } from '@/components/canvas/OutpaintEditor';
import ParameterSlider from '@/components/ParameterSlider';
import QuantitySegments from '@/components/QuantitySegments';
import AppModeTabs from '@/components/AppModeTabs';
import AgentConnectDialog from '@/components/AgentConnectDialog';
import AgentConnectIcon from '@/components/AgentConnectIcon';
import SettingsPanel from '@/components/SettingsPanel';
import { ChevronIcon } from '@/components/canvas/NodeChrome';
import {
  CopyGlyphIcon,
  CopySuccessGlyphIcon,
  HistoryGlyphIcon,
  PlusImageGlyphIcon,
  SendGlyphIcon,
  TrashGlyphIcon,
} from '@/components/chat/ChatIcons';
import {
  AiGlyphIcon,
  DownloadGlyphIcon,
  DrawGlyphIcon,
  OutpaintGlyphIcon,
  RegenGlyphIcon,
  ZoomGlyphIcon,
} from '@/components/canvas/NodeToolbarIcons';
import './workbench-page.css';

type WorkbenchMode = 'image' | 'video';
type WorkbenchVideoMode = 'text' | 'image';
const WORKBENCH_VIDEO_SECONDS = [4, 5, 6, 8, 10] as const;

interface ReferenceImage {
  dataUrl: string;
  name: string;
}

export interface WorkbenchResult {
  id: string;
  url: string;
  mediaType: 'image' | 'video';
  title: string;
  prompt: string;
  enhancedPrompt?: string;
  model: string;
  size?: string;
  fileName?: string;
  canvasId: string;
  createdAt: string;
  videoSeconds?: number;
  videoResolution?: VideoResolution;
  videoRatio?: VideoRatio;
  videoAudio?: boolean;
}

interface VideoResultMeta {
  prompt: string;
  model: string;
  ratio: VideoRatio;
  resolution: VideoResolution;
  seconds: number;
  audio: boolean;
}

export function isWorkbenchPath(pathname: string): boolean {
  const normalized = String(pathname || '/').split(/[?#]/, 1)[0];
  return normalized === '/workbench' || normalized === '/workbench/';
}

export function visibleVideoParams(schema: VideoModelSchema | null | undefined): VideoParamSpec[] {
  return (schema?.params || []).filter((param) => param.type !== 'upload' && param.type !== 'textarea');
}

export function videoControlParams(schema: VideoModelSchema | null | undefined): VideoParamSpec[] {
  return visibleVideoParams(schema).filter((param) => !/^(mode|generation_mode)$/i.test(param.name));
}

export function videoQuantityRange(param: VideoParamSpec): { min: number; max: number } | undefined {
  const nameAndLabel = `${param.name} ${param.label}`;
  if (/^(duration|seconds|video_seconds)$/i.test(param.name)
    || !/(?:^|[^a-z])(?:n|count|quantity|qty|num|number)(?:$|[^a-z])|数量|张数|个数|批次/i.test(nameAndLabel)) {
    return undefined;
  }

  const values = param.options?.map((option) => Number(option.value));
  if (!values || values.length < 2 || values.some((value) => !Number.isInteger(value))) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (new Set(values).size !== values.length || max - min + 1 !== values.length) return undefined;
  return { min, max };
}

export function videoQuantityValues(param: VideoParamSpec): number[] | undefined {
  if (/^(duration|seconds|video_seconds)$/i.test(param.name)
    || !/(?:^|[^a-z])(?:n|count|quantity|qty|num|number)(?:$|[^a-z])|数量|张数|个数|批次/i.test(`${param.name} ${param.label}`)) return undefined;
  const values = param.options?.map((option) => Number(option.value));
  if (!values || values.length < 2 || values.some((value) => !Number.isInteger(value)) || new Set(values).size !== values.length) return undefined;
  return values;
}

export function workbenchStageState(running: boolean, hasResult: boolean): 'running' | 'result' | 'empty' {
  if (running) return 'running';
  return hasResult ? 'result' : 'empty';
}

export function WorkbenchStageBackdrop({ running }: { running: boolean }) {
  return (
    <div className={`workbench-stage-backdrop${running ? ' is-running' : ''}`} aria-hidden="true">
      {running ? (
        <span className="workbench-stage-ripples">
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </div>
  );
}

function resultKey(item: Pick<WorkbenchResult, 'mediaType' | 'canvasId' | 'fileName' | 'createdAt'>): string {
  return `${item.mediaType}:${item.canvasId}:${item.fileName || ''}:${item.createdAt}`;
}

function historyKey(item: HistoryItem): string {
  return `${item.mediaType || 'image'}:${item.canvasId}:${item.fileName}:${item.createdAt}`;
}

export function mergeWorkbenchHistory(
  current: WorkbenchResult[],
  history: HistoryItem[],
): WorkbenchResult[] {
  const merged = new Map<string, WorkbenchResult>();
  for (const item of current) merged.set(resultKey(item), item);
  for (const item of history) {
    const result = historyToResult(item);
    const key = resultKey(result);
    if (!merged.has(key)) merged.set(key, result);
  }
  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function historyToResult(item: HistoryItem): WorkbenchResult {
  return {
    id: `history:${historyKey(item)}`,
    url: item.url,
    mediaType: item.mediaType || 'image',
    title: item.prompt || item.fileName || '生成结果',
    prompt: item.prompt || '',
    enhancedPrompt: item.enhancedPrompt || undefined,
    model: item.model || '',
    size: item.size || undefined,
    fileName: item.fileName || undefined,
    canvasId: item.canvasId || '',
    createdAt: item.createdAt || '',
    videoSeconds: item.videoSeconds,
    videoResolution: item.videoResolution,
    videoRatio: item.videoRatio,
    videoAudio: item.videoAudio,
  };
}

function resultToHistory(item: WorkbenchResult): HistoryItem {
  return {
    mediaType: item.mediaType,
    url: item.url,
    prompt: item.prompt,
    enhancedPrompt: item.enhancedPrompt || '',
    revisedPrompt: '',
    model: item.model,
    size: item.size || '',
    fileName: item.fileName || '',
    canvasId: item.canvasId,
    canvasName: '工作台',
    createdAt: item.createdAt,
    videoSeconds: item.videoSeconds,
    videoResolution: item.videoResolution,
    videoRatio: item.videoRatio,
    videoAudio: item.videoAudio,
    source: 'browser',
  };
}

function resultToPreview(item: WorkbenchResult): ImagePreviewItem {
  return {
    mediaType: item.mediaType,
    url: item.url,
    title: item.title || '生成结果',
    details: {
      prompt: item.prompt,
      enhancedPrompt: item.enhancedPrompt,
      model: item.model,
      size: item.size,
      fileName: item.fileName,
      createdAt: item.createdAt,
      videoSeconds: item.videoSeconds,
      videoResolution: item.videoResolution,
      videoRatio: item.videoRatio,
      videoAudio: item.videoAudio,
    },
  };
}

function resultFromImage(
  image: ImageResult,
  input: {
    prompt: string;
    originalPrompt: string;
    enhancedPrompt?: string;
    model: string;
    size: string;
    createdAt: string;
    nodeId: string;
  },
): WorkbenchResult {
  const id = `${input.nodeId}:${image.fileName || image.url}:${input.createdAt}`;
  return {
    id,
    url: image.url,
    mediaType: 'image',
    title: input.prompt,
    prompt: input.originalPrompt,
    enhancedPrompt: input.enhancedPrompt,
    model: input.model,
    size: input.size,
    fileName: image.fileName,
    canvasId: 'workbench',
    createdAt: input.createdAt,
  };
}

function uniqueId(prefix: string): string {
  const suffix = globalThis.crypto && 'randomUUID' in globalThis.crypto
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  return `${prefix}_${suffix}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

interface WorkbenchSelectOption {
  value: string;
  label: string;
  description?: string;
}

function WorkbenchSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = '暂无可选项',
}: {
  value: string;
  options: WorkbenchSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`workbench-select${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="workbench-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="workbench-select-value">
          <strong>{selected?.label || placeholder}</strong>
          {selected?.description ? <small>{selected.description}</small> : null}
        </span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="workbench-select-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={option.value === value ? 'is-selected' : ''}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span>
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {option.value === value ? <span aria-hidden="true">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function applyVideoMode(
  schema: VideoModelSchema | null,
  current: Record<string, unknown>,
  mode: WorkbenchVideoMode,
): Record<string, unknown> {
  const modeSpec = schema?.params.find((param) => /^(mode|generation_mode)$/i.test(param.name));
  if (!modeSpec?.options?.length) return current;
  const terms = mode === 'text'
    ? ['text', 't2v', 'text2video', '文生', '纯文本']
    : ['image', 'i2v', 'image2video', 'first_frame', 'frames', '图生', '首帧', '首尾帧'];
  const option = modeSpec.options.find((candidate) => {
    const text = `${candidate.value} ${candidate.label}`.toLowerCase().replace(/[\s_-]/g, '');
    return terms.some((term) => text.includes(term.toLowerCase().replace(/[\s_-]/g, '')));
  });
  return option ? { ...current, [modeSpec.name]: option.value } : current;
}

function schemaValueOf(
  schema: VideoModelSchema | null,
  params: Record<string, unknown>,
  matcher: RegExp,
): string {
  const spec = schema?.params.find((param) => matcher.test(param.name));
  return spec ? String(params[spec.name] ?? '') : '';
}

function fitDisplaySize(width: number, height: number): { width: number; height: number } {
  const safeWidth = width > 0 ? width : 1024;
  const safeHeight = height > 0 ? height : 1024;
  const scale = Math.min(920 / safeWidth, 620 / safeHeight, 1);
  return { width: safeWidth * scale, height: safeHeight * scale };
}

export default function WorkbenchPage() {
  const settings = useSettingsStore((state) => state.settings);
  const loadSettings = useSettingsStore((state) => state.load);
  const [mode, setMode] = useState<WorkbenchMode>('image');
  const [prompt, setPrompt] = useState('');
  const [optimizedFrom, setOptimizedFrom] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [reference, setReference] = useState<ReferenceImage | null>(null);
  const videoMode: WorkbenchVideoMode = reference ? 'image' : 'text';
  const [imageModelKey, setImageModelKey] = useState('');
  const [imageRatio, setImageRatio] = useState<(typeof RATIO_PRESETS)[number]>('1:1');
  const [imageResolution, setImageResolution] = useState<ResolutionLabel>('2K');
  const [imageCount, setImageCount] = useState(1);
  const [videoModel, setVideoModel] = useState('');
  const [videoRatio, setVideoRatio] = useState<VideoRatio>('16:9');
  const [videoResolution, setVideoResolution] = useState<VideoResolution>('720p');
  const [videoSeconds, setVideoSeconds] = useState(5);
  const [videoAudio, setVideoAudio] = useState(false);
  const [videoSchema, setVideoSchema] = useState<VideoModelSchema | null>(null);
  const [videoParams, setVideoParams] = useState<Record<string, unknown>>({});
  const [videoSchemaLoading, setVideoSchemaLoading] = useState(false);
  const [videoSchemaError, setVideoSchemaError] = useState('');
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState('');
  const [runProgress, setRunProgress] = useState(0);
  const [error, setError] = useState('');
  const [results, setResults] = useState<WorkbenchResult[]>([]);
  const [selectedResultId, setSelectedResultId] = useState('');
  const [preview, setPreview] = useState<ImagePreviewItem | null>(null);
  const [editingImage, setEditingImage] = useState<WorkbenchResult | null>(null);
  const [outpainting, setOutpainting] = useState<WorkbenchResult | null>(null);
  const [outpaintSize, setOutpaintSize] = useState({ width: 1024, height: 1024 });
  const [copiedId, setCopiedId] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>({ connected: false });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const copyTimerRef = useRef(0);
  const nodeIdRef = useRef('');
  const taskIdRef = useRef('');
  const videoModeRef = useRef(videoMode);
  const videoDefaultsRef = useRef({ ratio: videoRatio, resolution: videoResolution, seconds: videoSeconds });
  const videoMetaRef = useRef<VideoResultMeta>({
    prompt: '',
    model: '',
    ratio: '16:9',
    resolution: '720p',
    seconds: 5,
    audio: false,
  });
  if (!nodeIdRef.current) nodeIdRef.current = uniqueId('workbench');
  videoModeRef.current = videoMode;
  videoDefaultsRef.current = {
    ratio: videoRatio,
    resolution: videoResolution,
    seconds: videoSeconds,
  };

  const imageOptions = useMemo(() => imageModelOptionsOf(settings?.profiles), [settings?.profiles]);
  const selectedImageOption = imageOptions.find((option) => option.key === imageModelKey) || imageOptions[0];
  const videoProfile = useMemo(() => videoProfileOf(settings), [settings]);
  const videoModels = useMemo(() => {
    if (!videoProfile) return [];
    return videoProfile.enabledModels?.length
      ? videoProfile.enabledModels
      : [videoProfile.model].filter(Boolean);
  }, [videoProfile]);
  const selectedVideoModel = videoModels.includes(videoModel) ? videoModel : videoModels[0] || '';
  const selectedResult = results.find((item) => item.id === selectedResultId) || results[0] || null;
  const imageProfileReady = Boolean(
    selectedImageOption
    && profileReady(settings?.profiles.find((profile) => profile.id === selectedImageOption.profileId)),
  );
  const videoReady = Boolean(videoProfile && selectedVideoModel);
  const imageSize = pickSizeForResolution(ratioToNumber(imageRatio), imageResolution);
  const visibleParams = useMemo(() => visibleVideoParams(videoSchema), [videoSchema]);
  const videoControls = useMemo(() => videoControlParams(videoSchema), [videoSchema]);
  const hasSchemaDuration = visibleParams.some((param) => /^(duration|seconds|video_seconds)$/i.test(param.name));
  const hasSchemaResolution = visibleParams.some((param) => /^resolution$/i.test(param.name));
  const hasSchemaRatio = visibleParams.some((param) => /^(aspect_ratio|ratio)$/i.test(param.name));
  const panelResults = useMemo(
    () => mergeWorkbenchHistory(results, historyItems),
    [results, historyItems],
  );
  const previewPlaylist = useMemo(
    () => panelResults.map(resultToPreview),
    [panelResults],
  );

  useEffect(() => {
    if (!settings) void loadSettings();
  }, [loadSettings, settings]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const next = await getAgentStatus();
        if (alive) setAgentStatus(next);
      } catch {
        if (alive) setAgentStatus({ connected: false });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 8000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (imageOptions.length === 0) {
      setImageModelKey('');
      return;
    }
    if (!imageOptions.some((option) => option.key === imageModelKey)) {
      setImageModelKey(imageOptions[0].key);
    }
  }, [imageModelKey, imageOptions]);

  useEffect(() => {
    if (videoModels.length === 0) {
      setVideoModel('');
      return;
    }
    if (!videoModels.includes(videoModel)) setVideoModel(videoModels[0]);
  }, [videoModel, videoModels]);

  useEffect(() => {
    setVideoSchema(null);
    setVideoParams({});
    setVideoSchemaError('');
    if (!videoProfile || !selectedVideoModel) return undefined;
    const protocol = videoProfile.videoApiMode || 'auto';
    if (protocol !== 'media-v1' && protocol !== 'auto') return undefined;
    let cancelled = false;
    setVideoSchemaLoading(true);
    void fetchVideoModelSchema(videoProfile.id, selectedVideoModel)
      .then((schema) => {
        if (cancelled) return;
        setVideoSchema(schema);
        const defaults = fillVideoSchemaDefaults(schema, {}, {
          model: selectedVideoModel,
          seconds: videoDefaultsRef.current.seconds,
          resolution: videoDefaultsRef.current.resolution,
          ratio: videoDefaultsRef.current.ratio,
        });
        setVideoParams(applyVideoMode(schema, defaults, videoModeRef.current));
      })
      .catch((reason: unknown) => {
        if (cancelled || protocol === 'auto') return;
        setVideoSchemaError(reason instanceof Error ? reason.message : '读取模型参数失败');
      })
      .finally(() => {
        if (!cancelled) setVideoSchemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    selectedVideoModel,
    videoProfile,
  ]);

  useEffect(() => {
    setVideoParams((current) => applyVideoMode(videoSchema, current, videoMode));
  }, [videoMode, videoSchema]);

  const addResults = useCallback((incoming: WorkbenchResult[]) => {
    if (incoming.length === 0) return;
    setResults((current) => {
      const merged = new Map<string, WorkbenchResult>();
      for (const item of incoming) merged.set(resultKey(item), item);
      for (const item of current) {
        const key = resultKey(item);
        if (!merged.has(key)) merged.set(key, item);
      }
      return [...merged.values()].slice(0, 32);
    });
    setSelectedResultId(incoming[0].id);
  }, []);

  useEffect(() => subscribePushedVideos('workbench', (event: PushedVideoEvent) => {
    if (event.nodeId !== nodeIdRef.current) return;
    if (taskIdRef.current && event.taskId !== taskIdRef.current) return;
    if (event.phase === 'submitted' || event.phase === 'progress') {
      setRunning(true);
      setRunLabel(event.phase === 'submitted' ? '视频任务已提交' : '视频生成中');
      setRunProgress(Math.max(0, Math.min(100, Number(event.progress || 0))));
      return;
    }
    if (event.phase === 'failed') {
      setRunning(false);
      setRunProgress(0);
      setError(event.error || '视频生成失败');
      return;
    }
    if (event.phase === 'done') {
      const url = event.url || event.outputUrl || '';
      setRunning(false);
      setRunProgress(100);
      if (!url) {
        setError('视频任务已完成，但没有返回可播放文件');
        return;
      }
      const meta = videoMetaRef.current;
      const createdAt = event.finishedAt || new Date().toISOString();
      addResults([{
        id: `${nodeIdRef.current}:${event.taskId}:${createdAt}`,
        url,
        mediaType: 'video',
        title: meta.prompt,
        prompt: meta.prompt,
        model: meta.model,
        fileName: event.fileName,
        canvasId: 'workbench',
        createdAt,
        videoSeconds: meta.seconds,
        videoResolution: meta.resolution,
        videoRatio: meta.ratio,
        videoAudio: meta.audio,
      }]);
      setError('');
    }
  }), [addResults]);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  const clearOptimizedState = useCallback(() => {
    setOptimizedFrom('');
  }, []);

  const optimizePrompt = async () => {
    const original = prompt.trim();
    if (!original || optimizing) return;
    const textProfile = pickTextProfile(settings);
    if (!textProfile) {
      setError('请先在模型设置中配置可用的语言模型，再优化提示词');
      return;
    }
    setOptimizing(true);
    setError('');
    try {
      if (mode === 'video') {
        const optimized = await enhanceVideoPromptApi({
          prompt: original,
          ratio: videoRatio,
          seconds: videoSeconds,
          resolution: videoResolution,
          referenceMode: videoMode === 'image' ? 'first_frame' : 'style',
          profileId: textProfile.id,
        });
        if (!optimized.prompt) throw new Error('优化结果为空');
        setPrompt(optimized.prompt);
        setOptimizedFrom(original);
      } else {
        const optimized = await enhancePromptApi({
          prompt: original,
          size: imageSize,
          referenceDataUrls: reference ? [reference.dataUrl] : undefined,
          profileId: textProfile.id,
          usage: reference ? 'edit' : undefined,
        });
        if (!optimized.prompt) throw new Error('优化结果为空');
        setPrompt(optimized.prompt);
        setOptimizedFrom(original);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提示词优化失败');
    } finally {
      setOptimizing(false);
    }
  };

  const undoOptimize = () => {
    if (!optimizedFrom) return;
    setPrompt(optimizedFrom);
    setOptimizedFrom('');
    setError('');
  };

  const handleReferenceFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setReference({ dataUrl, name: file.name });
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取参考图失败');
    }
  };

  const generateImage = useCallback(async (override?: {
    prompt?: string;
    referenceDataUrl?: string;
    size?: string;
  }) => {
    if (running) return;
    const nextPrompt = String(override?.prompt ?? prompt).trim();
    if (!nextPrompt) {
      setError('请输入提示词');
      return;
    }
    if (!selectedImageOption || !imageProfileReady) {
      setError('请先在模型设置中配置可用的生图模型');
      return;
    }
    const nextSize = override?.size || imageSize;
    const nextReference = override?.referenceDataUrl || reference?.dataUrl || '';
    const direct = resolveDirect(undefined, settings?.direct);
    const apiMode = direct || selectedImageOption && settings?.profiles.find((profile) => profile.id === selectedImageOption.profileId)?.imageApiMode !== 'responses'
      ? 'images'
      : 'responses';
    const originalPrompt = optimizedFrom && nextPrompt === prompt ? optimizedFrom : nextPrompt;
    const enhancedPrompt = originalPrompt !== nextPrompt ? nextPrompt : undefined;
    setRunning(true);
    setRunLabel('正在生成图片');
    setRunProgress(0);
    setError('');
    try {
      const outcome = await generate({
        prompt: nextPrompt,
        originalPrompt,
        apiMode,
        model: selectedImageOption.model,
        size: nextSize,
        referenceDataUrls: nextReference ? [nextReference] : undefined,
        n: imageCount,
        canvasId: 'workbench',
        nodeId: nodeIdRef.current,
        profileId: selectedImageOption.profileId,
        referenceUsage: nextReference ? 'edit' : undefined,
      });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      if (outcome.images.length === 0) {
        setError('生图任务完成，但没有返回图片');
        return;
      }
      const createdAt = new Date().toISOString();
      addResults(outcome.images.map((image) => resultFromImage(image, {
        prompt: nextPrompt,
        originalPrompt,
        enhancedPrompt,
        model: selectedImageOption.model,
        size: nextSize,
        createdAt,
        nodeId: nodeIdRef.current,
      })));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '图片生成失败');
    } finally {
      setRunning(false);
      setRunProgress(0);
    }
  }, [
    addResults,
    imageCount,
    imageProfileReady,
    imageSize,
    optimizedFrom,
    prompt,
    reference,
    running,
    selectedImageOption,
    settings,
  ]);

  const submitVideo = useCallback(async () => {
    if (running) return;
    const nextPrompt = prompt.trim();
    if (!nextPrompt) {
      setError('请输入视频提示词');
      return;
    }
    if (!videoProfile || !selectedVideoModel) {
      setError('请先在模型设置中配置可用的视频模型');
      return;
    }
    let params = fillVideoSchemaDefaults(videoSchema || { name: selectedVideoModel, params: [] }, videoParams, {
      model: selectedVideoModel,
      seconds: videoSeconds,
      resolution: videoResolution,
      ratio: videoRatio,
    });
    params = applyVideoMode(videoSchema, params, videoMode);
    const modeSpec = videoSchema?.params.find((param) => /^(mode|generation_mode)$/i.test(param.name));
    const modeValue = String(params[modeSpec?.name || 'mode'] || '');
    const uploadSpec = videoSchema ? videoUploadParamForMode(videoSchema, modeValue) : undefined;
    if (videoMode === 'image' && !reference) {
      setError('图生视频需要先上传一张首帧图片');
      return;
    }
    if (videoMode === 'image' && uploadSpec?.required && !reference) {
      setError(`该模型的「${uploadSpec.label}」是必填项`);
      return;
    }

    const effectiveSeconds = Number(schemaValueOf(videoSchema, params, /^(duration|seconds|video_seconds)$/i))
      || videoSeconds;
    const effectiveResolution = (schemaValueOf(videoSchema, params, /^resolution$/i) || videoResolution) as VideoResolution;
    const schemaRatio = schemaValueOf(videoSchema, params, /^(aspect_ratio|ratio)$/i);
    const effectiveRatio = (!schemaRatio || /^(auto|adaptive)$/i.test(schemaRatio) ? videoRatio : schemaRatio) as VideoRatio;
    const referenceMode: VideoReferenceMode = videoMode === 'image' ? 'first_frame' : 'style';
    const effectivePrompt = buildVideoPrompt(nextPrompt, [], referenceMode, Boolean(reference), reference ? 1 : 0);
    taskIdRef.current = '';
    setRunning(true);
    setRunLabel('正在提交视频任务');
    setRunProgress(0);
    setError('');
    try {
      let imageFileNames: string[] = [];
      if (reference) {
        const saved = await saveImageDataUrl(reference.dataUrl);
        imageFileNames = saved.fileName ? [saved.fileName] : [];
        if (!saved.fileName) throw new Error('本地 Bridge 未返回参考图文件名');
      }
      const extraParams: Record<string, unknown> = {};
      for (const param of visibleParams) {
        const value = params[param.name];
        if (value !== undefined && value !== null && value !== '') extraParams[param.name] = value;
      }
      videoMetaRef.current = {
        prompt: effectivePrompt,
        model: selectedVideoModel,
        ratio: effectiveRatio,
        resolution: effectiveResolution,
        seconds: effectiveSeconds,
        audio: videoAudio,
      };
      const outcome = await submitVideoTask({
        nodeId: nodeIdRef.current,
        canvasId: 'workbench',
        prompt: effectivePrompt,
        profileId: videoProfile.id,
        model: selectedVideoModel,
        seconds: effectiveSeconds,
        resolution: effectiveResolution,
        ratio: effectiveRatio,
        generateAudio: videoAudio,
        referenceMode,
        params: extraParams,
        imageParamName: uploadSpec?.name,
        imageFileNames,
      });
      if (!outcome.ok) {
        setRunning(false);
        setError(outcome.submissionUnknown
          ? `${outcome.error || '提交结果未知'}。请先核查服务商任务记录，避免重复提交。`
          : outcome.error || '视频任务提交失败');
        return;
      }
      taskIdRef.current = outcome.taskId || '';
      setRunLabel(outcome.taskId ? '视频任务已提交，等待结果' : '视频任务已提交');
      setRunProgress(0);
    } catch (reason) {
      setRunning(false);
      setError(reason instanceof Error ? reason.message : '视频任务提交失败');
    }
  }, [
    prompt,
    reference,
    running,
    selectedVideoModel,
    videoAudio,
    videoMode,
    videoParams,
    videoProfile,
    videoRatio,
    videoResolution,
    videoSchema,
    videoSeconds,
    visibleParams,
  ]);

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    try {
      setHistoryItems(await getHistory());
    } catch (reason) {
      setHistoryError(reason instanceof Error ? reason.message : '读取生成历史失败');
    } finally {
      setHistoryLoading(false);
    }
  };

  const copyResultPrompt = async () => {
    const text = selectedResult?.prompt?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(selectedResult.id);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedId(''), 1400);
    } catch {
      setError('复制提示词失败');
    }
  };

  const downloadResult = () => {
    if (!selectedResult) return;
    const link = document.createElement('a');
    link.href = selectedResult.url;
    link.download = selectedResult.fileName || (selectedResult.mediaType === 'video' ? 'video.mp4' : 'image.png');
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleAnnotatorSave = async (dataUrl: string) => {
    const saved = await saveImageDataUrl(dataUrl);
    const createdAt = new Date().toISOString();
    addResults([{
      id: `${nodeIdRef.current}:annotation:${createdAt}`,
      url: saved.url,
      mediaType: 'image',
      title: editingImage?.title || '标注结果',
      prompt: editingImage?.prompt || '',
      model: editingImage?.model || '',
      size: editingImage?.size,
      fileName: saved.fileName,
      canvasId: 'workbench',
      createdAt,
    }]);
    setEditingImage(null);
  };

  const handleAnnotatorGenerate = async (dataUrl: string, nextPrompt: string) => {
    setEditingImage(null);
    await generateImage({ prompt: nextPrompt, referenceDataUrl: dataUrl });
  };

  const openOutpaint = (result: WorkbenchResult) => {
    const image = new Image();
    image.onload = () => {
      setOutpaintSize({ width: image.naturalWidth, height: image.naturalHeight });
      setOutpainting(result);
    };
    image.onerror = () => {
      setOutpaintSize({ width: 1024, height: 1024 });
      setOutpainting(result);
    };
    image.src = result.url;
  };

  const handleOutpaint = async (outpaint: OutpaintResult) => {
    setOutpainting(null);
    await generateImage({
      prompt: outpaint.prompt,
      referenceDataUrl: outpaint.dataUrl,
      size: outpaint.size,
    });
  };

  const handleModeChange = (nextMode: WorkbenchMode) => {
    setMode(nextMode);
    setOptimizedFrom('');
    setError('');
  };

  const displaySize = fitDisplaySize(outpaintSize.width, outpaintSize.height);
  const generationDisabled = mode === 'image'
    ? !imageProfileReady || !prompt.trim() || running
    : !videoReady || !prompt.trim() || running || (videoMode === 'image' && !reference);

  return (
    <div className="workbench-page">
      <header className="workbench-header hb-topbar">
        <AppModeTabs mode="workbench" />
        <div className="hb-topbar-spacer" />
        <span
          className={`image-canvas-mode-hint ${settings?.direct !== false ? 'is-direct' : 'is-enhance'}`}
          title={settings?.direct !== false
            ? '直连生图：使用 Image API。可在生成节点工具栏打开「智能生成」'
            : '智能生成：使用 Responses API，由主模型理解上下文并支持连续编辑'}
        >
          {settings?.direct !== false ? '直连生图 · Image API' : '智能生成 · Responses API'}
        </span>
        <button
          type="button"
          className={`agent-connect-btn${agentStatus.connected ? ' is-connected' : ''}`}
          aria-label={agentStatus.connected ? 'Agent 已连接，查看连接说明' : '连接第三方 Agent'}
          aria-haspopup="dialog"
          aria-expanded={agentOpen}
          onClick={() => {
            setAgentOpen(true);
            void getAgentStatus().then(setAgentStatus).catch(() => setAgentStatus({ connected: false }));
          }}
        >
          <AgentConnectIcon />
          <span className="agent-connect-btn-dot" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="image-canvas-btn workbench-settings-button"
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          模型设置
        </button>
      </header>

      <main className="workbench-shell">
        <section className="workbench-composer" aria-label="生成设置">
          <div className="workbench-mode-tabs" role="tablist" aria-label="生成类型">
            <span
              aria-hidden="true"
              className="workbench-mode-thumb"
              style={{ '--mode-thumb-x': mode === 'video' ? 'calc(100% + var(--spacing-1))' : '0' } as CSSProperties}
            />
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'image'}
              className={mode === 'image' ? 'is-active' : ''}
              onClick={() => handleModeChange('image')}
            >
              图像生成
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'video'}
              className={mode === 'video' ? 'is-active' : ''}
              onClick={() => handleModeChange('video')}
            >
              视频生成
            </button>
          </div>

          <div className="workbench-prompt-composer">
            <div className="workbench-reference-zone">
              {reference ? (
                <div className="workbench-reference">
                  <img src={reference.dataUrl} alt="已上传的参考图" />
                  <div>
                    <strong>{mode === 'video' && videoMode === 'image' ? '视频首帧' : '参考图片'}</strong>
                    <span>{reference.name}</span>
                  </div>
                  <button
                    type="button"
                    aria-label="移除参考图"
                    title="移除参考图"
                    onClick={() => setReference(null)}
                  >
                    <TrashGlyphIcon />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="workbench-upload"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PlusImageGlyphIcon />
                  <span>上传参考图</span>
                  <small>PNG、JPG、WebP</small>
                </button>
              )}
            </div>
            <div className="workbench-prompt-editor">
              <textarea
                id="workbench-prompt"
                aria-label="提示词"
                value={prompt}
                maxLength={2000}
                rows={6}
                placeholder={mode === 'image' ? '描述你想生成的画面、风格和光线…' : '描述镜头、主体动作、场景和节奏…'}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  if (optimizedFrom) clearOptimizedState();
                }}
              />
              <div className="workbench-prompt-actions">
                {optimizedFrom ? (
                  <button type="button" className="workbench-text-button" disabled={running} onClick={undoOptimize}>
                    撤回
                  </button>
                ) : null}
                <button
                  type="button"
                  className="workbench-quiet-button"
                  disabled={!prompt.trim() || optimizing || running}
                  onClick={() => void optimizePrompt()}
                >
                  <AiGlyphIcon />
                  <span>{optimizing ? '优化中…' : '优化提示词'}</span>
                </button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => void handleReferenceFile(event)}
            />
          </div>

          <div className="workbench-field workbench-parameters">
            {mode === 'video' && videoSchemaLoading ? <small className="workbench-parameter-note" role="status">读取视频参数中…</small> : null}
            {mode === 'image' ? (
              <>
                <div className="workbench-parameter-row">
                  <span className="workbench-parameter-label">模型</span>
                  <WorkbenchSelect
                    ariaLabel="图片模型"
                    value={selectedImageOption?.key || ''}
                    disabled={running || imageOptions.length === 0}
                    onChange={setImageModelKey}
                    placeholder="尚未配置模型"
                    options={imageOptions.map((option: ImageModelOption) => ({
                      value: option.key,
                      label: option.model,
                      description: option.profileName,
                    }))}
                  />
                </div>
                <div className="workbench-parameter-row">
                  <span className="workbench-parameter-label">比例</span>
                  <div className="workbench-choice-group" role="group" aria-label="图片比例">
                    <span
                      aria-hidden="true"
                      className="workbench-choice-thumb"
                      style={choiceThumbStyle(
                        RATIO_PRESETS.length,
                        Math.max(0, RATIO_PRESETS.indexOf(imageRatio as typeof RATIO_PRESETS[number])),
                      )}
                    />
                    {RATIO_PRESETS.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        className={imageRatio === ratio ? 'is-selected' : ''}
                        aria-pressed={imageRatio === ratio}
                        disabled={running}
                        onClick={() => setImageRatio(ratio)}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="workbench-parameter-row">
                  <span className="workbench-parameter-label">清晰度</span>
                  <div className="workbench-choice-group" role="group" aria-label="图片清晰度">
                    <span
                      aria-hidden="true"
                      className="workbench-choice-thumb"
                      style={choiceThumbStyle(
                        RESOLUTION_OPTIONS.length,
                        Math.max(0, RESOLUTION_OPTIONS.indexOf(imageResolution as typeof RESOLUTION_OPTIONS[number])),
                      )}
                    />
                    {RESOLUTION_OPTIONS.map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        className={imageResolution === resolution ? 'is-selected' : ''}
                        aria-pressed={imageResolution === resolution}
                        disabled={running}
                        onClick={() => setImageResolution(resolution as ResolutionLabel)}
                      >
                        {resolution}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="workbench-parameter-row">
                  <span className="workbench-parameter-label">数量</span>
                  <QuantitySegments
                    ariaLabel="图片数量"
                    min={1}
                    max={4}
                    value={imageCount}
                    disabled={running}
                    onChange={setImageCount}
                  />
                </div>
                <p className="workbench-parameter-note">输出尺寸 {imageSize.replace('x', ' × ')} px</p>
              </>
            ) : (
              <>
                <div className="workbench-parameter-row">
                  <span className="workbench-parameter-label">模型</span>
                  <WorkbenchSelect
                    ariaLabel="视频模型"
                    value={selectedVideoModel}
                    disabled={running || videoModels.length === 0}
                    onChange={setVideoModel}
                    placeholder="尚未配置模型"
                    options={videoModels.map((model) => ({ value: model, label: model }))}
                  />
                </div>
                <div className="workbench-parameter-stack">
                  {!hasSchemaRatio ? (
                    <div className="workbench-parameter-row">
                      <span className="workbench-parameter-label">画幅</span>
                      <div className="workbench-choice-group" role="group" aria-label="视频画幅">
                        <span
                          aria-hidden="true"
                          className="workbench-choice-thumb"
                          style={choiceThumbStyle(VIDEO_RATIOS.length, Math.max(0, VIDEO_RATIOS.indexOf(videoRatio)))}
                        />
                        {VIDEO_RATIOS.map((ratio) => (
                          <button
                            key={ratio}
                            type="button"
                            className={videoRatio === ratio ? 'is-selected' : ''}
                            aria-pressed={videoRatio === ratio}
                            disabled={running}
                            onClick={() => setVideoRatio(ratio)}
                          >
                            {ratio}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {!hasSchemaResolution ? (
                    <div className="workbench-parameter-row">
                      <span className="workbench-parameter-label">清晰度</span>
                      <div className="workbench-choice-group" role="group" aria-label="视频清晰度">
                          <span
                            aria-hidden="true"
                            className="workbench-choice-thumb"
                            style={choiceThumbStyle(VIDEO_RESOLUTIONS.length, Math.max(0, VIDEO_RESOLUTIONS.indexOf(videoResolution)))}
                          />
                          {VIDEO_RESOLUTIONS.map((resolution) => (
                          <button
                            key={resolution}
                            type="button"
                            className={videoResolution === resolution ? 'is-selected' : ''}
                            aria-pressed={videoResolution === resolution}
                            disabled={running}
                            onClick={() => setVideoResolution(resolution)}
                          >
                            {resolution}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {!hasSchemaDuration ? (
                    <div className="workbench-parameter-row">
                      <span className="workbench-parameter-label">时长</span>
                      <ParameterSlider
                        ariaLabel="视频时长"
                        min={0}
                        max={WORKBENCH_VIDEO_SECONDS.length - 1}
                        value={Math.max(0, WORKBENCH_VIDEO_SECONDS.indexOf(videoSeconds as (typeof WORKBENCH_VIDEO_SECONDS)[number]))}
                        valueLabel={`${videoSeconds}s`}
                        minLabel={`${WORKBENCH_VIDEO_SECONDS[0]}s`}
                        maxLabel={`${WORKBENCH_VIDEO_SECONDS[WORKBENCH_VIDEO_SECONDS.length - 1]}s`}
                        disabled={running}
                        onChange={(index) => setVideoSeconds(WORKBENCH_VIDEO_SECONDS[index])}
                      />
                    </div>
                  ) : null}
                </div>
                {videoControls.length > 0 ? (
                  <div className="workbench-schema-fields">
                    {videoControls.map((param) => {
                      const quantityValues = videoQuantityValues(param);
                      return (
                        <div key={param.name} className="workbench-parameter-row">
                          <span className="workbench-parameter-label">{param.label || param.name}</span>
                          {param.type === 'switch' ? (
                            <button
                              type="button"
                              className={`workbench-switch${videoParams[param.name] === true ? ' is-on' : ''}`}
                              role="switch"
                              aria-checked={videoParams[param.name] === true}
                              disabled={running}
                              onClick={() => setVideoParams((current) => ({
                                ...current,
                                [param.name]: current[param.name] !== true,
                              }))}
                            >
                              <span />
                            </button>
                          ) : /^(duration|seconds|video_seconds)$/i.test(param.name)
                            && param.options && param.options.length > 1
                            && param.options.every((option) => Number.isFinite(Number(option.value))) ? (
                            <ParameterSlider
                              ariaLabel={param.label || param.name}
                              min={0}
                              max={param.options.length - 1}
                              value={Math.max(0, param.options.findIndex((option) => option.value === String(videoParams[param.name] ?? param.options?.[0]?.value ?? '')))}
                              valueLabel={param.options[Math.max(0, param.options.findIndex((option) => option.value === String(videoParams[param.name] ?? param.options?.[0]?.value ?? '')))]?.label || String(videoParams[param.name] ?? '')}
                              minLabel={param.options[0].label || param.options[0].value}
                              maxLabel={param.options[param.options.length - 1].label || param.options[param.options.length - 1].value}
                              disabled={running}
                              onChange={(index) => setVideoParams((current) => ({
                                ...current,
                                [param.name]: param.options?.[index]?.value,
                              }))}
                            />
                          ) : quantityValues ? (
                            <QuantitySegments
                              ariaLabel={param.label || param.name}
                              min={Math.min(...quantityValues)}
                              max={Math.max(...quantityValues)}
                              options={quantityValues}
                              value={Number(videoParams[param.name] ?? quantityValues[0])}
                              disabled={running}
                              onChange={(quantity) => setVideoParams((current) => ({
                                ...current,
                                [param.name]: param.options?.find((option) => Number(option.value) === quantity)?.value,
                              }))}
                            />
                          ) : param.options?.length ? (
                            <WorkbenchSelect
                              ariaLabel={param.label || param.name}
                              value={String(videoParams[param.name] ?? param.options[0]?.value ?? '')}
                              disabled={running}
                              onChange={(value) => setVideoParams((current) => ({
                                ...current,
                                [param.name]: value,
                              }))}
                              options={param.options.map((option) => ({
                                value: option.value,
                                label: option.label || option.value,
                              }))}
                            />
                          ) : param.type === 'number' ? (
                            <input
                              className="workbench-parameter-input"
                              type="number"
                              value={String(videoParams[param.name] ?? '')}
                              disabled={running}
                              onChange={(event) => setVideoParams((current) => ({
                                ...current,
                                [param.name]: event.target.value,
                              }))}
                            />
                          ) : (
                            <input
                              className="workbench-parameter-input"
                              value={String(videoParams[param.name] ?? '')}
                              disabled={running}
                              onChange={(event) => setVideoParams((current) => ({
                                ...current,
                                [param.name]: event.target.value,
                              }))}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <label className="workbench-toggle-row">
                  <span>
                    <strong>生成声音</strong>
                    <small>模型支持时生效</small>
                  </span>
                  <button
                    type="button"
                    className={`workbench-switch${videoAudio ? ' is-on' : ''}`}
                    role="switch"
                    aria-checked={videoAudio}
                    disabled={running}
                    onClick={() => setVideoAudio((current) => !current)}
                  >
                    <span />
                  </button>
                </label>
                {videoSchemaError ? <p className="workbench-inline-error" role="alert">{videoSchemaError}</p> : null}
              </>
            )}
          </div>

          {mode === 'image' && !imageProfileReady ? (
            <p className="workbench-config-note">尚未配置生图模型，请先返回画布完成模型设置。</p>
          ) : null}
          {mode === 'video' && !videoReady ? (
            <p className="workbench-config-note">尚未配置视频模型，请先返回画布完成模型设置。</p>
          ) : null}
          {error ? <p className="workbench-error" role="alert">{error}</p> : null}

          <div className="workbench-generate-bar">
            <button
              type="button"
              className="workbench-generate"
              disabled={generationDisabled}
              onClick={() => void (mode === 'image' ? generateImage() : submitVideo())}
            >
              {mode === 'image' ? <SendGlyphIcon /> : <RegenGlyphIcon />}
              <span>{running ? (mode === 'image' ? '正在生成图片' : '视频任务处理中') : (mode === 'image' ? '生成图片' : '生成视频')}</span>
            </button>
          </div>
        </section>

        <section className={`workbench-results${historyOpen ? ' has-history' : ''}`} aria-label="生成结果">
          <div className="workbench-results-header">
            <div>
              <h1>生成结果</h1>
              <span>{panelResults.length > 0 ? `${panelResults.length} 条记录` : '当前工作台'}</span>
            </div>
            <button
              type="button"
              className="workbench-history-button"
              aria-label={historyOpen ? '关闭生成历史' : '打开生成历史'}
              aria-expanded={historyOpen}
              title={historyOpen ? '关闭生成历史' : '生成历史'}
              onClick={() => {
                if (historyOpen) setHistoryOpen(false);
                else void openHistory();
              }}
            >
              <HistoryGlyphIcon />
              <span>{historyOpen ? '关闭历史' : '历史记录'}</span>
            </button>
          </div>

          {historyOpen ? (
            <HistoryPanel
              inline
              items={panelResults.map(resultToHistory)}
              loading={historyLoading}
              error={historyError}
              onSelect={(item) => setPreview(resultToPreview(historyToResult(item)))}
              onClose={() => setHistoryOpen(false)}
              onRequestClose={() => setHistoryOpen(false)}
            />
          ) : null}

          <div
            className={`workbench-result-stage is-${workbenchStageState(running, Boolean(selectedResult))}`}
            data-state={workbenchStageState(running, Boolean(selectedResult))}
          >
            {workbenchStageState(running, Boolean(selectedResult)) !== 'result' ? (
              <WorkbenchStageBackdrop running={running} />
            ) : null}
            {running ? (
              <div className="workbench-running" role="status" aria-live="polite">
                <span className="workbench-running-mark" aria-hidden="true" />
                <strong>{runLabel}</strong>
                <small>{mode === 'video' ? '任务提交后可离开当前页面，历史记录会保留结果' : '正在生成，请稍候'}</small>
                {mode === 'video' ? (
                  <div className="workbench-progress" aria-label={`视频进度 ${Math.round(runProgress)}%`}>
                    <span style={{ transform: `scaleX(${Math.max(0.03, runProgress / 100)})` }} />
                  </div>
                ) : null}
              </div>
            ) : selectedResult ? (
              <div className="workbench-result-view">
                <div className="workbench-result-media">
                  {selectedResult.mediaType === 'video' ? (
                    <video src={selectedResult.url} controls playsInline preload="metadata" />
                  ) : (
                    <img
                      src={selectedResult.url}
                      alt={selectedResult.title || '生成图片'}
                      onLoad={(event) => setOutpaintSize({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                      })}
                    />
                  )}
                  <button
                    type="button"
                    className="workbench-result-expand"
                    aria-label="查看大图"
                    title="查看大图"
                    onClick={() => setPreview(resultToPreview(selectedResult))}
                  >
                    <ZoomGlyphIcon />
                  </button>
                </div>
                <div className="workbench-result-info">
                  <div className="workbench-result-copy">
                    <p>{selectedResult.prompt || selectedResult.title}</p>
                    {selectedResult.prompt.trim() ? (
                      <button
                        type="button"
                        aria-label="复制提示词"
                        title={copiedId === selectedResult.id ? '已复制' : '复制提示词'}
                        onClick={() => void copyResultPrompt()}
                      >
                        {copiedId === selectedResult.id ? <CopySuccessGlyphIcon /> : <CopyGlyphIcon />}
                      </button>
                    ) : null}
                  </div>
                  <div className="workbench-result-meta">
                    <span>{selectedResult.model || '模型未知'}</span>
                    <span>
                      {selectedResult.mediaType === 'video'
                        ? [selectedResult.videoResolution, selectedResult.videoRatio, selectedResult.videoSeconds ? `${selectedResult.videoSeconds}s` : ''].filter(Boolean).join(' · ')
                        : selectedResult.size || '尺寸未知'}
                    </span>
                  </div>
                  <div className="workbench-result-actions">
                    <button type="button" onClick={() => setPreview(resultToPreview(selectedResult))}>
                      <ZoomGlyphIcon />
                      <span>查看</span>
                    </button>
                    {selectedResult.mediaType === 'image' ? (
                      <>
                        <button type="button" onClick={() => setEditingImage(selectedResult)}>
                          <DrawGlyphIcon />
                          <span>绘画</span>
                        </button>
                        <button type="button" onClick={() => openOutpaint(selectedResult)}>
                          <OutpaintGlyphIcon />
                          <span>扩图</span>
                        </button>
                      </>
                    ) : null}
                    <button type="button" onClick={downloadResult}>
                      <DownloadGlyphIcon />
                      <span>下载</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="workbench-empty">
                <span className="workbench-empty-mark" aria-hidden="true">
                  {mode === 'image' ? <DrawGlyphIcon /> : <RegenGlyphIcon />}
                </span>
                <h2>{mode === 'image' ? '从一段描述开始' : videoMode === 'image' ? '用首帧启动镜头' : '把场景写成镜头'}</h2>
                <p>
                  {mode === 'image'
                    ? (imageProfileReady ? '输入提示词并生成，结果会留在这里。' : '配置生图模型后即可开始生成。')
                    : (videoReady ? '在左侧设置提示词与视频参数，生成结果会显示在这里。' : '配置视频模型后即可开始生成。')}
                </p>
              </div>
            )}
          </div>

          {results.length > 1 ? (
            <div className="workbench-result-strip" aria-label="本次生成结果">
              {results.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={item.id === selectedResult?.id ? 'is-active' : ''}
                  aria-label={`查看${item.mediaType === 'video' ? '视频' : '图片'}结果`}
                  onClick={() => setSelectedResultId(item.id)}
                >
                  {item.mediaType === 'video' ? (
                    <video src={item.url} muted playsInline preload="metadata" />
                  ) : (
                    <img src={item.url} alt="" />
                  )}
                </button>
              ))}
            </div>
          ) : null}
        </section>
      </main>

      <ImagePreviewLightbox
        item={preview}
        playlist={previewPlaylist}
        onNavigate={setPreview}
        onClose={() => setPreview(null)}
      />

      {editingImage ? (
        <ImageAnnotator
          imageUrl={editingImage.url}
          onCancel={() => setEditingImage(null)}
          onSave={handleAnnotatorSave}
          onGenerate={handleAnnotatorGenerate}
        />
      ) : null}

      {outpainting ? (
        <div className="workbench-editor-layer hb-canvas-wrap">
          <ReactFlowProvider>
            <OutpaintEditor
              imageUrl={outpainting.url}
              imageWidth={outpaintSize.width}
              imageHeight={outpaintSize.height}
              displayWidth={displaySize.width}
              displayHeight={displaySize.height}
              position={{ x: 140, y: 80 }}
              model={selectedImageOption?.model || outpainting.model}
              profileId={selectedImageOption?.profileId}
              modelOptions={imageOptions}
              onCancel={() => setOutpainting(null)}
              onSubmit={handleOutpaint}
            />
          </ReactFlowProvider>
        </div>
      ) : null}

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
      <AgentConnectDialog
        open={agentOpen}
        status={agentStatus}
        canvasId="workbench"
        canvasName="工作台"
        onClose={() => setAgentOpen(false)}
      />
    </div>
  );
}
