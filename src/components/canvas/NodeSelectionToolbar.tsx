import type { CSSProperties } from 'react';
import {
  AiGlyphIcon,
  DrawGlyphIcon,
  RegenGlyphIcon,
  ZoomGlyphIcon,
} from './NodeToolbarIcons';
import './NodeSelectionToolbar.css';

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
}) {
  return (
    <div className="image-selection-toolbar" style={style} role="toolbar" aria-label="图片操作">
      {/* 第一组：查看类——放大、绘画。替换与下载保留在预览/版本操作里。 */}
      {showPreview ? (
        <button type="button" className="image-selection-toolbar-glyph-lg" title="放大查看：全屏预览这张图" aria-label="放大查看图片" onClick={onPreview}>
          <ZoomGlyphIcon />
        </button>
      ) : null}
      {onAnnotate ? (
        <button type="button" className="image-selection-toolbar-glyph-lg" title="绘画：进图手动画线、加文字" aria-label="进入绘画标注" onClick={onAnnotate}>
          <DrawGlyphIcon />
        </button>
      ) : null}
      <span aria-hidden="true" />
      {/* 第二组：生成类——二次编辑（图标+文字）、重新生成（淡底图标钮） */}
      {showRedit ? (
        <button type="button" className="image-selection-toolbar-text" title="二次编辑：照这张结果再生成一版" aria-label="二次编辑" onClick={onRedit}>
          <AiGlyphIcon />
          <span>二次编辑</span>
        </button>
      ) : null}
      {onRegenerate ? (
        <button
          type="button"
          className="image-selection-toolbar-accent"
          title="重新生成：在当前节点追加一个新版本"
          aria-label="重新生成"
          onClick={onRegenerate}
        >
          <RegenGlyphIcon />
        </button>
      ) : null}
    </div>
  );
}
