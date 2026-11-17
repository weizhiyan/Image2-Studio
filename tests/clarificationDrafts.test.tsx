import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ClarificationModal, { serializeClarificationAnswers } from '@/components/chat/ClarificationModal';
import { clearClarificationDraft, readClarificationDraft, saveClarificationDraft } from '@/lib/clarificationDrafts';
import { normalizeAskUserQuestions } from '../bridge/agent';

afterEach(() => vi.unstubAllGlobals());

describe('澄清草稿与委托', () => {
  it('按 run 和问题隔离保存，提交前保留草稿，成功后清除', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    const draft = { answers: { style: ['warm'] }, otherDrafts: { text: '山间来信' }, skipped: [], activeIndex: 1 };
    saveClarificationDraft('run-a:call', draft);
    expect(readClarificationDraft('run-a:call')).toEqual(draft);
    expect(readClarificationDraft('run-b:call')).toBeUndefined();
    storage.set('huiban:clarification:reloaded:call', JSON.stringify(draft));
    expect(readClarificationDraft('reloaded:call')).toEqual(draft);
    clearClarificationDraft('run-a:call');
    expect(readClarificationDraft('run-a:call')).toBeUndefined();
    expect(storage.has('huiban:clarification:run-a:call')).toBe(false);
  });

  it('创作题添加委托选项，必要事实不允许代填；最多两题', () => {
    const questions = normalizeAskUserQuestions([
      { id: 'style', title: '希望什么感觉？', purpose: 'creative', type: 'multiple', options: [{ label: '温暖', value: 'warm', recommended: true }] },
      { id: 'text', title: '品牌名字是什么？', type: 'text' },
      { id: 'third', title: '不应继续追问', type: 'text' },
    ]);
    expect(questions).toHaveLength(2);
    expect(questions[0].options.some((option) => option.value === '让 AI 决定')).toBe(true);
    expect(questions[1].options.some((option) => option.value === '让 AI 决定')).toBe(false);
    expect(serializeClarificationAnswers(questions, { style: ['warm', '让 AI 决定'] }, { text: '山间来信' })).toEqual({ style: ['让 AI 决定'], text: ['山间来信'] });
    const html = renderToStaticMarkup(<ClarificationModal request={{ callId: 'render', questions }} onSubmit={async () => true} onCancel={async () => true} />);
    expect(html).not.toContain('checked=');
    expect(html).toContain('取消任务');
    expect(html).toContain('收起');
    expect(html).not.toContain('role="dialog"');
  });
});
