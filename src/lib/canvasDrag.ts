export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
  dragging?: boolean;
}

/** React Flow's drag-stop callback includes final positions only for dragged nodes. */
export function applyFinalDraggedPositions<T extends PositionedNode>(nodes: T[], draggedNodes: PositionedNode[]): T[] {
  const finalPositions = new Map(draggedNodes.map((node) => [node.id, node.position]));
  if (finalPositions.size === 0) return nodes;

  return nodes.map((node) => {
    const position = finalPositions.get(node.id);
    return position
      ? { ...node, position: { ...position }, dragging: false }
      : node;
  });
}
