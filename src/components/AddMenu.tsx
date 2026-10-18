interface AddMenuProps {
  x: number;
  y: number;
  notice?: string;
  onCreateGenerationNode: () => void;
  onUploadImage: () => void;
}

/** 双击画布空白处的添加菜单：对齐灵枢 ImageCanvasPage 的 image-add-menu（两项子集）。 */
export default function AddMenu({ x, y, notice, onCreateGenerationNode, onUploadImage }: AddMenuProps) {
  return (
    <section className="image-add-menu" role="menu" aria-label="添加画布内容" style={{ left: x, top: y }}>
      <button type="button" className="image-add-menu-item compact" role="menuitem" onClick={onCreateGenerationNode}>
        <span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.5v-11Z" stroke="currentColor" strokeWidth="1.6" />
            <path d="m7.5 16 3.1-3.2 2.2 2.2 1.4-1.5 2.8 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 9h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </span>
        <strong>图像生成</strong>
        <small>添加空白生成节点并打开输入框</small>
      </button>
      <button type="button" className="image-add-menu-item compact" role="menuitem" onClick={onUploadImage}>
        <span>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 16V5m0 0L8 9m4-4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 17v1.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <strong>上传图片</strong>
        <small>作为参考图或画布素材</small>
      </button>
      {notice ? <div className="image-add-menu-notice">{notice}</div> : null}
    </section>
  );
}
