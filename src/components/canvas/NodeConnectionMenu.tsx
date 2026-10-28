import type { Edge } from '@xyflow/react';
import type { CanvasNode } from '@/types';
import { canConnectCanvasNodeKinds } from '@/lib/canvasConnections';

export interface NodeConnectionMenuProps {
  x: number;
  y: number;
  /** 发起连接的节点 */
  sourceId: string;
  /** target = 左手柄「+」（找上游）；source = 右手柄「+」（找下游） */
  direction: 'source' | 'target';
  nodes: CanvasNode[];
  edges: Edge[];
  onClose: () => void;
  onConnect: (targetId: string) => void;
}

function ModelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="7" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9 12h6M12 9v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 点节点左右手柄「+」弹出的连接菜单（灵枢 image-connect-menu 同款）：
 * 只列当前可连接的现有节点。
 */
export default function NodeConnectionMenu({
  x,
  y,
  sourceId,
  direction,
  nodes,
  edges,
  onClose,
  onConnect,
}: NodeConnectionMenuProps) {
  const isTargetDirection = direction === 'target';
  const anchorNode = nodes.find((node) => node.id === sourceId);
  const targets = nodes.filter((node) => {
    if (node.id === sourceId) return false;
    if (!anchorNode) return false;
    const sourceKind = isTargetDirection ? node.data.kind : anchorNode.data.kind;
    const targetKind = isTargetDirection ? anchorNode.data.kind : node.data.kind;
    if (!canConnectCanvasNodeKinds(sourceKind, targetKind)) return false;
    return !edges.some((edge) => edge.source === (isTargetDirection ? node.id : sourceId)
      && edge.target === (isTargetDirection ? sourceId : node.id));
  });
  return (
    <section className="image-add-menu image-connect-menu" role="menu" aria-label="连接到节点" style={{ left: x, top: y }}>
      <div className="image-add-menu-title">
        <span>连接节点</span>
        <button type="button" onClick={onClose} aria-label="关闭">×</button>
      </div>
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          className="image-add-menu-item compact image-connect-menu-target"
          role="menuitem"
          onClick={() => onConnect(target.id)}
        >
          <span className="image-connect-menu-thumb">
            {String(target.data.imageUrl || target.data.referenceDataUrl || '').trim() ? (
              <img src={String(target.data.imageUrl || target.data.referenceDataUrl)} alt="" />
            ) : <ModelIcon />}
          </span>
          <strong>{String(target.data.prompt || target.data.label || (target.data.kind === 'reference' ? '素材节点' : '生成节点'))}</strong>
          <small>{target.data.status === 'running' ? '正在生成' : '连接到这个节点'}</small>
        </button>
      ))}
      {targets.length === 0 ? <div className="image-add-menu-hint">没有可连接的节点</div> : null}
    </section>
  );
}
