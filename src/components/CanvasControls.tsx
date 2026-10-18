import { useReactFlow } from '@xyflow/react';

/** 灵枢同款画布控制栏：左下纵排，+ / − / 重置 50%。 */
export default function CanvasControls() {
  const rf = useReactFlow();

  const resetZoom = () => {
    const bounds = document.querySelector('.react-flow')?.getBoundingClientRect();
    const cx = bounds ? bounds.width / 2 : 0;
    const cy = bounds ? bounds.height / 2 : 0;
    const center = rf.screenToFlowPosition({ x: cx, y: cy });
    rf.setViewport({ x: cx - center.x * 0.5, y: cy - center.y * 0.5, zoom: 0.5 });
  };

  return (
    <div className="image-canvas-controls" role="group" aria-label="画布操作">
      <button
        type="button"
        className="image-canvas-controls-zoom"
        onClick={() => rf.zoomIn({ duration: 200 })}
        title="放大"
        aria-label="放大"
      >
        +
      </button>
      <button
        type="button"
        className="image-canvas-controls-zoom"
        onClick={() => rf.zoomOut({ duration: 200 })}
        title="缩小"
        aria-label="缩小"
      >
        −
      </button>
      <button
        type="button"
        className="image-canvas-controls-reset"
        onClick={resetZoom}
        title="重置为 50%"
        aria-label="重置为 50%"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8a5 5 0 1 1 1.5 3.6M3 11V8h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
