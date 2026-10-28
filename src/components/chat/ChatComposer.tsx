import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { draftKeyOf, useChatStore } from '@/stores/chatStore';
import { activeVersionOf, normalizeVersions } from '@/lib/versions';
import { pickTextProfile } from '@/lib/enhance';
import { imageModelOptionsOf } from '@/lib/imageModelOptions';
import { activeProfileOf, useSettingsStore } from '@/stores/settingsStore';
import type { ChatImageRef, ChatModelSelection, ChatRoleSnapshot } from '@/types';
import { createPortal } from 'react-dom';
import { ModelGlyphIcon } from '@/components/canvas/NodeToolbarIcons';
import { chatInlineSegments, chatInlineSignature, chatRoleLabel } from '@/lib/chatInlineRefs';
import { CHAT_ROLES_UPDATED_EVENT, chatRoleSnapshotOf, enabledChatRoles, toggleChatRoleSelection } from '@/lib/chatRoles';
import { getPromptSkills, type PromptSkill } from '@/lib/bridge';
import { CloseGlyphIcon, SendGlyphIcon, StopGlyphIcon } from './ChatIcons';
import { ChatRoleStack } from './ChatRoleStack';
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

function readInlineEditor(root: HTMLElement, attachments: ChatImageRef[]) {
  let text = '';
  const positions = new Map<string, number>();
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += withoutInlineRefSentinels(node.textContent || '');
      return;
    }
    if (node instanceof HTMLElement && node.dataset.chatInlineToken !== undefined) {
      if (node.dataset.chatRefKey) positions.set(node.dataset.chatRefKey, text.length);
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
  // 角色标签固定在输入区最前面，标签后的开头换行只会制造一行空白。
  const leadingBreaks = root.querySelector('[data-chat-role-token]') ? text.match(/^\n+/)?.[0].length || 0 : 0;
  if (leadingBreaks > 0) {
    text = text.slice(leadingBreaks);
    positions.forEach((position, key) => positions.set(key, Math.max(0, position - leadingBreaks)));
  }
  const references = attachments
    .filter((reference) => positions.has(draftKeyOf(reference)))
    .map((reference) => ({ ...reference, position: positions.get(draftKeyOf(reference)) || 0 }));
  return { text, references };
}

/** 把「可见字符序号」换算成文本节点里的真实下标（跳过零宽占位符）。 */
function rawOffsetForLogicalOffset(value: string, logicalOffset: number): number {
  if (logicalOffset <= 0) {
    let index = 0;
    while (index < value.length && value[index] === INLINE_REF_SENTINEL) index += 1;
    return index;
  }
  let visible = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === INLINE_REF_SENTINEL) continue;
    if (visible >= logicalOffset) return index;
    visible += 1;
  }
  return value.length;
}

/**
 * 内联单位长度：文字与换行各占 1，图片引用占 1（像字符一样可落点），
 * 角色标签与零宽占位不占位。光标偏移统一用这个空间，避免与纯文本长度混用。
 */
function inlineLengthFromNode(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return withoutInlineRefSentinels(node.textContent || '').length;
  }
  if (node instanceof HTMLElement) {
    if (node.dataset.chatRoleToken) return 0;
    if (node.dataset.chatInlineToken !== undefined) return 1;
    if (node.nodeName === 'BR') return 1;
  }
  let length = 0;
  node.childNodes.forEach((child) => {
    length += inlineLengthFromNode(child);
  });
  return length;
}

function caretInlineOffset(root: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return inlineLengthFromNode(root);
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.anchorNode as Node, selection.anchorOffset);
  return inlineLengthFromNode(range.cloneContents());
}

function applyCaretRange(range: Range) {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretRangeAtNode(node: Node, edge: 'before' | 'after'): Range {
  const range = document.createRange();
  if (edge === 'before') range.setStartBefore(node);
  else range.setStartAfter(node);
  range.collapse(true);
  return range;
}

/**
 * 编辑器末尾的落点：优先落在最后一个文本节点内部。
 * 直接把光标放在 contenteditable=false 元素的边界上时，Safari 会把它归一化到元素前面。
 */
function caretRangeAtEnd(root: HTMLElement): Range {
  const last = root.lastChild;
  const range = document.createRange();
  if (last && last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, (last.textContent || '').length);
  } else {
    range.selectNodeContents(root);
  }
  range.collapse(true);
  return range;
}

function inlineOffsetOfNode(root: HTMLElement, target: Node): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEndBefore(target);
  return inlineLengthFromNode(range.cloneContents());
}

function setEditorCaretInlineOffset(root: HTMLElement, targetOffset: number) {
  const target = Math.max(0, targetOffset);
  let cursor = 0;
  let placed = false;

  const place = (range: Range) => {
    applyCaretRange(range);
    placed = true;
  };

  const walk = (node: Node): void => {
    if (placed) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent || '';
      const length = withoutInlineRefSentinels(raw).length;
      if (target <= cursor + length) {
        const range = document.createRange();
        range.setStart(node, rawOffsetForLogicalOffset(raw, target - cursor));
        range.collapse(true);
        place(range);
        return;
      }
      cursor += length;
      return;
    }
    if (node instanceof HTMLElement && node.dataset.chatInlineToken !== undefined) {
      if (node.dataset.chatRoleToken) {
        // 角色标签固定在最前且不占位：偏移 0 时落到标签后面，输入才不会跑到标签前。
        if (target <= cursor) place(caretRangeAtNode(node, 'after'));
        return;
      }
      if (target <= cursor) {
        place(caretRangeAtNode(node, 'before'));
        return;
      }
      cursor += 1;
      if (target <= cursor) place(caretRangeAtNode(node, 'after'));
      return;
    }
    if (node.nodeName === 'BR') {
      if (target <= cursor) {
        place(caretRangeAtNode(node, 'before'));
        return;
      }
      cursor += 1;
      if (target <= cursor) place(caretRangeAtNode(node, 'after'));
      return;
    }
    node.childNodes.forEach(walk);
  };

  walk(root);
  if (placed) return;
  applyCaretRange(caretRangeAtEnd(root));
}

function setEditorCaretAtEnd(root: HTMLElement) {
  applyCaretRange(caretRangeAtEnd(root));
}

function setCaretAfterInlineToken(root: HTMLElement, key: string): boolean {
  const token = Array.from(root.querySelectorAll<HTMLElement>('[data-chat-ref-key]'))
    .find((node) => node.dataset.chatRefKey === key);
  if (!token) return false;
  const trailing = token.nextSibling;
  if (trailing && trailing.nodeType === Node.TEXT_NODE && (trailing.textContent || '').startsWith(INLINE_REF_SENTINEL)) {
    const range = document.createRange();
    range.setStart(trailing, 0);
    range.collapse(true);
    applyCaretRange(range);
    return true;
  }
  applyCaretRange(caretRangeAtNode(token, 'after'));
  return true;
}

function renderInlineEditor(root: HTMLElement, text: string, attachments: ChatImageRef[], role?: PromptSkill) {
  root.replaceChildren();
  if (role) {
    const token = document.createElement('span');
    token.className = 'hb-chat-role-inline-token';
    token.contentEditable = 'false';
    token.dataset.chatInlineToken = 'role';
    token.dataset.chatRoleToken = role.id;
    token.title = role.name;
    const avatar = document.createElement('span');
    avatar.className = 'hb-chat-role-inline-token-avatar';
    avatar.textContent = Array.from(role.name.trim())[0] || '角';
    if (role.avatarUrl) {
      const image = document.createElement('img');
      image.src = role.avatarUrl;
      image.alt = '';
      image.onerror = () => {
        image.remove();
        avatar.hidden = false;
      };
      token.append(image);
      avatar.hidden = true;
    }
    const label = document.createElement('span');
    label.className = 'hb-chat-role-inline-token-label';
    label.textContent = chatRoleLabel(role.name);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'hb-chat-role-inline-token-remove';
    remove.dataset.removeChatRole = role.id;
    remove.setAttribute('aria-label', `取消角色 ${role.name}`);
    remove.title = '取消角色';
    remove.innerHTML = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>';
    token.append(avatar, label, remove);
    root.append(token, document.createTextNode(INLINE_REF_SENTINEL));
  }
  const inlineText = role ? text.replace(/^\n+/, '') : text;
  for (const segment of chatInlineSegments(inlineText, attachments)) {
    if (segment.type === 'text') {
      if (segment.text) root.append(document.createTextNode(segment.text));
      continue;
    }
    const reference = segment.reference;
    const key = draftKeyOf(reference);
    const token = document.createElement('span');
    token.className = 'hb-chat-inline-ref is-editor';
    token.contentEditable = 'false';
    token.dataset.chatInlineToken = 'reference';
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

function ensureRoleTokenFirst(root: HTMLElement) {
  const token = root.querySelector<HTMLElement>('[data-chat-role-token]');
  if (!token || root.firstChild === token) return;
  root.insertBefore(token, root.firstChild);
}

function siblingInlineToken(node: Node, direction: 'backward' | 'forward'): HTMLElement | null {
  let sibling = direction === 'backward' ? node.previousSibling : node.nextSibling;
  while (sibling) {
    if (sibling instanceof HTMLElement && sibling.dataset.chatInlineToken) return sibling;
    if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent === INLINE_REF_SENTINEL) {
      sibling = direction === 'backward' ? sibling.previousSibling : sibling.nextSibling;
      continue;
    }
    return null;
  }
  return null;
}

function inlineTokenAdjacentToCaret(root: HTMLElement, direction: 'backward' | 'forward'): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed || !root.contains(selection.anchorNode)) return null;
  const node = selection.anchorNode;
  const offset = selection.anchorOffset;
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    const index = direction === 'backward' ? offset - 1 : offset;
    if (index >= 0 && index < text.length && text[index] !== INLINE_REF_SENTINEL) return null;
    return siblingInlineToken(node, direction);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const childIndex = direction === 'backward' ? offset - 1 : offset;
    const child = node.childNodes[childIndex];
    if (!child) return null;
    if (child instanceof HTMLElement && child.dataset.chatInlineToken) return child;
    if (child.nodeType === Node.TEXT_NODE && child.textContent === INLINE_REF_SENTINEL) {
      return siblingInlineToken(child, direction);
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
  onSend: (text: string, refs: ChatImageRef[], modelSelection: ChatModelSelection, agentRole?: ChatRoleSnapshot) => void;
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
  const activeRoleId = useChatStore((state) => state.activeRoleId);
  const setActiveRole = useChatStore((state) => state.setActiveRole);
  const clearActiveRole = useChatStore((state) => state.clearActiveRole);
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
  const [roles, setRoles] = useState<PromptSkill[]>([]);
  const [rolesLoaded, setRolesLoaded] = useState(false);
  const defaultImage = activeProfileOf(settings);
  const defaultText = pickTextProfile(settings);
  const [imageProfileId, setImageProfileId] = useState(defaultImage?.id || '');
  const [imageModel, setImageModel] = useState(defaultImage?.model || '');
  const textareaRef = useRef<HTMLDivElement>(null);
  const modelActionsRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const editorSignatureRef = useRef('');
  const composerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);

  const loadRoles = useCallback(async () => {
    try {
      setRoles(await getPromptSkills());
      setRolesLoaded(true);
    } catch {
      // 角色是增强能力；bridge 暂不可用时输入框仍应保持可用。
      setRoles([]);
    }
  }, []);

  const availableRoles = useMemo(() => enabledChatRoles(roles), [roles]);
  const activeRole = availableRoles.find((role) => role.id === activeRoleId);

  useEffect(() => {
    void loadRoles();
    const refresh = () => void loadRoles();
    window.addEventListener(CHAT_ROLES_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(CHAT_ROLES_UPDATED_EVENT, refresh);
  }, [loadRoles]);

  useEffect(() => {
    if (!rolesLoaded || !activeRoleId) return;
    if (!availableRoles.some((role) => role.id === activeRoleId)) clearActiveRole();
  }, [activeRoleId, availableRoles, clearActiveRole, rolesLoaded]);

  const toggleRole = (roleId: string) => {
    const nextRoleId = toggleChatRoleSelection(activeRoleId, roleId);
    if (nextRoleId) setActiveRole(nextRoleId);
    else clearActiveRole();
  };

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
    // 输入法组合期间不能重建 DOM，否则会销毁 IME 维护的 composition range，
    // 光标就会跳到文字中间或图片前面。组合结束后由 onCompositionEnd 统一同步。
    if (composingRef.current) return;
    const editor = textareaRef.current;
    if (!editor) return;
    const signature = chatInlineSignature(draft, attachments, activeRole?.id);
    if (editorSignatureRef.current === signature) return;
    const restoreCaret = editor.contains(document.activeElement);
    const caretOffset = restoreCaret ? caretInlineOffset(editor) : null;
    renderInlineEditor(editor, draft, attachments, activeRole);
    editorSignatureRef.current = signature;
    if (caretOffset !== null) setEditorCaretInlineOffset(editor, Math.min(caretOffset, inlineLengthFromNode(editor)));
  }, [activeRole, attachments, draft]);

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
    element.style.height = `${Math.min(Math.max(element.scrollHeight, 98), 160)}px`;
  }, []);

  /** 聚焦输入框并落到指定图片引用之后；找不到引用时落到末尾。 */
  const focusEditorAfter = useCallback((refKey?: string) => {
    window.requestAnimationFrame(() => {
      const editor = textareaRef.current;
      if (!editor) return;
      editor.focus();
      if (refKey && setCaretAfterInlineToken(editor, refKey)) return;
      setEditorCaretAtEnd(editor);
    });
  }, []);

  // 仅在新增引用时接管光标；输入文字时不能再重设光标，否则会跳回文本中间。
  const attachmentCountRef = useRef(0);
  useEffect(() => {
    const previous = attachmentCountRef.current;
    attachmentCountRef.current = attachments.length;
    if (attachments.length === 0 || attachments.length <= previous) return;
    focusEditorAfter(draftKeyOf(attachments[attachments.length - 1]));
  }, [attachments, focusEditorAfter]);

  const chooseEntry = useCallback((entry: PickerEntry, position = draft.length) => {
    if (!entry.url) return;
    addDraftAttachment({ canvasId, nodeId: entry.nodeId, versionId: entry.versionId, url: entry.url, title: entry.title, position });
    focusEditorAfter(entry.key);
  }, [addDraftAttachment, canvasId, draft.length, focusEditorAfter]);

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

  const syncEditorState = (editor: HTMLElement) => {
    ensureRoleTokenFirst(editor);
    const { text, references } = readInlineEditor(editor, attachments);
    setDraftAttachments(references);
    const restoreRoleToken = Boolean(activeRole && !editor.querySelector('[data-chat-role-token]'));
    editorSignatureRef.current = restoreRoleToken ? '' : chatInlineSignature(text, references, activeRole?.id);
    onInputChange(text);
    if (restoreRoleToken) {
      window.requestAnimationFrame(() => {
        const next = textareaRef.current;
        if (!next || composingRef.current || next.querySelector('[data-chat-role-token]') || !activeRole) return;
        const caretOffset = caretInlineOffset(next);
        renderInlineEditor(next, text, attachments, activeRole);
        editorSignatureRef.current = chatInlineSignature(text, references, activeRole.id);
        setEditorCaretInlineOffset(next, caretOffset);
      });
    }
  };

  const syncEditorRef = useRef(syncEditorState);
  useLayoutEffect(() => {
    syncEditorRef.current = syncEditorState;
  });

  const handleEditorInput = (event: FormEvent<HTMLDivElement>) => {
    const native = event.nativeEvent as InputEvent;
    // 组合输入中不同步状态：一同步就会重渲染编辑器，打断输入法。
    if (composingRef.current || native.isComposing) {
      adjustHeight();
      return;
    }
    syncEditorState(event.currentTarget);
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
    onSend(draft.trim(), sendAttachments, modelSelection, activeRole ? chatRoleSnapshotOf(activeRole) : undefined);
    clearDraft();
    setDraftBase(null);
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      adjustHeight();
    });
  };

  /** 删除角色 / 图片标签后按内联偏移把光标放回原位（图片少一个单位）。 */
  const removeInlineToken = (editor: HTMLElement, token: HTMLElement) => {
    const tokenStart = inlineOffsetOfNode(editor, token);
    const caret = caretInlineOffset(editor);
    const target = token.dataset.chatRoleToken
      ? caret
      : Math.max(0, caret > tokenStart ? caret - 1 : caret);
    if (token.dataset.chatRoleToken) clearActiveRole();
    else removeDraftAttachment(token.dataset.chatRefKey || '');
    window.requestAnimationFrame(() => {
      const next = textareaRef.current;
      if (!next) return;
      next.focus();
      setEditorCaretInlineOffset(next, target);
    });
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 组合输入期间交给输入法处理，不能拦截删除或回车。
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if ((event.target as HTMLElement).closest('[data-remove-chat-role]')) return;
    if (!atOpen && (event.key === 'Backspace' || event.key === 'Delete')) {
      const direction = event.key === 'Backspace' ? 'backward' : 'forward';
      const token = inlineTokenAdjacentToCaret(event.currentTarget, direction);
      if (token) {
        event.preventDefault();
        event.stopPropagation();
        removeInlineToken(event.currentTarget, token);
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
    <div className="hb-chat-composer-wrap">
      <ChatRoleStack roles={availableRoles} activeRoleId={activeRoleId} onToggle={toggleRole} />
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
          className={`hb-chat-input ${draft.length === 0 && attachments.length === 0 && !activeRole ? 'is-empty' : ''}`}
          contentEditable
          suppressContentEditableWarning
          data-placeholder={running ? 'Agent 正在运行，可点右侧停止…' : '描述你的想法，Enter 发送；@ 引用画布图片'}
          aria-label="对话输入框"
          role="textbox"
          aria-multiline="true"
          onInput={handleEditorInput}
          onKeyDown={onTextareaKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            window.requestAnimationFrame(() => {
              const next = textareaRef.current;
              if (!next || composingRef.current) return;
              syncEditorRef.current(next);
              adjustHeight();
            });
          }}
          onBlur={() => {
            // 极端情况下（组合中被强制失焦）compositionend 不会触发，避免保护一直卡住。
            composingRef.current = false;
          }}
          onBeforeInput={(event) => {
            if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;
            if (atOpen) return;
            const inputType = (event.nativeEvent as InputEvent).inputType;
            const direction = inputType === 'deleteContentBackward'
              ? 'backward'
              : inputType === 'deleteContentForward' ? 'forward' : null;
            if (!direction) return;
            const token = inlineTokenAdjacentToCaret(event.currentTarget, direction);
            if (!token) return;
            event.preventDefault();
            event.stopPropagation();
            removeInlineToken(event.currentTarget, token);
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
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest('[data-remove-chat-ref], [data-remove-chat-role]')) event.preventDefault();
          }}
          onClick={(event) => {
            const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-chat-ref], [data-remove-chat-role]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const token = button.closest<HTMLElement>('[data-chat-inline-token]');
            if (token) removeInlineToken(event.currentTarget, token);
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
    </div>
  );
}
