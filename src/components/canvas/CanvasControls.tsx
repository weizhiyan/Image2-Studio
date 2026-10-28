import type { ReactNode } from 'react';
import { CANVAS_ZOOM_SLIDER_STEPS, canvasSliderPosToZoom, canvasZoomToSliderPos } from '@/lib/canvasViewport';
import './CanvasControls.css';

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

/** 选择工具：左键恢复框选节点 */
function SelectIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.725 3.547c-.129-.819.737-1.43 1.465-1.035L17.17 9.016c.863.469.604 1.771-.373 1.873l-5.302.559a.85.85 0 0 0-.757.486l-3.072 5.22c-.476.81-1.703.576-1.85-.352L3.725 3.547Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 抓手工具：左键变成平移画布 */
function PanToolIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M9.713 2.044A1.176 1.176 0 0 0 8.537 3.218L8.372 8.663 7.518 4.451c-.13-.64-.73-1.059-1.356-.945l-.071.013a1.176 1.176 0 0 0-.96 1.366l.723 5.156-1.118-2.841a1.176 1.176 0 0 0-1.92-.653l-.08.03a1.176 1.176 0 0 0-.717 1.51l2.19 7.006c.334.829.48 1.431 1.697 2.267 1.217.836 4.815 1.004 6.501-.542.614-.563 1.489-1.623 1.96-2.336l2.567-3.54a1.176 1.176 0 0 0-.797-1.748 1.176 1.176 0 0 0-1.197.113l-2.037 1.28.935-6.672A1.176 1.176 0 0 0 13.406 3.519l-.071.013c-.626.184-1.226.765-1.096 1.405l-.853 4.212-.166-5.445A1.176 1.176 0 0 0 9.785 2.044h-.072Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 整理按钮：错位的方块被收拢成对齐的两条线，表达「把节点排齐」。 */
function TidyIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.7" y="2.3" width="4.3" height="4.3" rx="1.1" />
      <rect x="2.7" y="9.4" width="4.3" height="4.3" rx="1.1" />
      <path d="M9.9 4.5h4.4M9.9 11.5h4.4" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FitViewIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />
    </svg>
  );
}

/**
 * 左侧竖向功能入口：添加节点（主操作白底）+ 页面专属按钮 + 拖动工具。
 * onAdd 的回调参数是添加按钮的屏幕锚点，各页面按自己的节点面板决定弹窗位置。
 */
export function CanvasRail({
  onAdd,
  extraButtons,
  panTool,
  onTogglePanTool,
  addTitle = '添加节点',
}: {
  onAdd: (anchor: { x: number; y: number }) => void;
  extraButtons?: ReactNode;
  panTool: boolean;
  onTogglePanTool: () => void;
  addTitle?: string;
}) {
  return (
    <div className="canvas-rail" role="group" aria-label="画布功能入口">
      <button
        className="canvas-rail-btn canvas-rail-btn-add"
        type="button"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onAdd({ x: rect.right + 12, y: rect.top });
        }}
        aria-label={addTitle}
      >
        <PlusIcon />
      </button>
      {extraButtons}
      <button
        className={`canvas-rail-btn canvas-rail-tool ${panTool ? 'is-active' : ''}`}
        type="button"
        onClick={onTogglePanTool}
        aria-label={panTool ? '切回选择工具' : '切换成抓手工具'}
        aria-pressed={panTool}
      >
        {panTool ? <PanToolIcon /> : <SelectIcon />}
      </button>
    </div>
  );
}

/** 左下角缩放 dock：整理布局 + 重置视角 + 可拖动滑块 + 百分比（对数行程） */
export function CanvasDock({
  zoom,
  onZoomChange,
  onTidy,
  onReset,
}: {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  /** 整理当前画布的节点布局（按边分层排齐），支持 Ctrl+Z 撤回 */
  onTidy: () => void;
  onReset: () => void;
}) {
  return (
    <div className="canvas-dock" role="group" aria-label="画布视图控制">
      <button className="canvas-dock-btn" type="button" onClick={onReset} aria-label="重置到最佳视角">
        <FitViewIcon />
      </button>
      <button
        className="canvas-dock-btn"
        type="button"
        onClick={onTidy}
        aria-label="整理画布布局"
      >
        <TidyIcon />
      </button>
      <input
        className="canvas-dock-slider"
        type="range"
        min={0}
        max={CANVAS_ZOOM_SLIDER_STEPS}
        step={1}
        value={canvasZoomToSliderPos(zoom)}
        onChange={(event) => onZoomChange(canvasSliderPosToZoom(Number(event.target.value)))}
        aria-label="缩放画布"
      />
      {/* 百分比放到滑块右边：滑块紧贴左侧图标组，用户实测"滑块离左侧太远" */}
      <span className="canvas-dock-zoom" aria-label={`当前缩放 ${Math.round(zoom * 100)}%`}>
        {Math.round(zoom * 100)}%
      </span>
    </div>
  );
}
