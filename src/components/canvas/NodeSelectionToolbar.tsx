import {
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  AiGlyphIcon,
  DeleteGlyphIcon,
  DrawGlyphIcon,
  OutpaintGlyphIcon,
  RegenGlyphIcon,
  ZoomGlyphIcon,
} from './NodeToolbarIcons';
import './NodeSelectionToolbar.css';

function ToolbarButton({
  label,
  tooltip,
  className,
  children,
  ...buttonProps
}: {
  label: string;
  tooltip: string;
  className: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'className' | 'title' | 'type'>) {
  const tooltipId = useId();
  return (
    <button
      {...buttonProps}
      type="button"
      className={className}
      aria-label={label}
      aria-describedby={tooltipId}
    >
      {children}
      <span id={tooltipId} className="image-selection-toolbar-tooltip" role="tooltip">
        {tooltip}
      </span>
    </button>
  );
}

/**
 * 选中图片节点时浮在节点上方的工具栏（Figma 2664:1926「图片节点」定稿）。
 * 分两组：查看类（放大查看 / 绘画）在左，
 * 生成类（二次编辑 / 重新生成）在右，中间一根细分隔线。只有单选图片节点时才出现。
 * 图标全部取自 Figma 资产（2026-09-26 拉取，见 NodeToolbarIcons.tsx）；
 * 「重新生成」是淡底图标钮（.image-selection-toolbar-accent），与其余透明图标钮区分。
 * 按钮尺寸/图标大小按 Figma 2664:1926 逐项对齐：36×32（20px 图标）/ 34×32（18px 图标）。
 *
 * 「引用到对话」入口已下线：AI 对话面板打开后，点节点本身就会自动加 chip；不再单独放按钮。
 */
export default function NodeSelectionToolbar({
  style,
  showPreview,
  showRedit,
  onPreview,
  onRedit,
  onRegenerate,
  onAnnotate,
  onOutpaint,
  onDelete,
  regenerateLabel = '重新生成',
  regenerateTitle = '重新生成：在当前节点追加一个新版本',
  ariaLabel = '图片操作',
}: {
  style?: CSSProperties;
  showPreview: boolean;
  /** 只有 AI 生成的结果图才有二次编辑：上传的参考图不参与迭代 */
  showRedit: boolean;
  onPreview: () => void;
  onRedit: () => void;
  /** 重新生成：复用当前节点，以本图为参考追加一个新版本。 */
  onRegenerate?: () => void;
  /** 标注：进入手绘标注模式。 */
  onAnnotate?: () => void;
  /** 扩图：进入画布内扩展编辑器。 */
  onOutpaint?: () => void;
  /** 删除节点：仅图片 / 参考图由页面层接入现有 React Flow 删除链路。 */
  onDelete?: () => void;
  regenerateLabel?: string;
  regenerateTitle?: string;
  ariaLabel?: string;
}) {
  const hasViewActions = showPreview || Boolean(onAnnotate) || Boolean(onOutpaint);
  const hasGenerationActions = showRedit || Boolean(onRegenerate) || Boolean(onDelete);

  return (
    <div className="image-selection-toolbar" style={style} role="toolbar" aria-label={ariaLabel}>
      {/* 第一组：查看类——放大、绘画。替换与下载保留在预览/版本操作里。 */}
      {showPreview ? (
        <ToolbarButton
          className="image-selection-toolbar-glyph-lg"
          label="放大查看图片"
          tooltip="放大查看"
          onClick={onPreview}
        >
          <ZoomGlyphIcon />
        </ToolbarButton>
      ) : null}
      {onAnnotate ? (
        <ToolbarButton
          className="image-selection-toolbar-glyph-lg"
          label="进入绘画标注"
          tooltip="绘画标注"
          onClick={onAnnotate}
        >
          <DrawGlyphIcon />
        </ToolbarButton>
      ) : null}
      {onOutpaint ? (
        <ToolbarButton
          className="image-selection-toolbar-glyph-lg"
          label="扩图"
          tooltip="扩图"
          onClick={onOutpaint}
        >
          <OutpaintGlyphIcon />
        </ToolbarButton>
      ) : null}
      {hasViewActions && hasGenerationActions ? <span aria-hidden="true" /> : null}
      {/* 第二组：生成类——二次编辑（图标+文字）、重新生成（淡底图标钮） */}
      {showRedit ? (
        <ToolbarButton
          className="image-selection-toolbar-text"
          label="二次编辑"
          tooltip="二次编辑"
          onClick={onRedit}
        >
          <AiGlyphIcon />
          <span>二次编辑</span>
        </ToolbarButton>
      ) : null}
      {onRegenerate ? (
        <ToolbarButton
          className="image-selection-toolbar-accent"
          label={regenerateLabel}
          tooltip={regenerateTitle}
          onClick={onRegenerate}
        >
          <RegenGlyphIcon />
        </ToolbarButton>
      ) : null}
      {onDelete ? (
        <ToolbarButton
          className="image-selection-toolbar-glyph-sm image-selection-toolbar-danger"
          label="删除节点"
          tooltip="删除节点（可撤销）"
          onClick={onDelete}
        >
          <DeleteGlyphIcon />
        </ToolbarButton>
      ) : null}
    </div>
  );
}
