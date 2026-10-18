import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { draftKeyOf, useChatStore } from '@/stores/chatStore';
import { activeVersionOf, normalizeVersions } from '@/lib/versions';
import { pickTextProfile } from '@/lib/enhance';
import { imageModelOptionsOf } from '@/lib/imageModelOptions';
import { activeProfileOf, useSettingsStore } from '@/stores/settingsStore';
import type { ChatImageRef, ChatModelSelection } from '@/types';
import { createPortal } from 'react-dom';
import { ModelGlyphIcon } from '@/components/canvas/NodeToolbarIcons';
import { chatInlineSegments, chatInlineSignature } from '@/lib/chatInlineRefs';
import { CloseGlyphIcon, SendGlyphIcon, StopGlyphIcon } from './ChatIcons';
import './ChatPanel.css';

/**
 * 对话输入区（方案 §9）：引用 chips（可拖拽换序）+ 自适应文本框 + 发送 / 停止。
 *
 * 引用入口：AI 对话面板打开后点击画布节点（CanvasPage 侧），或在输入框输入 @ 打开选择器。
 * chips 数据在 chatStore 的 draftAttachments（版本级引用），发送时整份交给 CanvasPage
 * 起 agent run；运行中发送按钮变为停止。
 */

interface PickerEntry {
  key: string;
  nodeId: string;
  versionId?: string;
  url: string;
  title: string;
  versionLabel?: string;
}

interface InlinePreview {
  reference: ChatImageRef;
  left: number;
  top: number;
}

const mentionPattern = /(?:^|[\s，。！？；：])@([^\s@]*)$/;
const INLINE_REF_SENTINEL = '\u200B';

function withoutInlineRefSentinels(value: string): string {
  return value.split(INLINE_REF_SENTINEL).join('');
}

function textFromEditorFragment(root: Node): string {
  let text = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += withoutInlineRefSentinels(node.textContent || '');
      return;
    }
    if (node instanceof HTMLElement && node.hasAttribute('data-chat-ref-key')) return;
    if (node instanceof HTMLBRElement) {
      text += '\n';
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return text;
}

function readInlineEditor(root: HTMLElement, attachments: ChatImageRef[]) {
  let text = '';
  const positions = new Map<string, number>();
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += withoutInlineRefSentinels(node.textContent || '');
      return;
    }
    if (node instanceof HTMLElement && node.dataset.chatRefKey) {
      positions.set(node.dataset.chatRefKey, text.length);
      return;
    }
    if (node instanceof HTMLBRElement) {
      text += '\n';
      return;
    }
    const isBlock = node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P');
    if (isBlock && text.length > 0 && !text.endsWith('\n')) text += '\n';
    node.childNodes.forEach(walk);
    if (isBlock && !text.endsWith('\n')) text += '\n';
  };
  root.childNodes.forEach(walk);
  if (text.endsWith('\n') && root.lastElementChild?.tagName === 'DIV' && !root.lastElementChild.textContent) {
    text = text.slice(0, -1);
  }
  const references = attachments
    .filter((reference) => positions.has(draftKeyOf(reference)))
    .map((reference) => ({ ...reference, position: positions.get(draftKeyOf(reference)) || 0 }));
  return { text, references };
}

function caretTextOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return root.textContent?.length || 0;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode as Node, selection.anchorOffset);
  return textFromEditorFragment(range.cloneContents()).length;
}

function setEditorCaretOffset(root: HTMLElement, targetOffset: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[data-chat-ref-key]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let offset = 0;
  let lastText: Text | null = null;
  while (walker.nextNode()) {
    const textNode = walker.currentNode as Text;
    const rawText = textNode.textContent || '';
    const isSentinel = rawText === INLINE_REF_SENTINEL;
    const length = isSentinel ? 0 : withoutInlineRefSentinels(rawText).length;
    lastText = textNode;
    if (offset + length >= targetOffset) {
      const range = document.createRange();
      range.setStart(textNode, isSentinel ? 0 : Math.max(0, targetOffset - offset));
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    offset += length;
  }
  const range = document.createRange();
  if (lastText) range.setStart(lastText, lastText.textContent?.length || 0);
  else range.selectNodeContents(root);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function renderInlineEditor(root: HTMLElement, text: string, attachments: ChatImageRef[]) {
  root.replaceChildren();
  for (const segment of chatInlineSegments(text, attachments)) {
    if (segment.type === 'text') {
      if (segment.text) root.append(document.createTextNode(segment.text));
      continue;
    }
    const reference = segment.reference;
    const key = draftKeyOf(reference);
    const token = document.createElement('span');
    token.className = 'hb-chat-inline-ref is-editor';
    token.contentEditable = 'false';
    token.dataset.chatRefKey = key;
    token.title = reference.title || '引用图片';
    const image = document.createElement('img');
    image.src = reference.url || '';
    image.alt = '';
    const label = document.createElement('span');
    label.textContent = Array.from(reference.title || '图片').slice(0, 4).join('');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.removeChatRef = key;
    remove.setAttribute('aria-label', `移除引用 ${reference.title || '图片'}`);
    remove.innerHTML = '<span aria-hidden="true">×</span>';
    token.append(image, label, remove);
    // Safari 对 contenteditable=false 的 inline-flex 节点前后不总是提供可落点的 caret。
    // 两侧放零宽占位，保证图片可以像一个字符一样被定位、删除和继续输入。
    root.append(document.createTextNode(INLINE_REF_SENTINEL));
    root.append(token);
    root.append(document.createTextNode(INLINE_REF_SENTINEL));
  }
}

function siblingInlineReference(node: Node, direction: 'backward' | 'forward'): HTMLElement | null {
  let sibling = direction === 'backward' ? node.previousSibling : node.nextSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement && sibling.dataset.chatRefKey) return sibling;
    if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent === INLINE_REF_SENTINEL) {
      sibling = direction === 'backward' ? sibling.previousSibling : sibling.nextSibling;
      continue;
    }
    return null;
  }
  return null;
}

function inlineReferenceAdjacentToCaret(root: HTMLElement, direction: 'backward' | 'forward'): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode)) return null;
  const node = selection.anchorNode;
  const offset = selection.anchorOffset;
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    const index = direction === 'backward' ? offset - 1 : offset;
    if (index >= 0 && index < text.length && text[index] !== INLINE_REF_SENTINEL) return null;
    return siblingInlineReference(node, direction);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const childIndex = direction === 'backward' ? offset - 1 : offset;
    const child = node.childNodes[childIndex];
    if (!child) return null;
    if (child instanceof HTMLElement && child.dataset.chatRefKey) return child;
    if (child.nodeType === Node.TEXT_NODE && child.textContent === INLINE_REF_SENTINEL) {
      return siblingInlineReference(child, direction);
    }
  }
  return null;
}

export default function ChatComposer({
  onSend,
  onStop,
  running,
  submitting = false,
}: {
  onSend: (text: string, refs: ChatImageRef[], modelSelection: ChatModelSelection) => void;
  onStop: () => void;
  running: boolean;
  submitting?: boolean;
}) {
  const draft = useChatStore((state) => state.draft);
  const setDraft = useChatStore((state) => state.setDraft);
  const attachments = useChatStore((state) => state.draftAttachments);
  const draftBase = useChatStore((state) => state.draftBase);
  const setDraftBase = useChatStore((state) => state.setDraftBase);
  const addDraftAttachment = useChatStore((state) => state.addDraftAttachment);
  const removeDraftAttachment = useChatStore((state) => state.removeDraftAttachment);
  const setDraftAttachments = useChatStore((state) => state.setDraftAttachments);
  const clearDraft = useChatStore((state) => state.clearDraft);
  const canvasId = useChatStore((state) => state.activeCanvasId);
  const settings = useSettingsStore((state) => state.settings);

  // 当前画布的图片节点（结果图 + 参考图）：@ 菜单与图片选择器共用
  const imageNodes = useCanvasStore((state) => {
    const doc = state.canvases.find((item) => item.id === state.activeId);
    return (doc?.nodes || []).filter((node) => {
      const url = String(node.data?.imageUrl || node.data?.referenceDataUrl || '').trim();
      return Boolean(url) && node.data?.kind !== 'composer';
    });
  });

  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atIndex, setAtIndex] = useState(0);
  const [expandedNodeId, setExpandedNodeId] = useState('');
  const [modelMenu, setModelMenu] = useState(false);
  const [modelMenuStyle, setModelMenuStyle] = useState<CSSProperties>({});
  const [inlinePreview, setInlinePreview] = useState<InlinePreview | null>(null);
  const defaultImage = activeProfileOf(settings);
  const defaultText = pickTextProfile(settings);
  const [imageProfileId, setImageProfileId] = useState(defaultImage?.id || '');
  const [imageModel, setImageModel] = useState(defaultImage?.model || '');
  const textareaRef = useRef<HTMLDivElement>(null);
  const modelActionsRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const editorSignatureRef = useRef('');
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!imageProfileId && defaultImage?.id) setImageProfileId(defaultImage.id);
  }, [defaultImage?.id, imageProfileId]);

  useEffect(() => {
    if (!modelMenu) return undefined;
    const close = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setModelMenu(false);
    };
    const outside = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (!modelActionsRef.current?.contains(target) && !modelMenuRef.current?.contains(target)) setModelMenu(false);
    };
    window.addEventListener('keydown', close);
    window.addEventListener('mousedown', outside);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('mousedown', outside);
    };
  }, [modelMenu]);

  const toggleModelMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (modelMenu) {
      setModelMenu(false);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setModelMenuStyle({
      left: rect.left,
      bottom: Math.max(12, window.innerHeight - rect.top + 8),
    });
    setModelMenu(true);
  };

  useLayoutEffect(() => {
    const editor = textareaRef.current;
    if (!editor) return;
    const signature = chatInlineSignature(draft, attachments);
    if (editorSignatureRef.current === signature) return;
    const restoreCaret = editor.contains(document.activeElement);
    const caretOffset = restoreCaret ? caretTextOffset(editor) : null;
    renderInlineEditor(editor, draft, attachments);
    editorSignatureRef.current = signature;
    if (caretOffset !== null) setEditorCaretOffset(editor, Math.min(caretOffset, draft.length));
  }, [attachments, draft]);

  const imageProfiles = (settings?.profiles || []).filter((profile) => profile.kind === 'image' && profile.enabled !== false);
  const imageModelOptions = imageModelOptionsOf(settings?.profiles);
  const selectedImage = imageProfiles.find((profile) => profile.id === imageProfileId) || defaultImage;
  const selectedImageOption = imageModelOptions.find((option) => option.profileId === imageProfileId && option.model === imageModel)
    || imageModelOptions.find((option) => option.profileId === imageProfileId)
    || imageModelOptions[0];
  const imageModelLabel = selectedImageOption?.model || selectedImage?.model || selectedImage?.name || '生图模型';
  const modelSelection: ChatModelSelection = {
    textProfileId: defaultText?.id,
    imageProfileId: selectedImageOption?.profileId || selectedImage?.id,
    imageModel: selectedImageOption?.model,
  };

  useEffect(() => {
    if (!selectedImageOption) return;
    if (imageProfileId !== selectedImageOption.profileId) setImageProfileId(selectedImageOption.profileId);
    if (imageModel !== selectedImageOption.model) setImageModel(selectedImageOption.model);
  }, [imageModel, imageModelOptions.length, imageProfileId, selectedImageOption?.key]);

  const canSend = draft.trim().length > 0 || attachments.length > 0 || Boolean(draftBase);

  /** 节点的全部可选条目：当前主图排第一，展开后才展示其它版本。 */
  const entriesOfNode = useCallback((node: (typeof imageNodes)[number]): PickerEntry[] => {
    const versions = normalizeVersions(node.data as never);
    const title = String(node.data?.label || '图片');
    if (versions.length === 0) {
      const url = String(node.data?.imageUrl || node.data?.referenceDataUrl || '').trim();
      return [{ key: draftKeyOf({ nodeId: node.id }), nodeId: node.id, url, title }];
    }
    const active = activeVersionOf(node.data as never);
    const ordered = active
      ? [active, ...versions.filter((version) => version.id !== active.id)]
      : versions;
    return ordered.map((version) => ({
      key: draftKeyOf({ nodeId: node.id, versionId: version.id }),
      nodeId: node.id,
      versionId: version.id,
      url: String(version.imageUrl || ''),
      title: `${title} · ${version.id === active?.id ? '当前' : '历史'}`,
      versionLabel: version.id === active?.id ? '当前版本' : `历史版本 V${versions.findIndex((item) => item.id === version.id) + 1}`,
    }));
  }, []);

  const atMatches = useMemo(() => {
    const query = atQuery.trim().toLowerCase();
    return imageNodes
      .filter((node) => !query || String(node.data?.label || '').toLowerCase().includes(query))
      .slice(0, 8);
  }, [imageNodes, atQuery]);

  /** 文本框随内容长高（上限 160px，再高滚动）。 */
  const adjustHeight = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, []);

  const focusInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      const editor = textareaRef.current;
      if (!editor) return;
      editor.focus();
      setEditorCaretOffset(editor, draft.length);
    });
  }, [draft.length]);

  // 点击画布节点自动引用后，面板刚挂载也要把焦点交给输入框。
  useEffect(() => {
    if (attachments.length > 0) focusInput();
  }, [attachments.length, focusInput]);

  const chooseEntry = useCallback((entry: PickerEntry, position = draft.length) => {
    if (!entry.url) return;
    addDraftAttachment({ canvasId, nodeId: entry.nodeId, versionId: entry.versionId, url: entry.url, title: entry.title, position });
    focusInput();
  }, [addDraftAttachment, canvasId, draft.length, focusInput]);

  const onInputChange = (value: string) => {
    setDraft(value);
    // 输入 @ 触发引用菜单：认「开头、空白或中文标点之后的 @ + 无空格片段」
    const match = value.match(mentionPattern);
    if (match) {
      setAtOpen(true);
      setAtQuery(match[1]);
      setAtIndex(0);
      setExpandedNodeId('');
    } else if (atOpen) {
      setAtOpen(false);
    }
    adjustHeight();
  };

  const selectMention = (entry: PickerEntry) => {
    const match = draft.match(/@([^\s@]*)$/);
    const start = match ? draft.length - match[0].length : draft.length;
    const nextDraft = match ? draft.slice(0, start).replace(/\s+$/, '') : draft;
    setDraft(nextDraft);
    chooseEntry(entry, start);
    setAtOpen(false);
  };

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    const { text, references } = readInlineEditor(event.currentTarget, attachments);
    setDraftAttachments(references);
    editorSignatureRef.current = chatInlineSignature(text, references);
    onInputChange(text);
  };

  const onAtKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!atOpen || atMatches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setAtIndex((index) => (index + 1) % atMatches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setAtIndex((index) => (index - 1 + atMatches.length) % atMatches.length);
    } else if (event.key === 'Enter' && !event.shiftKey) {
      // 输入法组合期间不拦截
      if (event.nativeEvent.isComposing) return;
      event.preventDefault();
      const node = atMatches[atIndex];
      const entry = entriesOfNode(node)[0];
      selectMention(entry);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setAtOpen(false);
    }
  };

  const send = () => {
    if (running) {
      onStop();
      return;
    }
    if (submitting || !canSend) return;
    const leadingWhitespace = draft.length - draft.trimStart().length;
    const sendAttachments = attachments.map((attachment) => ({
      ...attachment,
      position: Math.max(0, (attachment.position ?? draft.length) - leadingWhitespace),
    }));
    onSend(draft.trim(), sendAttachments, modelSelection);
    clearDraft();
    setDraftBase(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      adjustHeight();
    });
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!atOpen && (event.key === 'Backspace' || event.key === 'Delete')) {
      const direction = event.key === 'Backspace' ? 'backward' : 'forward';
      const reference = inlineReferenceAdjacentToCaret(event.currentTarget, direction);
      if (reference) {
        const offset = caretTextOffset(event.currentTarget);
        event.preventDefault();
        event.stopPropagation();
        removeDraftAttachment(reference.dataset.chatRefKey || '');
        window.requestAnimationFrame(() => {
          const editor = textareaRef.current;
          if (!editor) return;
          editor.focus();
          setEditorCaretOffset(editor, offset);
        });
        return;
      }
    }
    if (atOpen) {
      onAtKeyDown(event);
      return;
    }
    // Enter 发送、Shift+Enter 换行；输入法组合期间不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      setAtOpen(false);
    }
  };

  return (
    <div className="hb-chat-composer" ref={composerRef}>
      <div className="hb-chat-input-content">
      {inlinePreview ? (
        <div
          className="hb-chat-inline-ref-preview"
          style={{ left: inlinePreview.left, top: inlinePreview.top }}
          aria-hidden="true"
        >
          <img src={inlinePreview.reference.url || ''} alt="" />
        </div>
      ) : null}
      {draftBase ? (
        <div className="hb-chat-chips" aria-label="引用的图片">
          <span className="hb-chat-chip is-base" key={`base-${draftBase.nodeId}`}>
              <span className="hb-chat-chip-preview">
                <img src={draftBase.url || ''} alt="" className="hb-chat-chip-thumb" />
                <img src={draftBase.url || ''} alt="" className="hb-chat-chip-preview-image" />
              </span>
              <em className="hb-chat-chip-name">基准：{draftBase.title || '图片'}</em>
              <button
                type="button"
                className="hb-chat-chip-remove"
                title="取消基准图"
                aria-label="取消基准图"
                onClick={() => setDraftBase(null)}
              >
                <CloseGlyphIcon />
              </button>
          </span>
        </div>
      ) : null}
      <div className="hb-chat-input-row">
        <div
          ref={textareaRef}
          className="hb-chat-input"
          contentEditable
          suppressContentEditableWarning
          data-placeholder={running ? 'Agent 正在运行，可点右侧停止…' : '描述你的想法，Enter 发送；@ 引用画布图片'}
          aria-label="对话输入框"
          role="textbox"
          aria-multiline="true"
          onInput={handleEditorInput}
          onKeyDown={onTextareaKeyDown}
          onBeforeInput={(event) => {
            if (atOpen) return;
            const inputType = (event.nativeEvent as InputEvent).inputType;
            const direction = inputType === 'deleteContentBackward'
              ? 'backward'
              : inputType === 'deleteContentForward' ? 'forward' : null;
            if (!direction) return;
            const reference = inlineReferenceAdjacentToCaret(event.currentTarget, direction);
            if (!reference) return;
            const offset = caretTextOffset(event.currentTarget);
            event.preventDefault();
            event.stopPropagation();
            removeDraftAttachment(reference.dataset.chatRefKey || '');
            window.requestAnimationFrame(() => {
              const editor = textareaRef.current;
              if (!editor) return;
              editor.focus();
              setEditorCaretOffset(editor, offset);
            });
          }}
          onMouseOver={(event) => {
            const token = (event.target as HTMLElement).closest<HTMLElement>('[data-chat-ref-key]');
            const key = token?.dataset.chatRefKey || '';
            const reference = attachments.find((item) => draftKeyOf(item) === key);
            if (!token || !reference || !composerRef.current) {
              setInlinePreview(null);
              return;
            }
            const tokenRect = token.getBoundingClientRect();
            const composerRect = composerRef.current.getBoundingClientRect();
            setInlinePreview({
              reference,
              left: tokenRect.left - composerRect.left,
              top: tokenRect.top - composerRect.top - 164,
            });
          }}
          onMouseLeave={() => setInlinePreview(null)}
          onClick={(event) => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-chat-ref]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            removeDraftAttachment(button.dataset.removeChatRef || '');
          }}
          onPaste={(event) => {
            event.preventDefault();
            const pastedText = event.clipboardData.getData('text/plain');
            const selection = window.getSelection();
            if (!selection?.rangeCount || !pastedText) return;
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(pastedText);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            textareaRef.current?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: pastedText }));
          }}
        />
      </div>
      </div>
      <div className="hb-chat-tool-entry">
        <div className="hb-chat-composer-model-actions" aria-label="模型选择" ref={modelActionsRef}>
          <button
            type="button"
            className={`hb-chat-image-model-button ${modelMenu ? 'is-open' : ''}`}
            title={selectedImage ? `${selectedImage.name} · ${imageModelLabel}` : '未配置图像模型'}
            aria-label={`选择图像模型，当前 ${imageModelLabel}`}
            aria-haspopup="menu"
            aria-expanded={modelMenu}
            onClick={toggleModelMenu}
          >
            <ModelGlyphIcon />
            <span>{imageModelLabel}</span>
          </button>
          {modelMenu ? createPortal(
            <div
              ref={modelMenuRef}
              className="hb-chat-model-menu hb-chat-composer-model-menu"
              style={modelMenuStyle}
              role="menu"
              aria-label="选择图像模型"
            >
              {imageModelOptions.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedImageOption?.key === option.key}
                  className={`hb-chat-model-option ${selectedImageOption?.key === option.key ? 'is-active' : ''}`}
                  key={option.key}
                  onClick={() => {
                    setImageProfileId(option.profileId);
                    setImageModel(option.model);
                    setModelMenu(false);
                  }}
                >
                  <span className="hb-chat-model-option-text">
                    <span>{option.model}</span>
                    <small>{option.profileName}</small>
                  </span>
                  {selectedImageOption?.key === option.key ? (
                    <span className="hb-chat-model-option-check" aria-hidden="true">
                      <svg viewBox="0 0 16 16" fill="none">
                        <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                  ) : null}
                </button>
              ))}
              {imageModelOptions.length === 0 ? <p className="hb-chat-menu-empty">暂无可用模型，请到模型设置添加并勾选</p> : null}
            </div>,
            document.body,
          ) : null}
        </div>
        <button
          type="button"
          className={`hb-chat-send ${running ? 'is-stop' : ''}`}
          disabled={!running && (submitting || !canSend)}
          title={running ? '停止运行' : submitting ? '正在发送' : '发送（Enter）'}
          aria-label={running ? '停止运行' : submitting ? '正在发送' : '发送'}
          aria-busy={submitting}
          onClick={send}
        >
          {running ? <StopGlyphIcon /> : <SendGlyphIcon />}
        </button>
      </div>

      {atOpen ? (
        <div className="hb-chat-picker" role="dialog" aria-label="引用画布图片">
          <div className="hb-chat-picker-head">
            <span>@ 引用</span>
            <input
              value={atQuery}
              placeholder="搜索节点名称"
              aria-label="搜索节点名称"
              onChange={(event) => {
                setAtQuery(event.target.value);
                setAtIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setAtOpen(false);
                }
              }}
            />
          </div>
          <div className="hb-chat-picker-list" role="listbox" aria-label="可引用的画布图片">
            {atMatches.length === 0 ? (
              <p className="hb-chat-menu-empty">当前画布还没有可引用的图片</p>
            ) : atMatches.map((node, index) => (
              <div key={node.id}>
                <button
                  type="button"
                  className={`hb-chat-picker-item ${index === atIndex ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={index === atIndex}
                  onClick={() => {
                    const entry = entriesOfNode(node)[0];
                    selectMention(entry);
                  }}
                  onMouseEnter={() => setAtIndex(index)}
                >
                  <img src={entriesOfNode(node)[0]?.url || ''} alt="" />
                  <span className="hb-chat-picker-item-text">
                    <strong>{String(node.data?.label || '图片')}</strong>
                    <span>{normalizeVersions(node.data as never).length > 1 ? `${normalizeVersions(node.data as never).length} 个版本` : '当前版本'}</span>
                  </span>
                  {normalizeVersions(node.data as never).length > 1 ? (
                    <span
                      className="hb-chat-picker-item-check"
                      role="button"
                      tabIndex={0}
                      aria-expanded={expandedNodeId === node.id}
                      title="展开版本"
                      aria-label={`展开 ${String(node.data?.label || '图片')} 的版本`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedNodeId((current) => (current === node.id ? '' : node.id));
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return;
                        event.preventDefault();
                        event.stopPropagation();
                        setExpandedNodeId((current) => (current === node.id ? '' : node.id));
                      }}
                    >
                      ▾
                    </span>
                  ) : null}
                </button>
                {expandedNodeId === node.id ? entriesOfNode(node).map((entry) => (
                  <button
                    type="button"
                    className="hb-chat-picker-item"
                    key={entry.key}
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      selectMention(entry);
                    }}
                  >
                    <span className="hb-chat-picker-item-text" style={{ paddingLeft: 'var(--spacing-6)' }}>
                      <strong>{entry.versionLabel || entry.title}</strong>
                    </span>
                  </button>
                )) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

    </div>
  );
}
