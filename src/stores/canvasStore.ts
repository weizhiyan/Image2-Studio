import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import type { CanvasDoc, CanvasEdge, CanvasGroupColor, CanvasNode } from '@/types';
import { createId } from '@/lib/id';
import { registerCanvas } from '@/lib/bridge';

interface CanvasState {
  canvases: CanvasDoc[];
  activeId: string;
  cursor: { x: number; y: number };
  createCanvas: (name?: string) => string;
  renameCanvas: (id: string, name: string) => void;
  deleteCanvas: (id: string) => void;
  setActive: (id: string) => void;
  addNode: (node: CanvasNode) => void;
  updateNode: (id: string, patch: Partial<CanvasNodeData>) => void;
  removeNode: (id: string) => void;
  setGraph: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
  mergeCanvases: (remote: CanvasDoc[]) => void;
  /** 按 id 把远端节点补进指定画布（不覆盖本地已有内容）：MCP 落图、定位前取文档都用它。 */
  mergeCanvasNodes: (canvasId: string, nodes: CanvasNode[]) => void;
  adoptCanvases: (remote: CanvasDoc[]) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  advanceCursor: (dx: number, dy: number) => void;
  activeCanvas: () => CanvasDoc;
}

type CanvasNodeData = CanvasNode['data'];
type CanvasPoint = { x: number; y: number };
type MeasuredCanvasNode = CanvasNode & {
  measured?: { width?: number; height?: number };
};
type CanvasGroupNode = CanvasNode & {
  data: CanvasNodeData & { kind: 'group' };
};

export const CANVAS_GROUP_PADDING = 16;
export const CANVAS_GROUP_HEADER_HEIGHT = 40;
export const CANVAS_GROUP_MIN_WIDTH = 160;
export const CANVAS_GROUP_MIN_HEIGHT = 120;

const CANVAS_GROUP_COLORS: readonly CanvasGroupColor[] = ['neutral', 'blue', 'green', 'amber', 'purple'];

export interface CanvasGroupGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groupId: string;
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nodeWidth(node: CanvasNode): number {
  const measured = (node as MeasuredCanvasNode).measured;
  return Math.max(1, finiteNumber(measured?.width, finiteNumber(node.width, 280)));
}

function nodeHeight(node: CanvasNode): number {
  const measured = (node as MeasuredCanvasNode).measured;
  return Math.max(1, finiteNumber(measured?.height, finiteNumber(node.height, 200)));
}

function isGroupNode(node: CanvasNode | undefined): node is CanvasGroupNode {
  return node?.data?.kind === 'group';
}

function stripParent(node: CanvasNode, absolutePosition?: CanvasPoint): CanvasNode {
  const next = { ...node };
  delete next.parentId;
  delete next.extent;
  delete next.expandParent;
  if (absolutePosition) next.position = absolutePosition;
  return next;
}

function cleanCanvasEdges(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasEdge[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  return edges.filter((edge) => {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) return false;
    if (isGroupNode(nodeById.get(edge.source)) || isGroupNode(nodeById.get(edge.target))) return false;
    if (seen.has(edge.id)) return false;
    seen.add(edge.id);
    return true;
  });
}

/** 节点的绝对坐标；兼容历史数据里意外出现的多层 parent，带循环保护。 */
export function absoluteNodePosition(nodes: CanvasNode[], node: CanvasNode): CanvasPoint {
  const nodeById = new Map(nodes.map((item) => [item.id, item]));
  let x = finiteNumber(node.position?.x, 0);
  let y = finiteNumber(node.position?.y, 0);
  const visited = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    const parent = nodeById.get(parentId);
    if (!parent) break;
    visited.add(parentId);
    x += finiteNumber(parent.position?.x, 0);
    y += finiteNumber(parent.position?.y, 0);
    parentId = parent.parentId;
  }
  return { x, y };
}

/** 把成员从组里摘成顶层节点，同时保持屏幕上的绝对位置不变。 */
export function detachCanvasNode(nodes: CanvasNode[], node: CanvasNode): CanvasNode {
  return stripParent(node, absoluteNodePosition(nodes, node));
}

export function collectCanvasGroupMembers(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const group = nodes.find((node) => node.id === groupId);
  if (!isGroupNode(group)) return [];
  return nodes.filter((node) => node.id !== groupId && node.parentId === groupId && !isGroupNode(node));
}

/**
 * 整理布局使用的顶层图：组是一个整体，组内成员不单独参与排版。
 * 组内连线忽略；跨组边折叠到组根，保证整理后仍按原有拓扑排列。
 */
export function canvasTidyGraph(nodes: CanvasNode[], edges: CanvasEdge[]): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const groupIds = new Set(nodes.filter(isGroupNode).map((node) => node.id));
  const topLevelNodes = nodes.filter((node) => !node.parentId || !groupIds.has(node.parentId));
  const topLevelIds = new Set(topLevelNodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const rootOf = (nodeId: string): string => {
    const node = nodeById.get(nodeId);
    return node?.parentId && groupIds.has(node.parentId) ? node.parentId : nodeId;
  };
  const seen = new Set<string>();
  const tidyEdges: CanvasEdge[] = [];
  for (const edge of edges) {
    const source = rootOf(edge.source);
    const target = rootOf(edge.target);
    if (source === target || !topLevelIds.has(source) || !topLevelIds.has(target)) continue;
    const key = `${source}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tidyEdges.push({ id: `tidy:${key}`, source, target });
  }
  return { nodes: topLevelNodes, edges: tidyEdges };
}

function normalizeGroupLabel(value: unknown): string {
  return String(value || '').trim() || '未命名编组';
}

function normalizeGroupColor(value: unknown): CanvasGroupColor {
  return CANVAS_GROUP_COLORS.includes(value as CanvasGroupColor) ? value as CanvasGroupColor : 'neutral';
}

function removeCanvasNodes(nodes: CanvasNode[], edges: CanvasEdge[], removedIds: Set<string>): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  const nextNodes = nodes.filter((node) => !removedIds.has(node.id));
  const nextEdges = edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target));
  return normalizeCanvasGroups(nextNodes, nextEdges);
}

/**
 * 把一组顶层节点收进单个编组。成员位置改为相对坐标，数组顺序保证父组先于成员。
 */
export function createCanvasGroupGraph(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  memberIds: string[],
  options: { groupId?: string; label?: string; color?: CanvasGroupColor } = {},
): CanvasGroupGraph {
  const requested = new Set(memberIds);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const members = nodes.filter((node) => (
    requested.has(node.id)
    && !isGroupNode(node)
    && (!node.parentId || !isGroupNode(nodeById.get(node.parentId)))
  ));
  const groupId = options.groupId || createId('group');
  const label = normalizeGroupLabel(options.label);
  const color = normalizeGroupColor(options.color);

  if (members.length === 0) {
    const normalized = normalizeCanvasGroups(nodes, edges);
    return { nodes: normalized.nodes, edges: normalized.edges, groupId };
  }

  const memberBounds = members.map((node) => {
    const position = absoluteNodePosition(nodes, node);
    return {
      node,
      position,
      right: position.x + nodeWidth(node),
      bottom: position.y + nodeHeight(node),
    };
  });
  const minX = Math.min(...memberBounds.map((item) => item.position.x));
  const minY = Math.min(...memberBounds.map((item) => item.position.y));
  const maxX = Math.max(...memberBounds.map((item) => item.right));
  const maxY = Math.max(...memberBounds.map((item) => item.bottom));
  const groupPosition = {
    x: minX - CANVAS_GROUP_PADDING,
    y: minY - CANVAS_GROUP_HEADER_HEIGHT - CANVAS_GROUP_PADDING,
  };
  const group: CanvasNode = {
    id: groupId,
    type: 'canvas-group',
    position: groupPosition,
    width: Math.max(CANVAS_GROUP_MIN_WIDTH, maxX - minX + CANVAS_GROUP_PADDING * 2),
    height: Math.max(
      CANVAS_GROUP_MIN_HEIGHT,
      maxY - minY + CANVAS_GROUP_HEADER_HEIGHT + CANVAS_GROUP_PADDING * 2,
    ),
    data: {
      kind: 'group',
      label,
      groupColor: color,
    },
  };
  const memberIdSet = new Set(members.map((node) => node.id));
  const groupedNodes = nodes.map((node) => {
    if (!memberIdSet.has(node.id)) return node;
    const absolute = absoluteNodePosition(nodes, node);
    return {
      ...node,
      position: { x: absolute.x - groupPosition.x, y: absolute.y - groupPosition.y },
      parentId: groupId,
      expandParent: false,
    };
  });
  const normalized = normalizeCanvasGroups([group, ...groupedNodes], edges);
  return { nodes: normalized.nodes, edges: normalized.edges, groupId };
}

/** 解散后成员回到绝对坐标并恢复为顶层节点。 */
export function dissolveCanvasGroup(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  groupId: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const group = nodes.find((node) => node.id === groupId);
  if (!isGroupNode(group)) return normalizeCanvasGroups(nodes, edges);
  const nextNodes = nodes
    .filter((node) => node.id !== groupId)
    .map((node) => (
      node.parentId === groupId
        ? stripParent(node, absoluteNodePosition(nodes, node))
        : node
    ));
  return normalizeCanvasGroups(nextNodes, edges.filter((edge) => edge.source !== groupId && edge.target !== groupId));
}

/** 删除组会按已确认规则同时删除直接成员。 */
export function deleteCanvasGroup(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  groupId: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (!isGroupNode(nodes.find((node) => node.id === groupId))) return normalizeCanvasGroups(nodes, edges);
  const removedIds = new Set([groupId, ...collectCanvasGroupMembers(nodes, groupId).map((node) => node.id)]);
  return removeCanvasNodes(nodes, edges, removedIds);
}

/**
 * 编组数据总兜底：一层父子关系、颜色/尺寸/名称、空组、越界成员、悬空边和数组顺序。
 * 越界成员只修组框与相对坐标，成员的绝对视觉位置保持不变。
 */
export function normalizeCanvasGroups(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const source = Array.isArray(nodes) ? nodes : [];
  const sourceEdges = Array.isArray(edges) ? edges : [];
  const groups = new Map<string, CanvasNode>();

  for (const node of source) {
    if (!isGroupNode(node)) continue;
    const { parentId: _parentId, extent: _extent, expandParent: _expandParent, ...groupNode } = node;
    groups.set(node.id, {
      ...groupNode,
      type: 'canvas-group',
      position: {
        x: finiteNumber(node.position?.x, 0),
        y: finiteNumber(node.position?.y, 0),
      },
      width: Math.max(CANVAS_GROUP_MIN_WIDTH, finiteNumber(node.width, CANVAS_GROUP_MIN_WIDTH)),
      height: Math.max(CANVAS_GROUP_MIN_HEIGHT, finiteNumber(node.height, CANVAS_GROUP_MIN_HEIGHT)),
      data: {
        ...node.data,
        kind: 'group',
        label: normalizeGroupLabel(node.data?.label),
        groupColor: normalizeGroupColor(node.data?.groupColor),
      },
    });
  }

  const absolutePositions = new Map<string, CanvasPoint>();
  const normalizedNodes = source
    .filter((node) => !isGroupNode(node))
    .map((node) => {
      const parentId = node.parentId && groups.has(node.parentId) ? node.parentId : undefined;
      const position = {
        x: finiteNumber(node.position?.x, 0),
        y: finiteNumber(node.position?.y, 0),
      };
      if (!parentId) return stripParent({ ...node, position });
      const parent = groups.get(parentId)!;
      const { extent: _extent, ...childNode } = node;
      absolutePositions.set(node.id, {
        x: parent.position.x + position.x,
        y: parent.position.y + position.y,
      });
      return {
        ...childNode,
        position,
        parentId,
        expandParent: false,
      };
    });

  for (const [groupId, group] of groups) {
    const members = normalizedNodes.filter((node) => node.parentId === groupId);
    if (members.length === 0) {
      groups.delete(groupId);
      continue;
    }
    const absolute = members.map((node) => {
      const position = {
        x: group.position.x + finiteNumber(node.position.x, 0),
        y: group.position.y + finiteNumber(node.position.y, 0),
      };
      return { node, position, right: position.x + nodeWidth(node), bottom: position.y + nodeHeight(node) };
    });
    const minX = Math.min(...absolute.map((item) => item.position.x));
    const minY = Math.min(...absolute.map((item) => item.position.y));
    const maxX = Math.max(...absolute.map((item) => item.right));
    const maxY = Math.max(...absolute.map((item) => item.bottom));
    const groupRight = group.position.x + Number(group.width);
    const groupBottom = group.position.y + Number(group.height);
    const nextX = Math.min(group.position.x, minX - CANVAS_GROUP_PADDING);
    const nextY = Math.min(group.position.y, minY - CANVAS_GROUP_HEADER_HEIGHT - CANVAS_GROUP_PADDING);
    const nextRight = Math.max(groupRight, maxX + CANVAS_GROUP_PADDING);
    const nextBottom = Math.max(groupBottom, maxY + CANVAS_GROUP_PADDING);
    groups.set(groupId, {
      ...group,
      position: { x: nextX, y: nextY },
      width: Math.max(CANVAS_GROUP_MIN_WIDTH, nextRight - nextX),
      height: Math.max(CANVAS_GROUP_MIN_HEIGHT, nextBottom - nextY),
    });
  }

  const finalNodes = normalizedNodes.map((node) => {
    if (!node.parentId || !groups.has(node.parentId)) return { ...stripParent(node), zIndex: node.zIndex ?? 100 };
    const group = groups.get(node.parentId)!;
    const absolute = absolutePositions.get(node.id) || {
      x: group.position.x + node.position.x,
      y: group.position.y + node.position.y,
    };
    return {
      ...node,
      position: { x: absolute.x - group.position.x, y: absolute.y - group.position.y },
      parentId: group.id,
      expandParent: false,
      zIndex: node.zIndex ?? 100,
    };
  });

  const ordered = [
    ...groups.values(),
    ...finalNodes,
  ];
  return { nodes: ordered, edges: cleanCanvasEdges(ordered, sourceEdges) };
}

/** 最近更新的画布 id：启动兜底定位用。 */
function newestCanvasId(canvases: CanvasDoc[]): string {
  return canvases.reduce((best, doc) => (
    !best || Date.parse(doc.updatedAt || '') > Date.parse(best.updatedAt || '') ? doc : best
  ), canvases[0])?.id || '';
}

function emptyCanvas(name: string): CanvasDoc {
  return { id: createId('canvas'), name, nodes: [], edges: [], updatedAt: new Date().toISOString() };
}

function touch(doc: CanvasDoc, patch: Partial<CanvasDoc>): CanvasDoc {
  return { ...doc, ...patch, updatedAt: new Date().toISOString() };
}

function normalizeCanvasDoc(doc: CanvasDoc): CanvasDoc {
  const graph = normalizeCanvasGroups(doc.nodes || [], doc.edges || []);
  return { ...doc, ...graph };
}

function isVideoTerminalNode(node: CanvasNode | undefined): boolean {
  return node?.data?.kind === 'video'
    && node.data.videoStatus === 'done'
    && Boolean(String(node.data.videoUrl || '').trim());
}

function pickVideoTerminalFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    'videoStatus', 'videoProgress', 'videoUrl', 'videoFileName', 'videoTaskId',
    'videoError', 'videoSubmissionUnknown', 'finishedAt', 'createdAt',
  ]) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

/**
 * 视频终态保护：胜出文档里某节点缺 videoUrl，而另一份文档里同 id 节点已 done+url，
 * 就把终态字段补回来。避免「本地旧快照 updatedAt 更新 → 覆盖服务端刚生成的视频」。
 *
 * 用户主动重新生成时 createdAt 会刷新到完成时间之后，此时不补，允许清空旧视频。
 */
export function protectVideoTerminalNodes(chosen: CanvasDoc, other: CanvasDoc): CanvasDoc {
  if (!Array.isArray(chosen.nodes) || !Array.isArray(other.nodes) || other.nodes.length === 0) return chosen;
  const otherById = new Map(other.nodes.map((node) => [node.id, node]));
  let changed = false;
  const nodes = chosen.nodes.map((node) => {
    const alternate = otherById.get(node.id);
    if (!alternate || !isVideoTerminalNode(alternate) || isVideoTerminalNode(node)) return node;
    const previousDoneAt = Date.parse(String(alternate.data.finishedAt || alternate.data.createdAt || ''));
    const incomingStartedAt = Date.parse(String(node.data.createdAt || ''));
    if (Number.isFinite(previousDoneAt) && Number.isFinite(incomingStartedAt) && incomingStartedAt > previousDoneAt) {
      return node;
    }
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        ...(pickVideoTerminalFields(alternate.data as unknown as Record<string, unknown>) as Partial<CanvasNodeData>),
      },
    };
  });
  return changed ? { ...chosen, nodes } : chosen;
}

/** 旧版本可能已经把图片 dataURL 写进本地快照；配额不足时只压缩本地副本。 */
export function compactCanvasPersistedValue(value: string): string {
  try {
    const parsed = JSON.parse(value) as { state?: { canvases?: CanvasDoc[] } };
    if (!Array.isArray(parsed.state?.canvases)) return value;
    const compact = JSON.parse(JSON.stringify(parsed)) as { state: { canvases: CanvasDoc[] } };
    compact.state.canvases = compact.state.canvases.map((canvas) => ({
      ...canvas,
      nodes: canvas.nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          referenceDataUrl: String(node.data.referenceDataUrl || '').startsWith('data:image/') ? '' : node.data.referenceDataUrl,
          imageUrl: String(node.data.imageUrl || '').startsWith('data:image/') ? '' : node.data.imageUrl,
          versions: Array.isArray(node.data.versions)
            ? node.data.versions.map((version) => ({
              ...version,
              imageUrl: String(version.imageUrl || '').startsWith('data:image/') ? '' : version.imageUrl,
            }))
            : node.data.versions,
          references: Array.isArray(node.data.references)
            ? node.data.references.map((reference) => ({
              ...reference,
              url: String(reference.url || '').startsWith('data:image/') ? '' : reference.url,
            }))
            : node.data.references,
        },
      })),
    }));
    return JSON.stringify(compact);
  } catch {
    return value;
  }
}

function canvasStorage(): StateStorage {
  if (typeof localStorage === 'undefined') {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => { memory.set(key, value); },
      removeItem: (key) => { memory.delete(key); },
    };
  }
  return {
    getItem: (key) => localStorage.getItem(key),
    removeItem: (key) => localStorage.removeItem(key),
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name !== 'QuotaExceededError' && name !== 'NS_ERROR_DOM_QUOTA_REACHED') return;
        try {
          localStorage.setItem(key, compactCanvasPersistedValue(value));
        } catch {
          console.warn('[绘板] 本地画布缓存已满，已依赖 bridge 画布副本');
        }
      }
    },
  };
}

export const useCanvasStore = create<CanvasState>()(
  persist(
    (set, get) => ({
      canvases: [emptyCanvas('默认画布')],
      activeId: '',
      cursor: { x: 80, y: 80 },

      createCanvas: (name) => {
        const doc = emptyCanvas(name?.trim() || `画布 ${get().canvases.length + 1}`);
        set((state) => ({ canvases: [...state.canvases, doc], activeId: doc.id }));
        void registerCanvas(doc.id, doc.name);
        return doc.id;
      },

      renameCanvas: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({ canvases: state.canvases.map((doc) => (doc.id === id ? touch(doc, { name: trimmed }) : doc)) }));
        void registerCanvas(id, trimmed);
      },

      deleteCanvas: (id) => {
        set((state) => {
          if (state.canvases.length <= 1) return state;
          const canvases = state.canvases.filter((doc) => doc.id !== id);
          return {
            canvases,
            activeId: state.activeId === id ? canvases[0].id : state.activeId,
          };
        });
      },

      setActive: (id) => set({ activeId: id }),

      addNode: (node) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId
              ? touch(doc, normalizeCanvasGroups([...doc.nodes, node], doc.edges))
              : doc
          )),
        }));
      },

      updateNode: (id, patch) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId
              ? touch(doc, normalizeCanvasGroups(
                doc.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)),
                doc.edges,
              ))
              : doc
          )),
        }));
      },

      removeNode: (id) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId
              ? touch(doc, isGroupNode(doc.nodes.find((node) => node.id === id))
                ? deleteCanvasGroup(doc.nodes, doc.edges, id)
                : normalizeCanvasGroups(
                  doc.nodes.filter((node) => node.id !== id),
                  doc.edges.filter((edge) => edge.source !== id && edge.target !== id),
                ))
              : doc
          )),
        }));
      },

      setGraph: (nodes, edges) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId ? touch(doc, normalizeCanvasGroups(nodes, edges)) : doc
          )),
        }));
      },

      // 补 MCP / 对话生成的新节点，并合并已有节点的版本链。
      // 定位历史消息时本地节点可能比 bridge 旧；只追加版本不会覆盖用户本地的位置和选择态，
      // 但能让 locateChatRef 找到消息对应的旧版本并切回去。
      mergeCanvasNodes: (canvasId, additions) => set((state) => ({
        canvases: state.canvases.map((doc) => {
          if (doc.id !== canvasId || additions.length === 0) return doc;
          const known = new Set(doc.nodes.map((node) => node.id));
          const fresh = additions.filter((node) => !known.has(node.id));
          const incoming = new Map(additions.map((node) => [node.id, node]));
          let changed = fresh.length > 0;
          const nodes = doc.nodes.map((node) => {
            const remote = incoming.get(node.id);
            if (!remote) return node;
            const localVersions = Array.isArray(node.data.versions) ? node.data.versions : [];
            const remoteVersions = Array.isArray(remote.data.versions) ? remote.data.versions : [];
            if (remoteVersions.length === 0) return node;
            const seen = new Set(localVersions.map((version) => String(version.id || '')));
            const mergedVersions = [...localVersions];
            let nodeChanged = false;
            for (const version of remoteVersions) {
              const id = String(version.id || '');
              if (!id || seen.has(id)) continue;
              seen.add(id);
              mergedVersions.push(version);
              nodeChanged = true;
              changed = true;
            }
            return nodeChanged
              ? { ...node, data: { ...node.data, versions: mergedVersions } }
              : node;
          });
          return changed ? touch(doc, normalizeCanvasGroups([...nodes, ...fresh], doc.edges)) : doc;
        }),
      })),

      /** 合并服务端文档：同 id 取 updatedAt 较新的一侧，只在本地有的保持原位。 */
      mergeCanvases: (remote) => set((state) => {
        const merged = state.canvases.slice();
        for (const doc of remote) {
          const index = merged.findIndex((item) => item.id === doc.id);
          if (index === -1) {
            merged.push(normalizeCanvasDoc(doc));
            continue;
          }
          const local = merged[index];
          const remoteNewer = Date.parse(doc.updatedAt || '') > Date.parse(local.updatedAt || '');
          // 按 updatedAt 选整份文档，但视频终态永远以「已出成品」的那份为准：
          // 旧快照的 updatedAt 可能更新，却不该把刚生成的视频冲掉。
          merged[index] = normalizeCanvasDoc(remoteNewer
            ? protectVideoTerminalNodes(doc, local)
            : protectVideoTerminalNodes(local, doc));
        }
        return {
          canvases: merged,
          activeId: merged.some((doc) => doc.id === state.activeId)
            ? state.activeId
            : (newestCanvasId(merged)),
        };
      }),

      /** 本地还是一张空默认画布时，整体采用服务端列表（按最近更新排序），不再留空画布占位。 */
      adoptCanvases: (remote) => set(() => ({
        canvases: remote
          .slice()
          .map(normalizeCanvasDoc)
          .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')),
        activeId: newestCanvasId(remote),
      })),

      setViewport: (viewport) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (doc.id === state.activeId ? touch(doc, { viewport }) : doc)),
        }));
      },

      advanceCursor: (dx, dy) => set((state) => ({ cursor: { x: state.cursor.x + dx, y: state.cursor.y + dy } })),

      activeCanvas: () => {
        const state = get();
        return state.canvases.find((doc) => doc.id === state.activeId) || state.canvases[0];
      },
    }),
    {
      name: 'huiban:canvases:v2',
      version: 2,
      storage: createJSONStorage(() => canvasStorage()),
      partialize: (state) => ({
        canvases: state.canvases.map((canvas) => ({
          ...canvas,
          nodes: canvas.nodes.map((node) => {
            const persistent = { ...node } as typeof node & {
              selected?: boolean;
              dragging?: boolean;
              className?: string;
            };
            delete persistent.selected;
            delete persistent.dragging;
            delete persistent.className;
            return persistent;
          }),
        })),
        activeId: state.activeId,
      }),
      onRehydrateStorage: () => (state) => {
        // 持久化里没有 activeId（或指向已删除画布）时落到第一张
        if (state) state.canvases = state.canvases.map(normalizeCanvasDoc);
        if (state && (!state.activeId || !state.canvases.some((doc) => doc.id === state.activeId))) {
          state.activeId = state.canvases[0]?.id || '';
        }
      },
    },
  ),
);
