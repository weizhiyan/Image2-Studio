export interface ClarificationDraft {
  answers: Record<string, string[]>;
  otherDrafts: Record<string, string>;
  skipped: string[];
  activeIndex: number;
}

const cache = new Map<string, ClarificationDraft>();
const storageKey = (key: string) => 'huiban:clarification:' + key;

export function readClarificationDraft(key: string): ClarificationDraft | undefined {
  if (cache.has(key)) return cache.get(key);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey(key)) || 'null');
    if (saved && typeof saved.answers === 'object' && typeof saved.otherDrafts === 'object' && Array.isArray(saved.skipped) && Number.isInteger(saved.activeIndex)) return saved;
  } catch { return undefined; }
  return undefined;
}

export function saveClarificationDraft(key: string, draft: ClarificationDraft): void {
  cache.set(key, draft);
  try { sessionStorage.setItem(storageKey(key), JSON.stringify(draft)); } catch { return; }
}

export function clearClarificationDraft(key: string): void {
  cache.delete(key);
  try { sessionStorage.removeItem(storageKey(key)); } catch { return; }
}
