type HistoryCanvas = {
  name?: string;
  nodes?: unknown[];
};

type HistoryNode = {
  id?: unknown;
  data?: Record<string, unknown>;
};

export interface HistoryDeleteTarget {
  key?: string;
  canvasId: string;
  nodeId: string;
  versionId?: string;
  mediaType?: string;
  fileName?: string;
  url?: string;
}

export interface CanvasHistoryDeletion {
  changed: boolean;
  nodeDeleted: boolean;
  removedFileNames: string[];
}

interface DeletableCanvasDoc {
  nodes?: unknown[];
  edges?: unknown[];
  updatedAt?: string;
  deletedNodeIds?: Record<string, string>;
}

interface DeletableThread {
  messages?: unknown[];
  memory?: Record<string, unknown>;
  revision?: number;
  updatedAt?: string;
}

const IMAGE_VERSION_FIELDS = [
  'imageUrl', 'fileName', 'prompt', 'model', 'size', 'width', 'height',
  'createdAt', 'finishedAt', 'enhancedPrompt', 'originalPrompt', 'enhancementWarning',
  'revisedPrompt', 'responseId', 'imageGenerationCallId', 'responseModel', 'responseProfileId',
] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textOf(value: unknown): string {
  return String(value || '').trim();
}

/** 前端传上来的删除目标做一次白名单清洗，避免把任意路径或字段带进写操作。 */
export function normalizeHistoryDeleteTargets(raw: unknown): HistoryDeleteTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: HistoryDeleteTarget[] = [];
  for (const item of raw) {
    const value = recordOf(item);
    if (!value) continue;
    const canvasId = textOf(value.canvasId);
    const nodeId = textOf(value.nodeId);
    if (!canvasId || !nodeId) continue;
    const versionId = textOf(value.versionId);
    const key = textOf(value.key) || `${canvasId}:${nodeId}:${versionId || 'current'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      key,
      canvasId,
      nodeId,
      ...(versionId ? { versionId } : {}),
      ...(textOf(value.mediaType) ? { mediaType: textOf(value.mediaType) } : {}),
      ...(textOf(value.fileName) ? { fileName: textOf(value.fileName) } : {}),
      ...(textOf(value.url) ? { url: textOf(value.url) } : {}),
    });
  }
  return targets;
}

function mediaMatchesTarget(item: unknown, target: HistoryDeleteTarget): boolean {
  const value = recordOf(item);
  if (!value || textOf(value.nodeId) !== target.nodeId) return false;
  const versionId = textOf(value.versionId);
  const url = textOf(value.url);
  const fileName = textOf(value.fileName);
  if (target.versionId && versionId && versionId !== target.versionId) return false;
  if (target.url && url && url !== target.url) return false;
  if (target.fileName && fileName && fileName !== target.fileName) return false;
  // 老记录可能没有 versionId：用文件地址/文件名把同一版本认出来。
  if (target.versionId && !versionId) {
    if (target.url) return url === target.url;
    if (target.fileName) return fileName === target.fileName;
  }
  return true;
}

function removeNode(doc: DeletableCanvasDoc, nodeId: string, now: string): boolean {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  if (!nodes.some((item) => textOf(recordOf(item)?.id) === nodeId)) return false;
  doc.nodes = nodes.filter((item) => textOf(recordOf(item)?.id) !== nodeId);
  doc.edges = (Array.isArray(doc.edges) ? doc.edges : []).filter((item) => {
    const edge = recordOf(item);
    return textOf(edge?.source) !== nodeId && textOf(edge?.target) !== nodeId;
  });
  doc.deletedNodeIds = { ...(doc.deletedNodeIds || {}), [nodeId]: now };
  return true;
}

function removeNodeReferences(nodes: unknown[], target: HistoryDeleteTarget): boolean {
  let changed = false;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = recordOf(nodes[index]);
    const data = recordOf(node?.data);
    if (!node || !data) continue;
    const patch: Record<string, unknown> = {};
    if (Array.isArray(data.references)) {
      const references = data.references.filter((item) => {
        const ref = recordOf(item);
        if (!ref) return true;
        if (textOf(ref.id) === target.nodeId) return false;
        return !target.url || textOf(ref.url) !== target.url;
      });
      if (references.length !== data.references.length) patch.references = references;
    }
    if (Array.isArray(data.referenceOrder)) {
      const order = data.referenceOrder.filter((item) => textOf(item) !== target.nodeId);
      if (order.length !== data.referenceOrder.length) patch.referenceOrder = order;
    }
    if (Object.keys(patch).length === 0) continue;
    nodes[index] = { ...node, data: { ...data, ...patch } };
    changed = true;
  }
  return changed;
}

/** 从画布删除一条历史记录；图片只删对应版本，版本删空才删整个节点。 */
export function removeHistoryTargetFromCanvas(
  doc: DeletableCanvasDoc | undefined,
  target: HistoryDeleteTarget,
  now: string,
): CanvasHistoryDeletion {
  const nodes = Array.isArray(doc?.nodes) ? doc!.nodes : [];
  const node = nodes.find((item) => textOf(recordOf(item)?.id) === target.nodeId);
  const data = recordOf(recordOf(node)?.data);
  if (!doc || !node || !data) {
    return { changed: false, nodeDeleted: false, removedFileNames: target.fileName ? [target.fileName] : [] };
  }
  const removedFileNames: string[] = [];
  if (target.mediaType === 'video' || data.kind === 'video') {
    if (target.fileName || textOf(data.videoFileName)) removedFileNames.push(target.fileName || textOf(data.videoFileName));
    const nodeDeleted = removeNode(doc, target.nodeId, now);
    doc.updatedAt = now;
    return { changed: nodeDeleted, nodeDeleted, removedFileNames };
  }

  const versions = Array.isArray(data.versions)
    ? data.versions as Array<Record<string, unknown>>
    : [];
  if (target.versionId && versions.length > 0) {
    const versionIndex = versions.findIndex((item) => textOf(item.id) === target.versionId);
    if (versionIndex < 0) {
      // 版本号失效（列表快照过期 / 另一处已删）时只当作没命中，
      // 绝不因为当前主图碰巧同 URL 就把整个节点删掉。
      return { changed: false, nodeDeleted: false, removedFileNames: [] };
    } else {
      const [removed] = versions.splice(versionIndex, 1);
      if (textOf(removed?.fileName)) removedFileNames.push(textOf(removed.fileName));
      if (versions.length === 0) {
        removeNode(doc, target.nodeId, now);
        removeNodeReferences(doc.nodes || [], target);
        doc.updatedAt = now;
        return { changed: true, nodeDeleted: true, removedFileNames };
      }
      const activeVersionId = textOf(data.activeVersionId);
      const active = versions.find((item) => textOf(item.id) === activeVersionId) || versions[versions.length - 1];
      const nextData: Record<string, unknown> = { ...data, versions, activeVersionId: textOf(active.id) };
      for (const field of IMAGE_VERSION_FIELDS) {
        if (active[field] === undefined) delete nextData[field];
        else nextData[field] = active[field];
      }
      doc.nodes = nodes.map((item) => textOf(recordOf(item)?.id) === target.nodeId
        ? { ...recordOf(item), data: nextData }
        : item);
      doc.updatedAt = now;
      return { changed: true, nodeDeleted: false, removedFileNames };
    }
  }

  const activeMatches = (!target.url || textOf(data.imageUrl) === target.url)
    && (!target.fileName || textOf(data.fileName) === target.fileName);
  if (!activeMatches) return { changed: false, nodeDeleted: false, removedFileNames: [] };
  if (target.fileName || textOf(data.fileName)) removedFileNames.push(target.fileName || textOf(data.fileName));
  removeNode(doc, target.nodeId, now);
  removeNodeReferences(doc.nodes || [], target);
  doc.updatedAt = now;
  return { changed: true, nodeDeleted: true, removedFileNames };
}

function stripArray(value: unknown, targets: HistoryDeleteTarget[]): { next: unknown[]; changed: boolean } {
  if (!Array.isArray(value)) return { next: [], changed: false };
  const next = value.filter((item) => !targets.some((target) => mediaMatchesTarget(item, target)));
  return { next, changed: next.length !== value.length };
}

/** 删除历史条目时同步清掉对话里的图片引用，避免留下破图或阻塞物理文件删除。 */
export function stripChatMediaReferences<T extends DeletableThread>(
  thread: T,
  targets: HistoryDeleteTarget[],
): { thread: T; changed: boolean } {
  if (targets.length === 0 || !Array.isArray(thread.messages)) return { thread, changed: false };
  let changed = false;
  const messages = thread.messages.map((raw) => {
    const message = recordOf(raw);
    if (!message) return raw;
    const patch: Record<string, unknown> = {};
    const media = stripArray(message.media, targets);
    if (media.changed) patch.media = media.next;
    const attachments = stripArray(message.attachments, targets);
    if (attachments.changed) patch.attachments = attachments.next;
    if (Array.isArray(message.toolCalls)) {
      let callsChanged = false;
      const toolCalls = message.toolCalls.map((rawCall) => {
        const call = recordOf(rawCall);
        if (!call) return rawCall;
        const callMedia = stripArray(call.media, targets);
        if (!callMedia.changed) return rawCall;
        callsChanged = true;
        return { ...call, media: callMedia.next };
      });
      if (callsChanged) patch.toolCalls = toolCalls;
    }
    const retrySource = recordOf(message.retrySource);
    if (retrySource) {
      const retryAttachments = stripArray(retrySource.attachments, targets);
      if (retryAttachments.changed) patch.retrySource = { ...retrySource, attachments: retryAttachments.next };
    }
    if (Object.keys(patch).length === 0) return raw;
    changed = true;
    return { ...message, ...patch };
  });

  let memory = thread.memory;
  const workingSet = recordOf(memory?.visualWorkingSet);
  if (workingSet) {
    const nextWorkingSet = { ...workingSet };
    for (const key of ['base', 'sourceAnchor'] as const) {
      if (recordOf(nextWorkingSet[key]) && targets.some((target) => mediaMatchesTarget(nextWorkingSet[key], target))) {
        delete nextWorkingSet[key];
        changed = true;
      }
    }
    for (const key of ['references', 'recentOutputs'] as const) {
      const list = stripArray(nextWorkingSet[key], targets);
      if (list.changed) {
        nextWorkingSet[key] = list.next;
        changed = true;
      }
    }
    memory = { ...memory, visualWorkingSet: nextWorkingSet };
  }
  return {
    thread: changed ? { ...thread, messages, ...(memory ? { memory } : {}) } as T : thread,
    changed,
  };
}

/** Flatten image versions and completed video nodes into one generation timeline. */
export function collectHistoryItems(
  canvases: Record<string, HistoryCanvas>,
  registry: Record<string, string>,
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const [canvasId, doc] of Object.entries(canvases)) {
    if (!Array.isArray(doc.nodes)) continue;
    for (const node of doc.nodes as HistoryNode[]) {
      const data = node?.data || {};
      const nodeId = String(node?.id || '');
      const base = {
        canvasId,
        canvasName: doc.name || registry[canvasId] || '未命名画布',
        source: String(data.source || 'browser'),
        nodeId,
      };

      if (data.kind === 'video') {
        const url = String(data.videoUrl || '').trim();
        if (data.videoStatus !== 'done' || !url) continue;
        items.push({
          ...base,
          mediaType: 'video',
          url,
          prompt: String(data.prompt || ''),
          model: String(data.videoModel || data.model || ''),
          size: String(data.videoResolution || ''),
          fileName: String(data.videoFileName || ''),
          createdAt: String(data.finishedAt || data.createdAt || ''),
          startedAt: String(data.createdAt || ''),
          finishedAt: String(data.finishedAt || ''),
          videoSeconds: Number(data.videoSeconds || 0),
          videoResolution: String(data.videoResolution || ''),
          videoRatio: String(data.videoRatio || ''),
          videoAudio: data.videoAudio === true,
        });
        continue;
      }

      if (data.kind !== 'image') continue;
      const storedVersions = Array.isArray(data.versions)
        ? data.versions as Array<Record<string, unknown>>
        : [];
      if (storedVersions.length > 0) {
        storedVersions.forEach((version, index) => {
          const url = String(version.imageUrl || '').trim();
          if (!url) return;
          items.push({
            ...base,
            mediaType: 'image',
            url,
            prompt: String(version.prompt || ''),
            enhancedPrompt: String(version.enhancedPrompt || ''),
            revisedPrompt: String(version.revisedPrompt || ''),
            model: String(version.model || ''),
            size: String(version.size || ''),
            fileName: String(version.fileName || ''),
            createdAt: String(version.finishedAt || version.createdAt || ''),
            versionId: String(version.id || ''),
            versionIndex: index + 1,
            versionCount: storedVersions.length,
            baseVersionId: String(version.baseVersionId || ''),
          });
        });
        continue;
      }

      const url = String(data.imageUrl || '').trim();
      if (!url) continue;
      items.push({
        ...base,
        mediaType: 'image',
        url,
        prompt: String(data.prompt || ''),
        enhancedPrompt: String(data.enhancedPrompt || ''),
        revisedPrompt: String(data.revisedPrompt || ''),
        model: String(data.model || ''),
        size: String(data.size || ''),
        fileName: String(data.fileName || ''),
        createdAt: String(data.finishedAt || data.createdAt || ''),
      });
    }
  }

  items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return items.slice(0, 300);
}
