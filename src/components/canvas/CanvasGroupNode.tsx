import { useEffect, useRef, useState } from 'react';
import { useViewport, type NodeProps } from '@xyflow/react';
import type { CanvasGroupColor, CanvasNodeData } from '@/types';
import {
  CANVAS_GROUP_EVENTS,
  emitEvent,
  type CanvasGroupActionDetail,
  type CanvasGroupColorDetail,
  type CanvasGroupRenameDetail,
} from '@/lib/events';
import './CanvasGroupNode.css';

const GROUP_COLORS: Array<{ value: CanvasGroupColor; label: string }> = [
  { value: 'neutral', label: '中性色' },
  { value: 'blue', label: '蓝色' },
  { value: 'green', label: '绿色' },
  { value: 'amber', label: '琥珀色' },
  { value: 'purple', label: '紫色' },
];

function DissolveGroupIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.3125" y="2.3125" width="15.375" height="15.375" rx="1.875" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 3" />
    </svg>
  );
}

export default function CanvasGroupNode({ id, data, selected }: NodeProps) {
  const { zoom } = useViewport();
  const d = data as unknown as CanvasNodeData;
  const color = GROUP_COLORS.some((item) => item.value === d.groupColor)
    ? d.groupColor as CanvasGroupColor
    : 'neutral';
  const label = String(d.label || '').trim() || '未命名编组';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(label);
  }, [editing, label]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startRename = () => {
    cancelledRef.current = false;
    setDraft(label);
    setEditing(true);
  };

  const commitRename = () => {
    if (!editing) return;
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(label);
      return;
    }
    const next = draft.trim();
    if (!next || next === label) {
      setDraft(label);
      return;
    }
    emitEvent<CanvasGroupRenameDetail>(CANVAS_GROUP_EVENTS.rename, { nodeId: id, label: next });
  };

  return (
    <div className={`canvas-group-node-shell is-${color}${selected ? ' is-selected' : ''}`}>
      {selected ? (
        <div
          className="canvas-group-toolbar nodrag nowheel nopan"
          role="toolbar"
          aria-label="编组操作"
          style={{ transform: `translateX(-50%) scale(${1 / Math.max(zoom, 0.01)})` }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="canvas-group-colors" role="group" aria-label="编组颜色">
            {GROUP_COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`canvas-group-color is-${item.value}${item.value === color ? ' is-active' : ''}`}
                aria-label={`编组颜色：${item.label}`}
                aria-pressed={item.value === color}
                title={item.label}
                onClick={() => emitEvent<CanvasGroupColorDetail>(CANVAS_GROUP_EVENTS.color, {
                  nodeId: id,
                  color: item.value,
                })}
              />
            ))}
          </div>
          <span className="canvas-group-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            className="canvas-group-action"
            aria-label="解散编组并保留成员"
            onClick={() => emitEvent<CanvasGroupActionDetail>(CANVAS_GROUP_EVENTS.dissolve, { nodeId: id })}
          >
            <DissolveGroupIcon />
            <span className="canvas-group-tooltip" role="tooltip">
              解散编组 · 保留成员
            </span>
          </button>
        </div>
      ) : null}

      <div className="canvas-group-header">
        {editing ? (
          <input
            ref={inputRef}
            className="canvas-group-name-input nodrag nowheel nopan"
            value={draft}
            maxLength={60}
            aria-label="编组名称"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelledRef.current = true;
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <span
            className="canvas-group-name nodrag"
            role="button"
            tabIndex={0}
            title="双击重命名"
            onDoubleClick={(event) => {
              event.stopPropagation();
              startRename();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'F2') {
                event.preventDefault();
                startRename();
              }
            }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}
