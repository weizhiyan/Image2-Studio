import { useEffect, useRef, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { defaultChatRuntimeSettings, defaultMemorySettings, normalizeChatRuntimeSettings, normalizeMemorySettings } from '@/lib/chatMemorySettings';
import type { ChatRuntimeSettings, MemorySettings } from '@/types';
import './ChatMemorySettings.css';

export interface ChatMemorySettingsProps { onClose: () => void }

const memoryFields: Array<{ key: Exclude<keyof MemorySettings, 'enabled'>; label: string; min: number; max: number; step?: number }> = [
  { key: 'shortTermMessageLimit', label: '近期原文消息数', min: 6, max: 40 },
  { key: 'shortTermTokenBudget', label: '近期原文估算 token 预算', min: 2000, max: 16000, step: 100 },
  { key: 'summaryTriggerTokens', label: '提前压缩阈值（估算 tokens）', min: 4000, max: 24000, step: 100 },
  { key: 'summaryTargetTokens', label: '摘要目标（估算 tokens）', min: 300, max: 1600, step: 100 },
  { key: 'maxRecentOutputs', label: '最近图像候选上限', min: 1, max: 4 },
];
const runtimeFields: Array<{ key: Exclude<keyof ChatRuntimeSettings, 'confirmImagesAbove'>; label: string; min: number; max: number; step?: number }> = [
  { key: 'maxModelRounds', label: '模型回合上限', min: 4, max: 8 },
  { key: 'maxToolCalls', label: '生图工具调用上限', min: 1, max: 2 },
  { key: 'maxImagesPerRun', label: '单次任务图像总上限', min: 1, max: 8 },
  { key: 'maxOutputTokens', label: '每回合文本输出 token 上限', min: 2048, max: 8192, step: 256 },
];

export default function ChatMemorySettings({ onClose }: ChatMemorySettingsProps) {
  const { settings, loading, error: storeError, save } = useSettingsStore();
  const [memory, setMemory] = useState(() => normalizeMemorySettings(settings?.chatMemory));
  const [runtime, setRuntime] = useState(() => normalizeChatRuntimeSettings(settings?.chatRuntime));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const hydrated = useRef(Boolean(settings));
  useEffect(() => {
    if (!settings || hydrated.current) return;
    setMemory(normalizeMemorySettings(settings.chatMemory));
    setRuntime(normalizeChatRuntimeSettings(settings.chatRuntime));
    hydrated.current = true;
  }, [settings]);
  const handleSave = async () => {
    if (!settings || loading || saving) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const chatMemory = normalizeMemorySettings(memory);
      const chatRuntime = normalizeChatRuntimeSettings(runtime);
      await save({ chatMemory, chatRuntime });
      setMemory(chatMemory); setRuntime(chatRuntime);
      setNotice('已保存；设置从后续任务开始生效。');
    } catch (err) { setError(err instanceof Error ? err.message : '保存记忆设置失败'); }
    finally { setSaving(false); }
  };
  return (
    <form className="chat-memory-settings" aria-label="对话记忆设置" onSubmit={(event) => { event.preventDefault(); void handleSave(); }}>
      <div className="chat-memory-settings-scroll">
        <section className="chat-memory-settings-section">
          <div className="chat-memory-settings-row">
            <div><h3>对话记忆</h3><p>{memory.enabled ? '自动保留近期原文，移出窗口前摘要较早内容；原始消息不会删除。' : '已关闭：仅发送有界近期原文，不维护摘要或目标。旧历史仍保留，但不在模型上下文中。'}</p></div>
            <button type="button" role="switch" aria-label="启用对话记忆" aria-checked={memory.enabled} className={`model-config-profile-switch ${memory.enabled ? 'on' : ''}`} disabled={saving || !settings} onClick={() => setMemory((current) => ({ ...current, enabled: !current.enabled }))}>
              <span className="model-config-profile-switch-track" aria-hidden="true"><i /></span>
            </button>
          </div>
          <h4>记忆窗口与压缩</h4>
          <div className="chat-memory-settings-grid">
            {memoryFields.map(({ key, label, min, max, step = 1 }) => <label className="model-config-field" key={key}><span className="model-config-field-label">{label}</span><input type="number" min={min} max={max} step={step} required value={memory[key]} disabled={saving || !settings || !memory.enabled} onChange={(event) => setMemory((current) => ({ ...current, [key]: event.target.value === '' ? '' : Number(event.target.value) } as MemorySettings))} /></label>)}
          </div>
          <p>消息移出窗口也会触发摘要，不必等到阈值；提前阈值不得低于近期预算与摘要目标之和，保存时自动校正。</p>
        </section>
        <section className="chat-memory-settings-section">
          <h3>对话高级设置</h3>
          <p>运行预算独立于记忆参数，默认不增加模型回合或生图次数。</p>
          <h4>运行预算</h4>
          <div className="chat-memory-settings-grid">
            {runtimeFields.map(({ key, label, min, max, step = 1 }) => <label className="model-config-field" key={key}><span className="model-config-field-label">{label}</span><input type="number" min={min} max={max} step={step} required value={runtime[key]} disabled={saving || !settings} onChange={(event) => setRuntime((current) => ({ ...current, [key]: event.target.value === '' ? '' : Number(event.target.value) } as ChatRuntimeSettings))} /></label>)}
          </div>
          <p>单次调用最多 4 张；单任务累计超过 1 张需确认。费用未知，不提供报价，估算 tokens 不是账单或上下文上限。</p>
        </section>
        {error || storeError ? <p className="chat-memory-settings-error" role="alert">{error || storeError}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      <footer className="chat-memory-settings-footer">
        <button type="button" className="chat-memory-settings-reset" disabled={saving || !settings} onClick={() => { setMemory(defaultMemorySettings()); setRuntime(defaultChatRuntimeSettings()); setNotice('已恢复默认草稿，保存后生效。'); }}>恢复默认</button>
        <button type="button" className="model-config-cancel" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="model-config-save" disabled={saving || loading || !settings}>{saving ? '保存中…' : '保存设置'}</button>
      </footer>
    </form>
  );
}
