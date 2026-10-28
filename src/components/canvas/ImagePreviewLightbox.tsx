import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { postPreferenceAction, revealLocalFile } from '@/lib/bridge';
import { useSettingsStore } from '@/stores/settingsStore';
import './ImagePreviewLightbox.css';

const MIN_PREVIEW_ZOOM = 0.5;
const MAX_PREVIEW_ZOOM = 4;
const PREVIEW_ZOOM_STEP = 0.25;

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
  /** 「喜欢」：把这条提示词收进偏好档案；再点一次取消（线框 → 实心红心） */
  const [liked, setLiked] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; dragged: boolean } | null>(null);
  const copyTimerRef = useRef(0);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [imgMissing, setImgMissing] = useState(false);
  const likedIdRef = useRef('');

  /** 喜欢 / 取消喜欢：手动条目写进偏好档案，取消时按 id 精确移除。 */
  const toggleLike = async () => {
    const text = String(details?.prompt || item?.title || '').trim();
    if (!text) return;
    try {
      if (liked) {
        if (likedIdRef.current) await postPreferenceAction('remove', { id: likedIdRef.current });
        likedIdRef.current = '';
        setLiked(false);
        void useSettingsStore.getState().load();
        return;
      }
      const profile = await postPreferenceAction('add', {
        prompt: text,
        model: String(details?.model || ''),
        size: String(details?.size || ''),
      });
      // 重复喜欢同一条时 bridge 会去重，这里按文本把已存在的那条 id 找回来，取消时才删得掉
      const entry = profile.entries.find((item) => item.text === text.slice(0, 120) && item.source === 'manual');
      likedIdRef.current = entry?.id || '';
      setLiked(true);
      void useSettingsStore.getState().load();
    } catch {
      /* 失败不打断看图：心保持原样，用户可再点一次 */
    }
  };

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setCopiedKey('');
    setNatural({ width: 0, height: 0 });
    setImgMissing(false);
    // 换图重置喜欢态：档案里已有同文本的手动条目时，心直接是实的
    const text = String(item?.details?.prompt || item?.title || '').trim();
    const existing = useSettingsStore.getState().settings?.preferences.entries
      .find((entry) => entry.text === text.slice(0, 120) && entry.source === 'manual');
    likedIdRef.current = existing?.id || '';
    setLiked(Boolean(existing));
  }, [item]);

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
  }, [item, onClose]);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

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

  const zoomBy = (delta: number) => {
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
    setZoom((current) => (current < 1 ? 1 : current === 1 ? 1.6 : 1));
    setPan({ x: 0, y: 0 });
  };

  const handleStageWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((current) => clampZoom(current + (event.deltaY > 0 ? -PREVIEW_ZOOM_STEP : PREVIEW_ZOOM_STEP)));
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
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.dragged = Math.abs(dx) + Math.abs(dy) > 4;
    setPan({ x: drag.originX + dx, y: drag.originY + dy });
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      window.setTimeout(() => {
        dragRef.current = null;
      }, 0);
    }
  };

  return createPortal(
    <div
      className="image-generation-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? '生成视频预览' : '生成图片预览'}
      onClick={onClose}
    >
      <section className="image-generation-preview" onClick={(event) => event.stopPropagation()}>
        <main className="image-generation-preview-main">
          <div
            className={`image-generation-preview-stage${isVideo ? ' is-video' : ''}`}
            onClick={isVideo ? undefined : handleStageClick}
            onWheel={isVideo ? undefined : handleStageWheel}
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
            {/* 喜欢：手动沉淀偏好，线框 → 实心红心，再点一次取消 */}
            <button
              type="button"
              className={`image-generation-preview-like ${liked ? 'is-liked' : ''}`}
              onClick={() => void toggleLike()}
              disabled={!String(details.prompt || item.title || '').trim()}
              aria-pressed={liked}
              title={liked
                ? '已喜欢：这条提示词在偏好档案里，优化时会作为长期偏好参考。再点一次取消'
                : '喜欢：把这条提示词收进偏好档案，之后优化提示词时作为长期偏好参考'}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 20.2s-7.4-4.5-7.4-9.3a4.1 4.1 0 0 1 7.4-2.4 4.1 4.1 0 0 1 7.4 2.4c0 4.8-7.4 9.3-7.4 9.3Z" strokeLinejoin="round" />
              </svg>
              <span>{liked ? '已喜欢' : '喜欢'}</span>
            </button>
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
