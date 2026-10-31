import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { defaultMemorySettings as bridgeDefaults, normalizeMemorySettings as bridgeNormalize } from '../bridge/chatMemory';
import { defaultChatRuntimeSettings as bridgeRuntime, normalizeChatRuntimeSettings as bridgeNormalizeRuntime } from '../bridge/settings';
import { defaultMemorySettings, normalizeMemorySettings, defaultChatRuntimeSettings, normalizeChatRuntimeSettings } from '../src/lib/chatMemorySettings';
import type { ChatThread } from '../src/types';
import type { ReactElement, ReactNode, SetStateAction } from 'react';

const hooks = vi.hoisted(() => ({ enabled: false, cursor: 0, values: [] as unknown[] }));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useState: (initial: unknown) => {
    if (!hooks.enabled) return react.useState(initial);
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (next: SetStateAction<unknown>) => { hooks.values[index] = typeof next === 'function' ? next(hooks.values[index]) : next; }];
  } };
});

vi.mock('../src/lib/bridge', () => ({ getSettings: vi.fn(), saveSettings: vi.fn() }));
import { saveSettings } from '../src/lib/bridge';
import { useSettingsStore } from '../src/stores/settingsStore';
import ChatMemorySettings from '../src/components/ChatMemorySettings';
import ThreadMemoryEditor from '../src/components/chat/ThreadMemoryEditor';

const thread = { id: 't', title: '测试', messages: [], memory: { memoryRevision: 4, summary: '已确认保留背景', goal: { statement: '包装方案', preserve: ['背景'] }, windowMessageCount: 8, windowEstimatedTokens: 1200, summaryUpdatedAt: '2026-10-30T00:00:00Z' } } as unknown as ChatThread;

beforeEach(() => { useSettingsStore.setState({ settings: null, error: '', loading: false }); vi.clearAllMocks(); hooks.enabled = false; hooks.cursor = 0; hooks.values = []; });

function renderEditor(props: Parameters<typeof ThreadMemoryEditor>[0]): ReactElement {
  hooks.enabled = true; hooks.cursor = 0;
  const element = ThreadMemoryEditor(props);
  return (element.type as (props: typeof element.props) => ReactElement)(element.props);
}
function elements(tree: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const element = tree as ReactElement<Record<string, any>>;
  return [element, ...elements(element.props.children)];
}


describe('memory settings UI and store', () => {
  it('keeps browser pure defaults/normalizers aligned with bridge without importing server modules', () => {
    expect(defaultMemorySettings()).toEqual(bridgeDefaults());
    expect(defaultChatRuntimeSettings()).toEqual(bridgeRuntime());
    for (const input of [{}, { enabled: false, shortTermTokenBudget: 16000, summaryTriggerTokens: 1 }, { maxModelRounds: 99, maxImagesPerRun: 0, maxOutputTokens: NaN }]) {
      expect(normalizeMemorySettings(input)).toEqual(bridgeNormalize(input));
      expect(normalizeChatRuntimeSettings(input)).toEqual(bridgeNormalizeRuntime(input));
    }
    expect(fs.readFileSync(new URL('../src/lib/chatMemorySettings.ts', import.meta.url), 'utf8')).not.toMatch(/from ['"].*bridge/);
  });

  it('renders memory and separate runtime settings, bounded controls and unknown cost', () => {
    const html = renderToStaticMarkup(<ChatMemorySettings onClose={() => {}} />);
    expect(html).toContain('启用对话记忆');
    expect(html).toContain('对话高级设置');
    expect(html).toContain('恢复默认');
    expect(html).toContain('费用未知');
    expect(html).toContain('保存设置');
    expect(html).toContain('max="40"');
    expect(html).toContain('max="8192"');
  });

  it('sends only partial globals through the existing settings save and reports errors', async () => {
    vi.mocked(saveSettings).mockRejectedValueOnce(new Error('保存冲突'));
    await expect(useSettingsStore.getState().save({ chatMemory: { enabled: false }, chatRuntime: { maxImagesPerRun: 2 } })).rejects.toThrow('保存冲突');
    expect(saveSettings).toHaveBeenCalledWith({ chatMemory: { enabled: false }, chatRuntime: { maxImagesPerRun: 2 } });
    expect(useSettingsStore.getState().error).toBe('保存冲突');
  });

  it('keeps a draft on save conflict and passes the revision captured at open', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('409 记忆冲突'));
    const onClose = vi.fn();
    const props = { thread, onSave, onClose, onClear: vi.fn() };
    let tree = renderEditor(props);
    const textareas = elements(tree).filter((element) => element.type === 'textarea');
    textareas[0].props.onChange({ target: { value: '手工摘要' } });
    tree = renderEditor(props);
    elements(tree).find((element) => element.type === 'form')!.props.onSubmit({ preventDefault() {} });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].summary).toBe('手工摘要');
    expect(onSave.mock.calls[0][1]).toBe(4);
    await vi.waitFor(() => expect(elements(renderEditor(props)).find((element) => element.props.role === 'alert')?.props.children).toBe('409 记忆冲突'));
    expect(onClose).not.toHaveBeenCalled();
    const changed = { ...props, thread: { ...thread, memory: { ...thread.memory, memoryRevision: 5 } } };
    tree = renderEditor(changed);
    expect(elements(tree).find((element) => element.props.type === 'submit')!.props.disabled).toBe(true);
    expect(elements(tree).find((element) => element.type === 'textarea')!.props.value).toBe('手工摘要');
  });

  it('requires a second explicit clear action and forwards revision without modifying history', async () => {
    const onClear = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const props = { thread, onClear, onClose, onSave: vi.fn() };
    let tree = renderEditor(props);
    elements(tree).find((element) => element.props.children === '清除记忆…')!.props.onClick();
    expect(onClear).not.toHaveBeenCalled();
    tree = renderEditor(props);
    elements(tree).find((element) => element.props.children === '确认清除')!.props.onClick();
    await vi.waitFor(() => expect(onClear).toHaveBeenCalledWith(4));
    expect(thread.memory?.summary).toBe('已确认保留背景');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders a controlled thread editor with actual window, estimates, brief and non-destructive clear notice', () => {
    const html = renderToStaticMarkup(<ThreadMemoryEditor thread={thread} onClose={() => {}} onSave={async () => {}} onClear={async () => {}} />);
    expect(html).toContain('已确认保留背景');
    expect(html).toContain('包装方案');
    expect(html).toContain('1200');
    expect(html).toContain('8 条消息');
    expect(html).toContain('不删除历史消息或画布');
    expect(html).toContain('保存记忆');
    expect(html).toContain('返回对话');
    const source = fs.readFileSync(new URL('../src/components/chat/ThreadMemoryEditor.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/fetch\(|useChatStore|getThreadMemory/);
    expect(source).toContain('expectedRevision');
    expect(source).toContain('role="alert"');
  });
});
