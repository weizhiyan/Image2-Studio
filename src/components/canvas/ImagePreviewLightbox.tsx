import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createAsset, getAssets, moveAssetToFolder, revealLocalFile, type AssetLibrary } from '@/lib/bridge';
import { AssetGlyphIcon } from './NodeChrome';
import './ImagePreviewLightbox.css';

const MIN_PREVIEW_ZOOM = 0.5;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 0.25;
const PREVIEW_PROMPT_HEIGHTS_KEY = 'huiban-preview-prompt-heights';
const DEFAULT_PROMPT_HEIGHT = 160;
const MIN_PROMPT_HEIGHT = 96;
const MAX_PROMPT_HEIGHT = 480;

function clampPromptHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PROMPT_HEIGHT;
  return Math.min(MAX_PROMPT_HEIGHT, Math.max(MIN_PROMPT_HEIGHT, Math.round(value)));
}

function readPromptHeights(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PREVIEW_PROMPT_HEIGHTS_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed || {})) {
      if (typeof value === 'number') result[key] = clampPromptHeight(value);
    }
    return result;
  } catch {
    return {};
  }
}

export interface ImagePreviewDetails {
  /** 用户提示词。 */
  prompt?: string;
  /** 经语言模型优化后实际发给生图模型的提示词。 */
  enhancedPrompt?: string;
  /** 生图模型服务端润色后的提示词（revised_prompt）。 */
  revisedPrompt?: string;
  /** 语言模型优化失败、按原文发送。 */
  enhanceFailed?: boolean;
  model?: string;
  size?: string;
  videoSeconds?: number;
  videoResolution?: string;
  videoRatio?: string;
  videoAudio?: boolean;
  /** 开始生成的时间。 */
  startedAt?: string;
  /** 生成完成的时间。 */
  createdAt?: string;
  fileName?: string;
  /** 资产去重键：同一张图从历史、资产库或节点预览再次收藏时定位到同一条资产。 */
  assetSourceKey?: string;
}

export interface ImagePreviewItem {
  mediaType?: 'image' | 'video';
  url: string;
  title: string;
  details?: ImagePreviewDetails;
}

/** 灵枢同款大图预览：滚轮/按钮缩放、拖拽平移、点舞台在 1× 与 1.6× 间切换。 */
export default function ImagePreviewLightbox({
  item,
  playlist,
  onNavigate,
  onClose,
}: {
  item: ImagePreviewItem | null;
  /** 生成历史顺序的图列表：给了才能左右切图。 */
  playlist?: ImagePreviewItem[];
  onNavigate?: (item: ImagePreviewItem) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [copiedKey, setCopiedKey] = useState('');
  const [smoothZoom, setSmoothZoom] = useState(false);
  const [promptHeights, setPromptHeights] = useState<Record<string, number>>(readPromptHeights);
  const promptHeightsRef = useRef(promptHeights);
  promptHeightsRef.current = promptHeights;
  const [assetLibrary, setAssetLibrary] = useState<AssetLibrary>({ folders: [], items: [] });
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assetPickerPosition, setAssetPickerPosition] = useState<CSSProperties | null>(null);
  const [assetPickerLoading, setAssetPickerLoading] = useState(false);
  const [assetSavingFolderId, setAssetSavingFolderId] = useState('');
  const [assetSavedFolderId, setAssetSavedFolderId] = useState('');
  const [assetError, setAssetError] = useState('');
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; dragged: boolean; lastX: number; lastY: number } | null>(null);
  const copyTimerRef = useRef(0);
  const smoothTimerRef = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const assetButtonRef = useRef<HTMLButtonElement>(null);
  const assetPickerRef = useRef<HTMLDivElement>(null);
  const previewCloseBlockedUntilRef = useRef(0);
  const panFrameRef = useRef(0);
  const resizeRef = useRef<{ key: string; pointerId: number; startY: number; startHeight: number } | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [imgMissing, setImgMissing] = useState(false);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setSmoothZoom(false);
    setCopiedKey('');
    setNatural({ width: 0, height: 0 });
    setImgMissing(false);
    setAssetPickerOpen(false);
    setAssetPickerPosition(null);
    setAssetSavingFolderId('');
    setAssetSavedFolderId('');
    setAssetError('');
  }, [item]);

  useLayoutEffect(() => {
    if (!assetPickerOpen || !assetButtonRef.current) return undefined;
    const updatePosition = () => {
      if (!assetButtonRef.current) return;
      setAssetPickerPosition(assetPickerStyle(assetButtonRef.current));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [assetPickerOpen]);

  useEffect(() => {
    if (!assetPickerOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (assetButtonRef.current?.contains(target) || assetPickerRef.current?.contains(target)) return;
      previewCloseBlockedUntilRef.current = Date.now() + 320;
      setAssetPickerOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [assetPickerOpen]);

  // 滚轮缩放走原生非 passive 监听 + rAF 合并：React 合成事件是 passive 的，
  // 且每个 wheel 都 setState 会让长文本面板跟着重渲染，表现就是卡帧。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || item?.mediaType === 'video') return undefined;
    let frame = 0;
    let total = 0;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      total += event.deltaY;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const delta = total;
        total = 0;
        if (!delta) return;
        const notches = Math.min(3, Math.max(1, Math.round(Math.abs(delta) / 80)));
        setSmoothZoom(false);
        setZoom((current) => clampZoom(current + (delta > 0 ? -0.1 : 0.1) * notches));
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [item]);

  useEffect(() => () => {
    window.clearTimeout(copyTimerRef.current);
    window.clearTimeout(smoothTimerRef.current);
    window.cancelAnimationFrame(panFrameRef.current);
  }, []);

  /* 左右切图：闭包走 ref，避免每次渲染都重绑键盘事件 */
  const stepRef = useRef<(delta: number) => void>(() => {});
  stepRef.current = (delta: number) => {
    const list = playlist || [];
    const index = item ? list.findIndex((entry) => entry.url === item.url) : -1;
    if (!item || list.length < 2 || index < 0) return;
    const currentUrl = item.url;
    // 相邻项可能是同一张图（多画布引用 / 版本链重复），按方向跳到第一张不同的，
    // 否则"下一张"会连点几次都看着没动
    for (let step = 1; step <= list.length; step++) {
      const next = list[(((index + delta * step) % list.length) + list.length) % list.length];
      if (next.url !== currentUrl) {
        onNavigate?.(next);
        return;
      }
    }
  };

  useEffect(() => {
    if (!item) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        stepRef.current(-1);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        stepRef.current(1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (assetPickerOpen) {
          setAssetPickerOpen(false);
          assetButtonRef.current?.focus();
          return;
        }
        onClose();
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        setZoom((current) => clampZoom(current + PREVIEW_ZOOM_STEP));
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        setZoom((current) => clampZoom(current - PREVIEW_ZOOM_STEP));
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [assetPickerOpen, item, onClose]);

  if (!item) return null;

  const isVideo = item.mediaType === 'video';
  const details = item.details || {};
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const currentIndex = item ? (playlist || []).findIndex((entry) => entry.url === item.url) : -1;
  const resolvedSize = isVideo
    ? [
      natural.width && natural.height ? `${natural.width} x ${natural.height}` : details.videoResolution || details.size,
      details.videoRatio,
      details.videoSeconds ? `${details.videoSeconds}s` : '',
      details.videoAudio ? '有声' : '无声音',
    ].filter(Boolean).join(' · ') || '-'
    : natural.width && natural.height
      ? `${natural.width} x ${natural.height}`
      : details.size || '-';
  const aspectRatio = natural.width && natural.height
    ? formatAspectRatio(natural.width / natural.height)
    : '-';
  const generatedAt = formatPreviewTime(details.createdAt);
  const elapsed = formatElapsed(details.startedAt, details.createdAt);
  const assetFileName = String(details.fileName || '').trim();
  const savedAssetFolderName = assetLibrary.folders.find((folder) => folder.id === assetSavedFolderId)?.name || '';

  const toggleAssetPicker = async () => {
    if (assetPickerOpen) {
      setAssetPickerOpen(false);
      return;
    }
    setAssetPickerOpen(true);
    setAssetError('');
    setAssetPickerLoading(true);
    try {
      setAssetLibrary(await getAssets());
    } catch (reason) {
      setAssetError(reason instanceof Error ? reason.message : '读取资产文件夹失败');
    } finally {
      setAssetPickerLoading(false);
    }
  };

  const saveImageToAsset = async (folderId: string) => {
    if (isVideo || !assetFileName) return;
    setAssetSavingFolderId(folderId);
    setAssetError('');
    try {
      const asset = await createAsset({
        folderId,
        fileName: assetFileName,
        prompt: String(details.prompt || item.title || ''),
        model: String(details.model || ''),
        size: String(details.size || ''),
        sourceKey: String(details.assetSourceKey || assetFileName),
      });
      // bridge 按 sourceKey 去重时只返回原资产，不会自动换文件夹。
      if (asset.folderId !== folderId) await moveAssetToFolder(asset.id, folderId);
      setAssetSavedFolderId(folderId);
      setAssetPickerOpen(false);
    } catch (reason) {
      setAssetError(reason instanceof Error ? reason.message : '添加到资产库失败');
    } finally {
      setAssetSavingFolderId('');
    }
  };

  const markSmoothZoom = () => {
    setSmoothZoom(true);
    window.clearTimeout(smoothTimerRef.current);
    smoothTimerRef.current = window.setTimeout(() => setSmoothZoom(false), 220);
  };

  const zoomBy = (delta: number) => {
    setSmoothZoom(false);
    setZoom((current) => clampZoom(current + delta));
    if (delta < 0) setPan({ x: 0, y: 0 });
  };

  const copyText = async (text: string, key: string) => {
    if (!text) return;
    try {
      await navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopiedKey(''), 1400);
    } catch {
      setCopiedKey('');
    }
  };

  const openLocalFile = () => {
    const fileName = String(details.fileName || '').trim();
    if (!fileName) return;
    void revealLocalFile(fileName).catch(() => undefined);
  };

  const downloadMedia = () => {
    const link = document.createElement('a');
    link.href = item.url;
    link.download = String(details.fileName || (isVideo ? 'video.mp4' : 'image.png'));
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const handleStageClick = () => {
    if (dragRef.current?.dragged) return;
    markSmoothZoom();
    setZoom((current) => (current < 1 ? 1 : current === 1 ? 1.6 : 1));
    setPan({ x: 0, y: 0 });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
      dragged: false,
      lastX: pan.x,
      lastY: pan.y,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.dragged = Math.abs(dx) + Math.abs(dy) > 4;
    drag.lastX = drag.originX + dx;
    drag.lastY = drag.originY + dy;
    // 拖拽按帧合并：每个 pointermove 都 setState 会跟着重渲染长文本面板
    if (panFrameRef.current) return;
    panFrameRef.current = window.requestAnimationFrame(() => {
      panFrameRef.current = 0;
      const current = dragRef.current;
      if (current) setPan({ x: current.lastX, y: current.lastY });
    });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    window.cancelAnimationFrame(panFrameRef.current);
    panFrameRef.current = 0;
    setPan({ x: drag.lastX, y: drag.lastY });
    window.setTimeout(() => {
      dragRef.current = null;
    }, 0);
  };

  const persistPromptHeights = () => {
    try {
      localStorage.setItem(PREVIEW_PROMPT_HEIGHTS_KEY, JSON.stringify(promptHeightsRef.current));
    } catch {
      /* 隐私模式写不进去不影响当前拖拽 */
    }
  };

  const startPromptResize = (event: ReactPointerEvent<HTMLSpanElement>, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = event.currentTarget.closest('.image-generation-preview-prompt') as HTMLElement | null;
    const startHeight = panel?.getBoundingClientRect().height || promptHeightsRef.current[key] || DEFAULT_PROMPT_HEIGHT;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { key, pointerId: event.pointerId, startY: event.clientY, startHeight };
  };

  const movePromptResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = clampPromptHeight(resize.startHeight + event.clientY - resize.startY);
    setPromptHeights((current) => ({ ...current, [resize.key]: next }));
  };

  const endPromptResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    persistPromptHeights();
  };

  const nudgePromptHeight = (key: string, delta: number, reset = false) => {
    const next = {
      ...promptHeightsRef.current,
      [key]: reset ? DEFAULT_PROMPT_HEIGHT : clampPromptHeight((promptHeightsRef.current[key] || DEFAULT_PROMPT_HEIGHT) + delta),
    };
    promptHeightsRef.current = next;
    setPromptHeights(next);
    persistPromptHeights();
  };

  return createPortal(
    <div
      className="image-generation-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? '生成视频预览' : '生成图片预览'}
      onClick={() => {
        if (Date.now() < previewCloseBlockedUntilRef.current) return;
        onClose();
      }}
    >
      <section className="image-generation-preview" onClick={(event) => event.stopPropagation()}>
        <main className="image-generation-preview-main">
          <div
            ref={stageRef}
            className={`image-generation-preview-stage${isVideo ? ' is-video' : ''}`}
            onClick={isVideo ? undefined : handleStageClick}
            onPointerDown={isVideo ? undefined : handlePointerDown}
            onPointerMove={isVideo ? undefined : handlePointerMove}
            onPointerUp={isVideo ? undefined : handlePointerUp}
            onPointerCancel={isVideo ? undefined : handlePointerUp}
          >
            {imgMissing ? (
              <div className="image-generation-preview-missing" role="img" aria-label={`${isVideo ? '视频' : '图片'}文件丢失`}>
                <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
                  <rect x="6" y="10" width="36" height="28" rx="4" />
                  <circle cx="17" cy="19" r="2.6" />
                  <path d="M7 33 16 24l7 7 6-6 12 12" />
                  <path d="M8 40 40 8" />
                </svg>
                <p className="image-generation-preview-missing-text">{isVideo ? '视频文件丢失' : '图片文件丢失'}</p>
                {item.details?.fileName ? <p className="image-generation-preview-missing-note">{item.details.fileName}</p> : null}
              </div>
            ) : isVideo ? (
              <video
                src={item.url}
                controls
                playsInline
                preload="auto"
                onError={() => setImgMissing(true)}
                onLoadedMetadata={(event) => setNatural({
                  width: event.currentTarget.videoWidth,
                  height: event.currentTarget.videoHeight,
                })}
              />
            ) : (
              <img
                src={item.url}
                alt={item.title}
                className={smoothZoom ? 'is-smooth-zoom' : undefined}
                draggable={false}
                loading="eager"
                decoding="async"
                fetchPriority="high"
                onLoad={(event) => setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })}
                onError={() => setImgMissing(true)}
                style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}
              />
            )}
            {(playlist || []).length > 1 && item && (playlist || []).some((entry) => entry.url === item.url) ? (
              <>
                <button
                  type="button"
                  className="image-generation-preview-nav is-prev"
                  aria-label="上一张"
                  title="上一张（←）"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    stepRef.current(-1);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
                </button>
                <button
                  type="button"
                  className="image-generation-preview-nav is-next"
                  aria-label="下一张"
                  title="下一张（→）"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    stepRef.current(1);
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 5.5 16 12l-6.5 6.5" /></svg>
                </button>
              </>
            ) : null}
            {!isVideo ? <span className="image-generation-preview-hint">
              滚轮缩放 · 拖拽平移 · 点击切换 1× / 1.6×
              {currentIndex >= 0 && (playlist || []).length > 1 ? ` · ${currentIndex + 1}/${(playlist || []).length}` : ''}
            </span> : null}
            {!isVideo ? <div className="image-generation-preview-zoom" role="group" aria-label="缩放控制">
              <button
                type="button"
                aria-label="缩小"
                title="缩小"
                disabled={zoom <= MIN_PREVIEW_ZOOM}
                onClick={(event) => {
                  event.stopPropagation();
                  zoomBy(-PREVIEW_ZOOM_STEP);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
              </button>
              <span className="image-generation-preview-zoom-value">{zoomLabel}</span>
              <button
                type="button"
                aria-label="放大"
                title="放大"
                disabled={zoom >= MAX_PREVIEW_ZOOM}
                onClick={(event) => {
                  event.stopPropagation();
                  zoomBy(PREVIEW_ZOOM_STEP);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <button
                type="button"
                aria-label="复位"
                title="复位"
                disabled={zoom === 1 && pan.x === 0 && pan.y === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  markSmoothZoom();
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></svg>
              </button>
            </div> : null}
          </div>
        </main>
        {/* 关闭按钮提到预览层右上角（灵枢同款）：不再挤占右侧信息栏首行 */}
        <button className="image-generation-preview-close" type="button" onClick={onClose} aria-label={`关闭${isVideo ? '视频' : '图片'}预览`}>×</button>
        <aside className="image-generation-preview-side">
          {[
            { key: 'prompt', label: '提示词', text: details.prompt || item.title || '' },
            { key: 'enhanced', label: '优化后提示词', text: details.enhancedPrompt || '' },
            // 模型润色后（revised_prompt）与实际发送相同就纯属噪音：多数中转站只是原样回显，不展示
            {
              key: 'revised',
              label: '模型润色后',
              text: details.revisedPrompt && details.revisedPrompt.trim() !== (details.enhancedPrompt || details.prompt || item.title || '').trim()
                ? details.revisedPrompt
                : '',
            },
          ].filter((panel) => panel.text).map((panel) => (
            <div
              key={panel.key}
              className={`image-generation-preview-panel image-generation-preview-prompt is-${panel.key}`}
              style={{ height: `${promptHeights[panel.key] || DEFAULT_PROMPT_HEIGHT}px` }}
            >
              <span>{panel.label}</span>
              <button
                type="button"
                className={copiedKey === panel.key ? 'copied' : ''}
                onClick={() => void copyText(panel.text, panel.key)}
                aria-label={`复制${panel.label}`}
                title={copiedKey === panel.key ? '已复制' : `复制${panel.label}`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="2" /><path d="M6 14H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" /></svg>
                <span>{copiedKey === panel.key ? '已复制' : '复制'}</span>
              </button>
              <p>{panel.text}</p>
              <span
                className="image-generation-preview-prompt-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`调整${panel.label}高度`}
                title="拖拽调整高度（↑/↓ 微调，双击复位）"
                tabIndex={0}
                onPointerDown={(event) => startPromptResize(event, panel.key)}
                onPointerMove={movePromptResize}
                onPointerUp={endPromptResize}
                onPointerCancel={endPromptResize}
                onDoubleClick={() => nudgePromptHeight(panel.key, 0, true)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  nudgePromptHeight(panel.key, event.key === 'ArrowUp' ? -16 : 16);
                }}
              />
            </div>
          ))}
          <div className="image-generation-preview-panel image-generation-preview-info">
            <span>生成信息</span>
            <dl>
              <div><dt>模型</dt><dd title={details.model}>{details.model || '-'}</dd></div>
              <div><dt>{isVideo ? '规格' : '尺寸'}</dt><dd title={resolvedSize}>{resolvedSize}{!isVideo && aspectRatio !== '-' ? ` · ${aspectRatio}` : ''}</dd></div>
              {details.enhanceFailed ? <div><dt>优化</dt><dd title="语言模型优化失败，已按原文发送">失败 · 用原文</dd></div> : null}
              {!details.enhanceFailed && details.enhancedPrompt ? <div><dt>优化</dt><dd title="提示词已经语言模型整理后发送">已整理</dd></div> : null}
              <div><dt>用时</dt><dd>{elapsed}</dd></div>
              <div><dt>生成时间</dt><dd>{generatedAt}</dd></div>
              <div><dt>文件</dt><dd title={details.fileName}>{details.fileName || '-'}</dd></div>
            </dl>
            {!isVideo ? (
              <div className="image-generation-preview-asset">
                <button
                  ref={assetButtonRef}
                  type="button"
                  className={`image-generation-preview-asset-add${savedAssetFolderName ? ' is-saved' : ''}`}
                  onClick={() => void toggleAssetPicker()}
                  disabled={!assetFileName || Boolean(assetSavingFolderId)}
                  aria-expanded={assetPickerOpen}
                  aria-controls="image-preview-asset-folders"
                  title={!assetFileName
                    ? '没有可复制的本地图片文件'
                    : savedAssetFolderName
                      ? `已收藏到「${savedAssetFolderName}」，点击切换文件夹`
                      : '选择文件夹并添加到资产库'}
                >
                  <AssetGlyphIcon />
                  <span>{savedAssetFolderName || '添加到资产库'}</span>
                  <ChevronDownIcon />
                </button>
              </div>
            ) : null}
            {assetPickerOpen && assetPickerPosition ? createPortal(
              <div
                ref={assetPickerRef}
                className="image-generation-preview-asset-picker"
                id="image-preview-asset-folders"
                style={assetPickerPosition}
                role="group"
                aria-label="选择资产文件夹"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <span className="image-generation-preview-asset-picker-title">选择文件夹</span>
                {assetPickerLoading ? (
                  <p className="image-generation-preview-asset-picker-note">正在读取文件夹…</p>
                ) : null}
                {!assetPickerLoading && assetLibrary.folders.length === 0 ? (
                  <p className="image-generation-preview-asset-picker-note">还没有资产文件夹</p>
                ) : null}
                {!assetPickerLoading ? assetLibrary.folders.map((folder) => {
                  const count = assetLibrary.items.filter((asset) => asset.folderId === folder.id).length;
                  const saving = assetSavingFolderId === folder.id;
                  return (
                    <button
                      type="button"
                      key={folder.id}
                      className="image-generation-preview-asset-folder"
                      disabled={Boolean(assetSavingFolderId)}
                      onClick={() => void saveImageToAsset(folder.id)}
                    >
                      <FolderIcon />
                      <span>{folder.name}</span>
                      <span className="image-generation-preview-asset-count">
                        {saving ? '保存中…' : count}
                      </span>
                    </button>
                  );
                }) : null}
                {assetError ? (
                  <p className="image-generation-preview-asset-error" role="alert">{assetError}</p>
                ) : null}
              </div>,
              document.body,
            ) : null}
          </div>
          <div className="image-generation-preview-actions">
            <button type="button" onClick={downloadMedia}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14" /></svg>
              {isVideo ? '下载视频' : '下载图片'}
            </button>
            <button type="button" onClick={() => window.open(item.url, '_blank', 'noopener,noreferrer')}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5" /></svg>
              新窗口打开
            </button>
            {details.fileName ? (
              <button type="button" onClick={openLocalFile} title={`在 Finder / 资源管理器里定位这个${isVideo ? '视频' : '图片'}`}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" /></svg>
                打开本地文件
              </button>
            ) : null}
          </div>
        </aside>
      </section>
    </div>,
    document.body,
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l1.8 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9.5 5 5 5-5" />
    </svg>
  );
}

function assetPickerStyle(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const margin = 12;
  const gap = 6;
  const width = Math.min(Math.max(rect.width, 204), viewportWidth - margin * 2);
  const left = Math.min(Math.max(margin, rect.left), viewportWidth - margin - width);
  const spaceBelow = viewportHeight - rect.bottom - margin - gap;
  const spaceAbove = rect.top - margin - gap;
  const openAbove = spaceBelow < 210 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(112, Math.min(240, openAbove ? spaceAbove : spaceBelow));
  return {
    left,
    width,
    maxHeight,
    ...(openAbove
      ? { bottom: viewportHeight - rect.top + gap }
      : { top: rect.bottom + gap }),
  };
}

function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, Math.round(value * 100) / 100));
}

function formatPreviewTime(value?: string) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatElapsed(startedAt?: string, finishedAt?: string) {
  if (!startedAt || !finishedAt) return '-';
  const elapsed = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return '-';
  const totalSeconds = Math.round(elapsed / 1000);
  return totalSeconds >= 60 ? `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒` : `${totalSeconds}秒`;
}

function formatAspectRatio(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const presets: Array<[number, string]> = [[16 / 9, '16:9'], [9 / 16, '9:16'], [3 / 2, '3:2'], [2 / 3, '2:3'], [1, '1:1']];
  const nearest = presets.reduce((best, current) => (Math.abs(value - current[0]) < Math.abs(value - best[0]) ? current : best));
  return Math.abs(value - nearest[0]) < 0.035 ? nearest[1] : `${value.toFixed(2)}:1`;
}
