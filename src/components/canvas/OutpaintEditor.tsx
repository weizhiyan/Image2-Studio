import { useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { RESOLUTION_OPTIONS, type ResolutionLabel, pickSizeForResolution, ratioToNumber } from '@/lib/aspect';
import type { ImageModelOption } from '@/lib/imageModelOptions';
import {
  buildOutpaintPrompt,
  centerOutpaintImageForAspect,
  initialOutpaintFrame,
  normalizeOutpaintTargetAspect,
} from '@/lib/outpaint';
import { CloseGlyphIcon, SendGlyphIcon } from '@/components/chat/ChatIcons';
import './OutpaintEditor.css';

const RATIO_OPTIONS = ['原图比例', '1:1', '4:3', '3:4', '16:9', '9:16', '21:9', '自定义…'] as const;
type RatioOption = (typeof RATIO_OPTIONS)[number] | '自定义';
type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ImageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OutpaintResult {
  dataUrl: string;
  prompt: string;
  ratio: string;
  size: string;
  resolution: ResolutionLabel;
  model: string;
  profileId: string;
  imagePosition: { x: number; y: number; width: number; height: number };
  frame: { width: number; height: number };
}

type Gesture = {
  kind: 'move-image' | 'resize-image' | 'resize-frame';
  handle?: ResizeHandle;
  pointerX: number;
  pointerY: number;
  zoom: number;
  frame: Rect;
  image: ImageRect;
};

export default function OutpaintEditor({
  imageUrl,
  imageWidth,
  imageHeight,
  displayWidth,
  displayHeight,
  position,
  model,
  profileId,
  modelOptions,
  onCancel,
  onSubmit,
}: {
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  displayWidth: number;
  displayHeight: number;
  position: { x: number; y: number };
  model: string;
  profileId?: string;
  modelOptions: ImageModelOption[];
  onCancel: () => void;
  onSubmit: (result: OutpaintResult) => Promise<void>;
}) {
  const viewport = useViewport();
  const flow = useReactFlow();
  const imageRef = useRef<HTMLImageElement>(null);
  const ratioTriggerRef = useRef<HTMLButtonElement>(null);
  const ratioMenuRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLButtonElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const customWidthRef = useRef<HTMLInputElement>(null);
  const customHeightRef = useRef<HTMLInputElement>(null);
  const initialFrame = initialOutpaintFrame({ width: displayWidth, height: displayHeight });
  const frameRef = useRef<Rect>({
    left: position.x,
    top: position.y,
    width: initialFrame.width,
    height: initialFrame.height,
  });
  const imageRectRef = useRef<ImageRect>({
    x: position.x,
    y: position.y,
    width: displayWidth,
    height: displayHeight,
  });
  const gestureRef = useRef<Gesture | null>(null);
  const [frame, setFrame] = useState(frameRef.current);
  const [imageRect, setImageRect] = useState(imageRectRef.current);
  const [ratio, setRatio] = useState<RatioOption>('原图比例');
  const [ratioMenuOpen, setRatioMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModelKey, setSelectedModelKey] = useState(() => {
    const exact = modelOptions.find((option) => option.model === model && option.profileId === profileId);
    return exact?.key || modelOptions.find((option) => option.model === model)?.key || modelOptions[0]?.key || '';
  });
  const [resolution, setResolution] = useState<ResolutionLabel>('2K');
  const [customRatioEditing, setCustomRatioEditing] = useState(false);
  const [customRatioText, setCustomRatioText] = useState('');
  const [customWidth, setCustomWidth] = useState('');
  const [customHeight, setCustomHeight] = useState('');
  const [customRatioError, setCustomRatioError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [naturalSize, setNaturalSize] = useState({ width: Number(imageWidth || 0), height: Number(imageHeight || 0) });
  const [canvasWidth, setCanvasWidth] = useState(0);

  useEffect(() => {
    if (modelOptions.length === 0) return;
    setSelectedModelKey((current) => {
      if (current && modelOptions.some((option) => option.key === current)) return current;
      const exact = modelOptions.find((option) => option.model === model && option.profileId === profileId);
      return exact?.key || modelOptions.find((option) => option.model === model)?.key || modelOptions[0].key;
    });
  }, [model, modelOptions, profileId]);

  useEffect(() => {
    const wrap = document.querySelector('.hb-canvas-wrap') as HTMLElement | null;
    const sync = () => setCanvasWidth(wrap?.clientWidth || window.innerWidth);
    sync();
    const observer = wrap && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(sync)
      : null;
    if (observer && wrap) observer.observe(wrap);
    window.addEventListener('resize', sync);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, []);

  const updateFrame = (next: Rect) => {
    frameRef.current = next;
    setFrame(next);
  };

  const updateImage = (next: ImageRect) => {
    imageRectRef.current = next;
    setImageRect(next);
  };

  const revealFrame = (next: Rect) => {
    const wrap = document.querySelector('.hb-canvas-wrap') as HTMLElement | null;
    if (!wrap) return;
    const bounds = wrap.getBoundingClientRect();
    const zoom = Math.max(viewport.zoom, 0.01);
    const margin = 16;
    const controlsSpace = (76 + 20) * zoom;
    const left = viewport.x + next.left * zoom;
    const top = viewport.y + next.top * zoom;
    const width = next.width * zoom;
    const height = next.height * zoom;
    const minTop = 56;
    const safeBottom = bounds.height - margin;
    const dx = bounds.width / 2 - (left + width / 2);
    const targetTop = (bounds.height - height) / 2;
    const maxTop = safeBottom - height - controlsSpace;
    const nextTop = maxTop >= minTop
      ? Math.min(Math.max(targetTop, minTop), maxTop)
      : minTop;
    const dy = nextTop - top;
    if (!dx && !dy) return;
    void flow.setViewport(
      { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom },
      { duration: 160 },
    );
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (ratioMenuOpen) {
        setRatioMenuOpen(false);
        return;
      }
      if (modelMenuOpen) {
        setModelMenuOpen(false);
        return;
      }
      if (!submitting) onCancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [modelMenuOpen, onCancel, ratioMenuOpen, submitting]);

  useEffect(() => {
    if (!ratioMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ratioMenuRef.current?.contains(target) || ratioTriggerRef.current?.contains(target))) return;
      setRatioMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [ratioMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (modelMenuRef.current?.contains(target) || modelTriggerRef.current?.contains(target))) return;
      setModelMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [modelMenuOpen]);

  useEffect(() => {
    if (customRatioEditing) customWidthRef.current?.focus();
  }, [customRatioEditing]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      const dx = (event.clientX - gesture.pointerX) / gesture.zoom;
      const dy = (event.clientY - gesture.pointerY) / gesture.zoom;
      if (gesture.kind === 'move-image') {
        const nextX = Math.max(gesture.frame.left, Math.min(
          gesture.frame.left + gesture.frame.width - gesture.image.width,
          gesture.image.x + dx,
        ));
        const nextY = Math.max(gesture.frame.top, Math.min(
          gesture.frame.top + gesture.frame.height - gesture.image.height,
          gesture.image.y + dy,
        ));
        updateImage({ ...gesture.image, x: nextX, y: nextY });
        return;
      }
      if (gesture.kind === 'resize-image') {
        const aspect = gesture.image.width / gesture.image.height;
        const requestedWidth = Math.max(64, gesture.image.width + dx + dy * aspect);
        const maxWidth = Math.min(
          gesture.frame.left + gesture.frame.width - gesture.image.x,
          (gesture.frame.top + gesture.frame.height - gesture.image.y) * aspect,
        );
        const width = Math.min(requestedWidth, maxWidth);
        updateImage({ ...gesture.image, width, height: width / aspect });
        return;
      }

      const original = gesture.frame;
      const image = gesture.image;
      const imageRight = image.x + image.width;
      const imageBottom = image.y + image.height;
      const handle = gesture.handle || 'se';
      let left = original.left;
      let top = original.top;
      let right = original.left + original.width;
      let bottom = original.top + original.height;
      if (handle.includes('e')) right = Math.max(imageRight, original.left + original.width + dx);
      if (handle.includes('s')) bottom = Math.max(imageBottom, original.top + original.height + dy);
      if (handle.includes('w')) left = Math.min(image.x, original.left + dx);
      if (handle.includes('n')) top = Math.min(image.y, original.top + dy);
      if (right - left < 160) right = left + 160;
      if (bottom - top < 120) bottom = top + 120;
      updateFrame({ left, top, width: right - left, height: bottom - top });
      setRatio('自定义');
    };
    const onUp = () => { gestureRef.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const setPreset = (nextRatio: RatioOption) => {
    if (nextRatio === '自定义…') {
      setCustomRatioEditing(true);
      setCustomRatioError('');
      return;
    }
    setCustomRatioEditing(false);
    setCustomRatioText('');
    setCustomRatioError('');
    setRatio(nextRatio);
    const aspect = nextRatio === '原图比例'
      ? imageRectRef.current.width / imageRectRef.current.height
      : 1 / ratioToNumber(nextRatio);
    applyAspect(aspect);
    setRatioMenuOpen(false);
  };

  const beginGesture = (event: ReactPointerEvent, kind: Gesture['kind'], handle?: ResizeHandle) => {
    if (submitting) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = {
      kind,
      handle,
      pointerX: event.clientX,
      pointerY: event.clientY,
      zoom: Math.max(viewport.zoom, 0.01),
      frame: { ...frameRef.current },
      image: { ...imageRectRef.current },
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const applyAspect = (aspect: number) => {
    const next = centerOutpaintImageForAspect(imageRectRef.current, aspect);
    updateFrame(next.frame);
    updateImage(next.image);
    revealFrame(next.frame);
  };

  const applyCustomRatio = () => {
    const width = Number.parseInt(customWidth.trim(), 10);
    const height = Number.parseInt(customHeight.trim(), 10);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      setCustomRatioError('请输入两个正整数');
      return;
    }
    if (width > 10000 || height > 10000) {
      setCustomRatioError('每个数值不能超过 10000');
      return;
    }
    setCustomRatioError('');
    setCustomRatioText(`${width}:${height}`);
    setRatio('自定义');
    setCustomRatioEditing(false);
    setRatioMenuOpen(false);
    applyAspect(width / height);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || !naturalSize.width || !naturalSize.height) return;
    setSubmitting(true);
    setError('');
    try {
      const currentFrame = frameRef.current;
      const currentImage = imageRectRef.current;
      const finalRatio = ratio === '原图比例'
        ? `${naturalSize.width}:${naturalSize.height}`
        : ratio === '自定义'
          ? customRatioText || `${Math.round(currentFrame.width)}:${Math.round(currentFrame.height)}`
          : ratio;
      const size = pickSizeForResolution(currentFrame.height / currentFrame.width, resolution);
      const [width, height] = size.split('x').map(Number);
      const target = normalizeOutpaintTargetAspect(currentFrame, currentImage, width / height);
      const targetFrame = target.frame;
      const imagePosition = target.imagePosition;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context || !imageRef.current) throw new Error('浏览器无法创建扩图画布');
      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        imageRef.current,
        imagePosition.x / targetFrame.width * width,
        imagePosition.y / targetFrame.height * height,
        imagePosition.width / targetFrame.width * width,
        imagePosition.height / targetFrame.height * height,
      );
      const prompt = buildOutpaintPrompt({
        ratio: finalRatio,
        imagePosition,
        frame: { width: targetFrame.width, height: targetFrame.height },
        instruction,
      });
      const selectedModel = modelOptions.find((option) => option.key === selectedModelKey);
      await onSubmit({
        dataUrl: canvas.toDataURL('image/png'),
        prompt,
        ratio: finalRatio,
        size,
        resolution,
        model: selectedModel?.model || model,
        profileId: selectedModel?.profileId || profileId || '',
        imagePosition,
        frame: { width: targetFrame.width, height: targetFrame.height },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '扩图提交失败');
      setSubmitting(false);
    }
  };

  const availableControlsWidth = Math.max(280, Math.min(720, (canvasWidth || window.innerWidth) - 32));
  const controlsWidth = availableControlsWidth / Math.max(viewport.zoom, 0.01);
  const controlsLeft = frame.left + (frame.width - controlsWidth) / 2;
  const controlsHeight = 76;
  const controlsBelow = frame.top + frame.height + 20;
  const controlsAbove = frame.top - controlsHeight - 20;
  const controlsTop = viewport.y + (controlsBelow + controlsHeight) * viewport.zoom <= window.innerHeight - 12
    ? controlsBelow
    : viewport.y + controlsAbove * viewport.zoom >= 56
      ? controlsAbove
      : controlsBelow;
  const ratioLabel = ratio === '原图比例'
    ? '原图比例'
    : ratio === '自定义'
      ? customRatioText || '自定义…'
      : ratio;
  const selectedModel = modelOptions.find((option) => option.key === selectedModelKey);
  const modelLabel = selectedModel?.model || model || '选择模型';
  const customRatioActive = ratio === '自定义' || customRatioEditing;

  return (
    <div className="hb-outpaint-editor" aria-label="扩图编辑器" aria-busy={submitting}>
      <div
        className="hb-outpaint-frame"
        style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
      >
        <>
          <img
            ref={imageRef}
            className="hb-outpaint-image"
            src={imageUrl}
            alt="扩图基准图"
            draggable={false}
            style={{
              left: imageRect.x - frame.left,
              top: imageRect.y - frame.top,
              width: imageRect.width,
              height: imageRect.height,
              visibility: naturalSize.width && naturalSize.height ? 'visible' : 'hidden',
            }}
            onLoad={(event) => setNaturalSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })}
            onError={() => setError('原图读取失败，无法扩图')}
            onPointerDown={(event) => beginGesture(event, 'move-image')}
          />
          {naturalSize.width && naturalSize.height ? (
            <>
            <button
              type="button"
              className="hb-outpaint-image-resize"
              aria-label="调整原图大小"
              title="拖动调整原图大小"
              style={{ left: imageRect.x - frame.left + imageRect.width - 6, top: imageRect.y - frame.top + imageRect.height - 6 }}
              onPointerDown={(event) => beginGesture(event, 'resize-image')}
            />
            {(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as ResizeHandle[]).map((handle) => (
              <button
                type="button"
                key={handle}
                className={`hb-outpaint-frame-handle is-${handle}`}
                aria-label="调整扩图范围"
                title="拖动调整扩图范围"
                onPointerDown={(event) => beginGesture(event, 'resize-frame', handle)}
              />
            ))}
            </>
          ) : <span className="hb-outpaint-loading">{error || '正在读取图片…'}</span>}
        </>
      </div>
      <form
        className="hb-outpaint-controls"
        style={{ left: controlsLeft, top: controlsTop, width: controlsWidth }}
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <div className="hb-outpaint-composer">
          <button type="button" className="hb-outpaint-close" aria-label="退出扩图" title="退出扩图（Esc）" disabled={submitting} onClick={onCancel}>
            <CloseGlyphIcon />
          </button>
          <div className="hb-outpaint-model-control">
            <button
              ref={modelTriggerRef}
              type="button"
              className={`hb-outpaint-model-trigger${modelMenuOpen ? ' is-open' : ''}`}
              aria-label={`扩图模型：${modelLabel}`}
              aria-haspopup="menu"
              aria-expanded={modelMenuOpen}
              title={modelLabel}
              disabled={submitting || modelOptions.length === 0}
              onClick={() => {
                setModelMenuOpen((open) => !open);
                setRatioMenuOpen(false);
              }}
            >
              <span>{modelLabel}</span>
            </button>
            {modelMenuOpen ? (
              <div ref={modelMenuRef} className="hb-outpaint-model-menu" role="menu" aria-label="选择扩图模型">
                {modelOptions.map((option) => (
                  <button
                    type="button"
                    key={option.key}
                    role="menuitemradio"
                    aria-checked={option.key === selectedModelKey}
                    className={option.key === selectedModelKey ? 'is-active' : ''}
                    disabled={submitting}
                    onClick={() => {
                      setSelectedModelKey(option.key);
                      setModelMenuOpen(false);
                    }}
                  >
                    <strong>{option.model}</strong>
                    <small>{option.profileName}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="hb-outpaint-ratio-control">
            <button
              ref={ratioTriggerRef}
              type="button"
              className={`hb-outpaint-ratio-trigger${ratioMenuOpen ? ' is-open' : ''}`}
              aria-label={`扩图比例：${ratioLabel}`}
              aria-haspopup="menu"
              aria-expanded={ratioMenuOpen}
              disabled={submitting}
              onClick={() => {
                setRatioMenuOpen((open) => !open);
                setModelMenuOpen(false);
              }}
            >
              <span>{ratioLabel}</span>
            </button>
            {ratioMenuOpen ? (
              <div ref={ratioMenuRef} className="hb-outpaint-ratio-menu" role="menu" aria-label="选择扩图比例">
                {RATIO_OPTIONS.map((item) => (
                  <button
                    type="button"
                    key={item}
                    role="menuitemradio"
                    aria-checked={item === '自定义…' ? customRatioActive : ratio === item}
                    className={`${item === '自定义…' ? 'is-custom' : ''}${(item === '自定义…' ? customRatioActive : ratio === item) ? ' is-active' : ''}`}
                    disabled={submitting}
                    onClick={() => setPreset(item)}
                  >
                    {item}
                  </button>
                ))}
                {customRatioEditing ? (
                  <div className="hb-outpaint-ratio-custom" onPointerDown={(event) => event.stopPropagation()}>
                    <div className="hb-outpaint-ratio-custom-fields">
                      <input
                        ref={customWidthRef}
                        type="text"
                        inputMode="numeric"
                        aria-label="自定义比例宽度"
                        placeholder="宽"
                        value={customWidth}
                        onChange={(event) => {
                          setCustomWidth(event.target.value);
                          setCustomRatioError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          customHeightRef.current?.focus();
                        }}
                      />
                      <span aria-hidden="true">:</span>
                      <input
                        ref={customHeightRef}
                        type="text"
                        inputMode="numeric"
                        aria-label="自定义比例高度"
                        placeholder="高"
                        value={customHeight}
                        onChange={(event) => {
                          setCustomHeight(event.target.value);
                          setCustomRatioError('');
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          applyCustomRatio();
                        }}
                      />
                      <button type="button" className="hb-outpaint-ratio-apply" onClick={applyCustomRatio}>
                        应用
                      </button>
                    </div>
                    {customRatioError ? <p className="hb-outpaint-ratio-error" role="alert">{customRatioError}</p> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="hb-outpaint-resolution" role="radiogroup" aria-label="扩图画质">
            {RESOLUTION_OPTIONS.map((item) => (
              <button
                type="button"
                key={item}
                role="radio"
                aria-checked={resolution === item}
                className={resolution === item ? 'is-active' : ''}
                disabled={submitting}
                onClick={() => setResolution(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <textarea
            value={instruction}
            rows={1}
            disabled={submitting}
            aria-label="扩图补充描述"
            placeholder="补充扩图内容…"
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button type="submit" className="hb-outpaint-send" aria-label="发送扩图" title="发送扩图" disabled={submitting || !naturalSize.width}>
            <SendGlyphIcon />
          </button>
        </div>
        {error ? <p className="hb-outpaint-error" role="alert">{error}</p> : null}
      </form>
    </div>
  );
}
