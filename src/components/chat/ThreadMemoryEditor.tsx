import { useState } from 'react';
import type { ChatThread, ChatThreadMemory } from '@/types';
import './ThreadMemoryEditor.css';

export interface ThreadMemoryEditorProps {
  thread: ChatThread;
  busy?: boolean;
  onClose: () => void;
  onSave: (memory: ChatThreadMemory, expectedRevision: number) => Promise<void>;
  onClear: (expectedRevision: number) => Promise<void>;
}

type Goal = NonNullable<ChatThreadMemory['goal']>;
const listFields: Array<{ key: 'confirmed' | 'preserve' | 'change' | 'rejected' | 'openQuestions'; label: string }> = [
  { key: 'preserve', label: '必须保留' },
  { key: 'change', label: '确认修改' },
  { key: 'confirmed', label: '已确认要求' },
  { key: 'rejected', label: '已否决方向' },
  { key: 'openQuestions', label: '待定问题' },
];
const estimate = (text: string) => (text.match(/[㐀-鿿가-힣]/g) || []).length + Math.ceil(text.replace(/[㐀-鿿가-힣]/g, '').length / 4);

// The keyed inner editor takes a stable revision snapshot. A server refresh must
// not silently rebase an unsaved manual edit on a newer revision.
export default function ThreadMemoryEditor(props: ThreadMemoryEditorProps) {
  return <MemoryEditor key={props.thread.id} {...props} />;
}

function MemoryEditor({ thread, busy = false, onClose, onSave, onClear }: ThreadMemoryEditorProps) {
  const [original] = useState<ChatThreadMemory>(() => ({ ...thread.memory, goal: { ...thread.memory?.goal } }));
  const [expectedRevision] = useState(() => thread.memory?.memoryRevision || 0);
  const [summary, setSummary] = useState(original.summary || '');
  const [goal, setGoal] = useState<Goal>(() => ({ ...original.goal }));
  const [lists, setLists] = useState(() => Object.fromEntries(listFields.map(({ key }) => [key, original.goal?.[key]?.join('\n') || ''])) as Record<typeof listFields[number]['key'], string>);
  const [pending, setPending] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [error, setError] = useState('');
  const disabled = busy || pending;
  const revisionChanged = (thread.memory?.memoryRevision || 0) !== expectedRevision;
  const windowCount = thread.memory?.windowMessageCount;
  const windowTokens = thread.memory?.windowEstimatedTokens;
  const updatedAt = thread.memory?.summaryUpdatedAt || thread.memory?.lastCompactionAt;
  const save = async () => {
    if (disabled) return;
    if (revisionChanged) { setError('记忆已在其他位置更新，请返回并重新打开后再编辑，当前草稿未覆盖服务器。'); return; }
    setPending(true); setError('');
    try {
      const nextGoal = { ...goal };
      for (const { key } of listFields) nextGoal[key] = lists[key].split('\n').map((line) => line.trim()).filter(Boolean);
      await onSave({ ...original, summary: summary.trim(), goal: nextGoal }, expectedRevision);
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : '保存记忆失败，请重试；冲突时返回并重新打开。'); }
    finally { setPending(false); }
  };
  const clear = async () => {
    if (disabled) return;
    if (revisionChanged) { setError('记忆已更新，请返回并重新打开后再清除。'); return; }
    setPending(true); setError('');
    try { await onClear(expectedRevision); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : '清除记忆失败，请重试。'); }
    finally { setPending(false); }
  };
  return (
    <form className="thread-memory-editor" aria-label="线程记忆编辑" onSubmit={(event) => { event.preventDefault(); void save(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); if (!disabled) onClose(); } }}>
      <header className="thread-memory-editor-head"><button type="button" onClick={onClose} disabled={disabled}>返回对话</button><h3>对话记忆</h3></header>
      <div className="thread-memory-editor-scroll">
        <p>只影响后续任务，不改变进行中的上下文。</p>
        <dl className="thread-memory-editor-stats">
          <div><dt>当前生效窗口</dt><dd>{windowCount == null ? '暂无运行记录' : `${windowCount} 条消息`}{windowTokens == null ? '' : ` / 约 ${windowTokens} tokens`}</dd></div>
          <div><dt>摘要估算</dt><dd>约 {estimate(summary)} tokens（非计费数据）</dd></div>
          <div><dt>最后更新</dt><dd>{updatedAt || '尚未压缩'}</dd></div>
          <div><dt>压缩状态</dt><dd>{({ idle: '未触发', pending: '待压缩', complete: '已完成', failed: '失败，保留原文' } as const)[thread.memory?.compactionStatus || 'idle']}</dd></div>
        </dl>
        {thread.memory?.warning ? <p className="thread-memory-editor-warning" role="status">{thread.memory.warning}</p> : null}
        <label className="thread-memory-editor-field"><span>早期摘要</span><textarea autoFocus rows={5} maxLength={12000} value={summary} disabled={disabled} onChange={(event) => setSummary(event.target.value)} /></label>
        <label className="thread-memory-editor-field"><span>当前目标</span><textarea rows={2} maxLength={2000} value={goal.statement || ''} disabled={disabled} onChange={(event) => setGoal((current) => ({ ...current, statement: event.target.value }))} /></label>
        <label className="thread-memory-editor-field"><span>交付类型</span><input maxLength={200} value={goal.deliverable || ''} disabled={disabled} onChange={(event) => setGoal((current) => ({ ...current, deliverable: event.target.value }))} /></label>
        {listFields.map(({ key, label }) => <label className="thread-memory-editor-field" key={key}><span>{label}（每行一条，可留空）</span><textarea rows={3} maxLength={6000} value={lists[key]} disabled={disabled} onChange={(event) => setLists((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
        <section className="thread-memory-editor-clear"><p>清除仅影响记忆，不删除历史消息或画布；清除点之前的历史不会自动重新进入记忆或继承图片，显式引用仍可使用。</p>
          {clearOpen ? <div role="group" aria-label="确认清除记忆"><p>清除摘要、当前目标和视觉工作集？</p><button type="button" disabled={disabled} onClick={() => setClearOpen(false)}>保留记忆</button><button type="button" disabled={disabled} onClick={() => void clear()}>确认清除</button></div> : <button type="button" disabled={disabled} onClick={() => setClearOpen(true)}>清除记忆…</button>}
        </section>
        {error || revisionChanged ? <p className="thread-memory-editor-error" role="alert">{error || '记忆已在其他位置更新，请返回并重新打开；当前草稿未被覆盖。'}</p> : null}
      </div>
      <footer className="thread-memory-editor-footer"><button type="button" disabled={disabled} onClick={onClose}>取消</button><button type="submit" className="thread-memory-editor-save" disabled={disabled || revisionChanged}>{pending ? '处理中…' : '保存记忆'}</button></footer>
    </form>
  );
}
