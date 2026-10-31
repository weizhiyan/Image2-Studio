import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MarkdownText } from '@/components/chat/ChatMessageList';
import { nodeBoxFor } from '@/lib/aspect';
import { pickTextProfile } from '@/lib/enhance';
import { useSettingsStore } from '@/stores/settingsStore';
import type { CanvasNodeData } from '@/types';
import {
  emitEvent,
  NODE_ANIMATION_EVENTS,
  NODE_EVENTS,
  onEvent,
  type NodeResizeStartDetail,
  type NodeTextContentDetail,
  type NodeTextOptimizeDetail,
  type NodeTextOptimizeResultDetail,
} from '@/lib/events';
import { AiGlyphIcon } from './NodeToolbarIcons';
import './CanvasTextNode.css';

function TextMark() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 5h12M10 5v10M7 15h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function CanvasTextNode({ id, data, selected }: NodeProps) {
  const nodeData = data as unknown as CanvasNodeData;
  const box = nodeBoxFor(nodeData);
  const content = String(nodeData.textContent || '');
  const settings = useSettingsStore((state) => state.settings);
  const polishModelLabel = pickTextProfile(settings)?.model || '';
  const [editing, setEditing] = useState(nodeData.textEditing === true);
  const [draft, setDraft] = useState(content);
  const [optimizing, setOptimizing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const contentRef = useRef(content);
  const commitTimerRef = useRef(0);
  draftRef.current = draft;
  contentRef.current = content;

  // 编辑期间只认本地草稿：父级回写 content 会让受控 textarea 重设选区，光标就跳到末尾 / 消失
  useEffect(() => {
    if (editing) return;
    setDraft(content);
  }, [content, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => () => window.clearTimeout(commitTimerRef.current), []);

  useEffect(() => onEvent<NodeTextOptimizeResultDetail>(
    NODE_EVENTS.textOptimizeResult,
    (detail) => {
      if (detail.nodeId !== id) return;
      setOptimizing(false);
      if (typeof detail.text === 'string') {
        draftRef.current = detail.text;
        setDraft(detail.text);
      }
    },
  ), [id]);

  const commitDraft = () => {
    window.clearTimeout(commitTimerRef.current);
    if (draftRef.current !== contentRef.current) {
      emitEvent<NodeTextContentDetail>(NODE_EVENTS.textContent, { nodeId: id, text: draftRef.current });
    }
    setEditing(false);
  };

  const updateDraft = (text: string) => {
    draftRef.current = text;
    setDraft(text);
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      if (draftRef.current === contentRef.current) return;
      emitEvent<NodeTextContentDetail>(NODE_EVENTS.textContent, { nodeId: id, text: draftRef.current });
    }, 300);
  };

  const beginEditing = () => {
    draftRef.current = content;
    setDraft(content);
    setEditing(true);
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    emitEvent<NodeResizeStartDetail>(NODE_ANIMATION_EVENTS.resizeStart, {
      nodeId: id,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerId: event.pointerId,
      pointerTarget: event.currentTarget,
    });
  };

  const optimizeContent = () => {
    const text = draft.trim();
    if (!text || optimizing) return;
    setOptimizing(true);
    emitEvent<NodeTextOptimizeDetail>(NODE_EVENTS.textOptimize, { nodeId: id, text });
  };

  return (
    <div
      className={`image-flow-node image-node-composer-card canvas-text-node has-manual-height${selected ? ' selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{
        '--image-node-width': `${box.width}px`,
        '--image-node-height': `${box.height}px`,
      } as CSSProperties}
    >
      <Handle type="source" position={Position.Right} id="out" className="image-handle image-handle-source image-node-connect-add text" aria-label="作为提示词连到下游" title="作为提示词连到下游">
        <span className="image-node-connect-ring" aria-hidden="true" />
      </Handle>
      <div className="image-node-body canvas-text-node-body">
        <div className="image-node-kind-label canvas-text-node-kind-label">
          <TextMark />
          <span>文本</span>
        </div>
        <div className="image-node-composer-shell canvas-text-node-card">
          {editing ? (
            <textarea
              ref={inputRef}
              className="canvas-text-node-input nodrag nowheel nopan"
              value={draft}
              maxLength={12000}
              aria-label="Markdown 文本内容"
              onChange={(event) => updateDraft(event.currentTarget.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                  event.preventDefault();
                  commitDraft();
                }
              }}
            />
          ) : (
            <div
              className="canvas-text-node-preview nodrag nowheel nopan"
              onDoubleClick={beginEditing}
              onClick={() => {
                if (!draft.trim()) beginEditing();
              }}
            >
              {draft.trim() ? <MarkdownText text={draft} /> : null}
            </div>
          )}
          <div className="canvas-text-node-actions">
            <button
              type="button"
              className="canvas-text-node-polish nodrag nowheel nopan"
              disabled={!draft.trim() || optimizing}
              title={polishModelLabel ? `润色（${polishModelLabel}）` : '润色'}
              aria-label={polishModelLabel ? `润色，使用 ${polishModelLabel}` : '润色'}
              onClick={optimizeContent}
            >
              <AiGlyphIcon />
              <span>{optimizing ? '润色中…' : '润色'}</span>
            </button>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="image-node-resize-handle nodrag nowheel"
        aria-label="拖拽调整文本节点宽高"
        title="拖拽调整文本节点宽高"
        onPointerDown={startResize}
      />
    </div>
  );
}
