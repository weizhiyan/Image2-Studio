import { addEdge, type Connection, type Edge } from '@xyflow/react';

export type CanvasConnectionDirection = 'source' | 'target';

export interface CanvasPendingConnection {
  sourceId: string;
  handleType: CanvasConnectionDirection;
}

const CONNECTABLE_SOURCE_KINDS = new Set(['reference', 'composer', 'image', 'text']);
const CONNECTABLE_TARGET_KINDS = new Set(['composer', 'image', 'video']);

export function canConnectCanvasNodeKinds(sourceKind: string, targetKind: string): boolean {
  return CONNECTABLE_SOURCE_KINDS.has(sourceKind) && CONNECTABLE_TARGET_KINDS.has(targetKind);
}

export function connectionForNewNode(
  existingNodeId: string,
  direction: CanvasConnectionDirection,
  newNodeId: string,
): Connection {
  return direction === 'target'
    ? { source: newNodeId, sourceHandle: 'out', target: existingNodeId, targetHandle: 'in' }
    : { source: existingNodeId, sourceHandle: 'out', target: newNodeId, targetHandle: 'in' };
}

export function hasCanvasConnection(
  edges: Edge[],
  connection: Pick<Connection, 'source' | 'target'>,
  ignoredEdgeId?: string,
): boolean {
  return Boolean(connection.source && connection.target && edges.some((edge) => (
    edge.id !== ignoredEdgeId
    && edge.source === connection.source
    && edge.target === connection.target
  )));
}

export function appendUniqueCanvasConnection(
  edges: Edge[],
  connection: Connection,
  edgeId: string,
): Edge[] {
  if (!connection.source || !connection.target || connection.source === connection.target) return edges;
  if (hasCanvasConnection(edges, connection)) return edges;
  return addEdge({ ...connection, id: edgeId }, edges);
}

export function menuClientPoint(
  rect: Pick<DOMRect, 'left' | 'top'> | null,
  position: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (rect?.left || 0) + position.x,
    y: (rect?.top || 0) + position.y,
  };
}
