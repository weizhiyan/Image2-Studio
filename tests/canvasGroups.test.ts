import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CANVAS_GROUP_HEADER_HEIGHT,
  CANVAS_GROUP_MIN_HEIGHT,
  CANVAS_GROUP_MIN_WIDTH,
  CANVAS_GROUP_PADDING,
  absoluteNodePosition,
  canvasTidyGraph,
  collectCanvasGroupMembers,
  createCanvasGroupGraph,
  deleteCanvasGroup,
  detachCanvasNode,
  dissolveCanvasGroup,
  normalizeCanvasGroups,
} from '@/stores/canvasStore';
import type { CanvasEdge, CanvasNode, CanvasNodeKind } from '@/types';

const canvasPageSource = readFileSync(new URL('../src/pages/CanvasPage.tsx', import.meta.url), 'utf8');

function node(
  id: string,
  kind: CanvasNodeKind,
  x: number,
  y: number,
  width = 200,
  height = 100,
): CanvasNode {
  return {
    id,
    type: kind === 'group' ? 'canvas-group' : 'flow-image',
    position: { x, y },
    width,
    height,
    data: { kind, label: id },
  };
}

describe('canvas groups', () => {
  it('creates a group with relative member positions and hydrates its members', () => {
    const a = node('a', 'image', 100, 100, 200, 100);
    const b = node('b', 'reference', 360, 240, 120, 100);
    const edges: CanvasEdge[] = [{ id: 'a-b', source: 'a', target: 'b' }];

    const result = createCanvasGroupGraph([a, b], edges, ['a', 'b'], {
      groupId: 'g1',
      label: '  角色素材  ',
      color: 'blue',
    });

    const group = result.nodes.find((item) => item.id === 'g1');
    expect(group).toMatchObject({
      id: 'g1',
      type: 'canvas-group',
      position: { x: 100 - CANVAS_GROUP_PADDING, y: 100 - CANVAS_GROUP_HEADER_HEIGHT - CANVAS_GROUP_PADDING },
      width: 412,
      height: 312,
      data: { kind: 'group', label: '角色素材', groupColor: 'blue' },
    });
    expect(result.nodes.filter((item) => item.id !== 'g1').map((item) => item.id)).toEqual(['a', 'b']);
    expect(result.nodes.find((item) => item.id === 'a')).toMatchObject({
      parentId: 'g1',
      expandParent: false,
      position: { x: CANVAS_GROUP_PADDING, y: CANVAS_GROUP_HEADER_HEIGHT + CANVAS_GROUP_PADDING },
    });
    expect(result.nodes.find((item) => item.id === 'a')).not.toHaveProperty('extent');
    expect(result.nodes.find((item) => item.id === 'b')?.position).toEqual({ x: 276, y: 196 });
    expect(result.nodes.findIndex((item) => item.id === 'g1')).toBeLessThan(result.nodes.findIndex((item) => item.id === 'a'));
    expect(result.edges).toEqual(edges);
  });

  it('uses measured node size when an auto-height member has no explicit height', () => {
    type MeasuredNode = CanvasNode & { measured: { width: number; height: number } };
    const a = node('a', 'composer', 100, 776, 320, 200) as MeasuredNode;
    delete a.height;
    a.measured = { width: 320, height: 280 };
    const b = node('b', 'composer', 592, 716, 320, 200) as MeasuredNode;
    delete b.height;
    b.measured = { width: 320, height: 280 };

    const created = createCanvasGroupGraph([a, b], [], ['a', 'b'], { groupId: 'g1' });
    const group = created.nodes.find((item) => item.id === 'g1')!;
    const memberA = created.nodes.find((item) => item.id === 'a')!;
    const memberB = created.nodes.find((item) => item.id === 'b')!;

    expect(group.height).toBe(412);
    expect(group.position.y + memberA.position.y).toBe(776);
    expect(group.position.y + memberB.position.y).toBe(716);
    expect(memberA.position.y + 280).toBeLessThanOrEqual(group.height!);

    const dissolved = dissolveCanvasGroup(created.nodes, [], 'g1');
    expect(dissolved.nodes.find((item) => item.id === 'a')?.position).toEqual({ x: 100, y: 776 });
    expect(dissolved.nodes.find((item) => item.id === 'b')?.position).toEqual({ x: 592, y: 716 });
  });

  it('moves a group as one unit and survives a JSON round trip', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'image', 400, 260);
    const created = createCanvasGroupGraph([a, b], [], ['a', 'b'], { groupId: 'g1' });
    const moved = created.nodes.map((item) => (
      item.id === 'g1'
        ? { ...item, position: { x: item.position.x + 160, y: item.position.y + 90 } }
        : item
    ));
    const member = moved.find((item) => item.id === 'a')!;
    const absoluteBefore = absoluteNodePosition(moved, member);
    const roundTripped = JSON.parse(JSON.stringify(moved)) as CanvasNode[];
    const normalized = normalizeCanvasGroups(roundTripped, []).nodes;
    const normalizedMember = normalized.find((item) => item.id === 'a')!;

    expect(normalized.findIndex((item) => item.id === 'g1')).toBeLessThan(normalized.findIndex((item) => item.id === 'a'));
    expect(absoluteNodePosition(normalized, normalizedMember)).toEqual(absoluteBefore);
    expect(normalized.find((item) => item.id === 'g1')?.position).toEqual({ x: 244, y: 134 });
    expect(normalizedMember.position).toEqual(member.position);
  });

  it('normalizes colors, labels, sizes, coordinates, nesting and empty groups', () => {
    const group = node('g1', 'group', 0, 0, 200, 200);
    group.parentId = 'g0';
    const nestedGroup = node('g2', 'group', 40, 50, 300, 240);
    nestedGroup.parentId = 'g1';
    const member = node('a', 'image', 16, 56, 100, 50);
    member.parentId = 'g2';
    member.extent = 'parent';
    const orphan = node('orphan', 'reference', 20, 30);
    orphan.parentId = 'missing';
    const invalidCoordinates = node('invalid', 'image', Number.NaN, Number.NaN);

    const normalized = normalizeCanvasGroups(
      [group, nestedGroup, member, node('empty', 'group', 0, 0, 300, 300), orphan, invalidCoordinates],
      [],
    ).nodes;
    const groups = normalized.filter((item) => item.data.kind === 'group');
    const normalizedMember = normalized.find((item) => item.id === 'a')!;

    expect(groups.map((item) => item.id)).toEqual(['g2']);
    expect(groups[0]).toMatchObject({
      position: { x: 40, y: 50 },
      width: 300,
      height: 240,
      data: { label: 'g2', groupColor: 'neutral' },
    });
    expect(groups[0].parentId).toBeUndefined();
    expect(normalizedMember.parentId).toBe('g2');
    expect(normalizedMember.position).toEqual({ x: 16, y: 56 });
    expect(normalizedMember).not.toHaveProperty('extent');
    expect(normalized.find((item) => item.id === 'orphan')).toMatchObject({
      position: { x: 20, y: 30 },
    });
    expect(normalized.find((item) => item.id === 'orphan')).not.toHaveProperty('parentId');
    expect(normalized.find((item) => item.id === 'orphan')).not.toHaveProperty('extent');
    expect(normalized.find((item) => item.id === 'invalid')?.position).toEqual({ x: 0, y: 0 });
    expect(normalized.find((item) => item.id === 'empty')).toBeUndefined();

    const invalidNodes: CanvasNode[] = [
      {
        ...node('bad', 'group', Number.NaN, Number.NaN, 0, Number.NaN),
        data: { kind: 'group', label: ' ', groupColor: 'red' as never },
      },
      node('child', 'image', 16, 56, 100, 30),
    ];
    const invalidGroup = normalizeCanvasGroups(
      invalidNodes.map((item) => item.id === 'child' ? { ...item, parentId: 'bad' } : item),
      [],
    ).nodes;
    expect(invalidGroup.find((item) => item.id === 'bad')).toMatchObject({
      position: { x: 0, y: 0 },
      width: CANVAS_GROUP_MIN_WIDTH,
      height: CANVAS_GROUP_MIN_HEIGHT,
      data: { label: '未命名编组', groupColor: 'neutral' },
    });
  });

  it('removes dangling edges and edges connected to a group', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'image', 400, 100);
    const outside = node('outside', 'composer', 800, 100);
    const created = createCanvasGroupGraph([a, b, outside], [], ['a', 'b'], { groupId: 'g1' });
    const edges: CanvasEdge[] = [
      { id: 'inside', source: 'a', target: 'b' },
      { id: 'external', source: 'b', target: 'outside' },
      { id: 'group-endpoint', source: 'g1', target: 'outside' },
      { id: 'dangling', source: 'b', target: 'missing' },
    ];

    expect(normalizeCanvasGroups(created.nodes, edges).edges).toEqual([
      { id: 'inside', source: 'a', target: 'b' },
      { id: 'external', source: 'b', target: 'outside' },
    ]);
  });

  it('dissolves a group while keeping members and their absolute positions', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'reference', 420, 280);
    const created = createCanvasGroupGraph([a, b], [], ['a', 'b'], { groupId: 'g1' });
    const result = dissolveCanvasGroup(created.nodes, [], 'g1');

    expect(result.nodes.some((item) => item.id === 'g1')).toBe(false);
    expect(result.nodes.find((item) => item.id === 'a')).toMatchObject({
      position: { x: 100, y: 100 },
    });
    expect(result.nodes.find((item) => item.id === 'a')).not.toHaveProperty('parentId');
    expect(result.nodes.find((item) => item.id === 'a')).not.toHaveProperty('extent');
    expect(result.nodes.find((item) => item.id === 'b')?.position).toEqual({ x: 420, y: 280 });
  });

  it('deletes a group together with every direct member and connected edge', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'video', 400, 100);
    const outside = node('outside', 'image', 800, 100);
    const another = node('another', 'image', 1100, 100);
    const created = createCanvasGroupGraph([a, b, outside, another], [], ['a', 'b'], { groupId: 'g1' });
    const edges: CanvasEdge[] = [
      { id: 'inside', source: 'a', target: 'b' },
      { id: 'outside-edge', source: 'b', target: 'outside' },
      { id: 'kept', source: 'outside', target: 'another' },
    ];

    const result = deleteCanvasGroup(created.nodes, edges, 'g1');
    expect(result.nodes.map((item) => item.id)).toEqual(['outside', 'another']);
    expect(result.edges).toEqual([{ id: 'kept', source: 'outside', target: 'another' }]);
  });

  it('detaches a copied member without moving it on screen', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'image', 400, 260);
    const created = createCanvasGroupGraph([a, b], [], ['a', 'b'], { groupId: 'g1' });
    const member = created.nodes.find((item) => item.id === 'a')!;
    const detached = detachCanvasNode(created.nodes, member);

    expect(detached).toMatchObject({
      position: { x: 100, y: 100 },
    });
    expect(detached).not.toHaveProperty('parentId');
    expect(detached).not.toHaveProperty('extent');
    expect(detached).not.toHaveProperty('expandParent');
  });

  it('treats a group as one tidy unit and folds external edges to its root', () => {
    const a = node('a', 'image', 100, 100);
    const b = node('b', 'image', 420, 100);
    const upstream = node('upstream', 'reference', -300, 100);
    const downstream = node('downstream', 'image', 900, 100);
    const created = createCanvasGroupGraph([a, b], [], ['a', 'b'], { groupId: 'g1' });
    const graph = canvasTidyGraph(
      [...created.nodes, upstream, downstream],
      [
        { id: 'inside', source: 'a', target: 'b' },
        { id: 'incoming', source: 'upstream', target: 'a' },
        { id: 'outgoing', source: 'b', target: 'downstream' },
      ],
    );

    expect(graph.nodes.map((item) => item.id).sort()).toEqual(['downstream', 'g1', 'upstream']);
    expect(graph.edges).toEqual([
      { id: 'tidy:upstream\u0000g1', source: 'upstream', target: 'g1' },
      { id: 'tidy:g1\u0000downstream', source: 'g1', target: 'downstream' },
    ]);
    expect(collectCanvasGroupMembers(created.nodes, 'g1').map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('serializes canvas writes and rejects stale remote hydration during local graph changes', () => {
    expect(canvasPageSource).toContain(
      'const remoteSyncQueueRef = useRef<Promise<void>>(Promise.resolve());',
    );
    expect(canvasPageSource).toContain(
      "(previous?.updatedAt || '') !== localUpdatedAt",
    );
    expect(canvasPageSource).toContain(
      'if (syncRevision === remoteSyncRevisionRef.current)',
    );
  });
});
