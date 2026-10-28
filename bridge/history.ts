type HistoryCanvas = {
  name?: string;
  nodes?: unknown[];
};

type HistoryNode = {
  id?: unknown;
  data?: Record<string, unknown>;
};

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
