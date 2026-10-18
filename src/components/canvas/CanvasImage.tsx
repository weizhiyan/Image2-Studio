import { useState, type ImgHTMLAttributes } from 'react';

export type CanvasImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  /** 占位卡里补充的上下文说明（提示词 / 文件名），让"这里曾有过一张图"可追溯 */
  missingNote?: string;
};

/** 画布统一图片组件。
 *  文件丢失（404 / 被清理 / dev server 掉线后拿不到图）时不再露浏览器裂图图标，
 *  换成一张虚线占位卡：图标 + "图片文件丢失" + 可选的提示词说明，卡片布局保持不变。
 *  空 src 同样走占位——引用还没就位时也不露裂图。 */
export default function CanvasImage({
  src,
  alt,
  className,
  missingNote,
  onError,
  ...rest
}: CanvasImageProps) {
  const [missing, setMissing] = useState(false);
  if (!src || missing) {
    return (
      <div
        className={['canvas-image-missing', className].filter(Boolean).join(' ')}
        role="img"
        aria-label={alt || '图片文件丢失'}
        title={missingNote ? `图片文件丢失 · ${missingNote}` : '图片文件丢失'}
      >
        <svg className="canvas-image-missing-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="2.75" y="4.25" width="14.5" height="11.5" rx="2" />
          <circle cx="7.25" cy="8" r="1.1" />
          <path d="M3 13.5 6.5 10l2.75 2.75L12 10l4.75 4.75" />
          <path d="M3.5 16.5 16.5 3.5" />
        </svg>
        <span className="canvas-image-missing-text">图片文件丢失</span>
        {missingNote ? <span className="canvas-image-missing-note">{missingNote}</span> : null}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      onError={(event) => {
        setMissing(true);
        onError?.(event);
      }}
      {...rest}
    />
  );
}
