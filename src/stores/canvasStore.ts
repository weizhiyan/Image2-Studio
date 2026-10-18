import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { StateStorage } from 'zustand/middleware';
import type { CanvasDoc, CanvasEdge, CanvasNode } from '@/types';
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
            doc.id === state.activeId ? touch(doc, { nodes: [...doc.nodes, node] }) : doc
          )),
        }));
      },

      updateNode: (id, patch) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId
              ? touch(doc, { nodes: doc.nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...patch } } : node)) })
              : doc
          )),
        }));
      },

      removeNode: (id) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (
            doc.id === state.activeId
              ? touch(doc, { nodes: doc.nodes.filter((node) => node.id !== id), edges: doc.edges.filter((edge) => edge.source !== id && edge.target !== id) })
              : doc
          )),
        }));
      },

      setGraph: (nodes, edges) => {
        set((state) => ({
          canvases: state.canvases.map((doc) => (doc.id === state.activeId ? touch(doc, { nodes, edges }) : doc)),
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
          return changed ? touch(doc, { nodes: [...nodes, ...fresh] }) : doc;
        }),
      })),

      /** 合并服务端文档：同 id 取 updatedAt 较新的一侧，只在本地有的保持原位。 */
      mergeCanvases: (remote) => set((state) => {
        const merged = state.canvases.slice();
        for (const doc of remote) {
          const index = merged.findIndex((item) => item.id === doc.id);
          if (index === -1) merged.push(doc);
          else if (Date.parse(doc.updatedAt || '') > Date.parse(merged[index].updatedAt || '')) merged[index] = doc;
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
        if (state && (!state.activeId || !state.canvases.some((doc) => doc.id === state.activeId))) {
          state.activeId = state.canvases[0]?.id || '';
        }
      },
    },
  ),
);
