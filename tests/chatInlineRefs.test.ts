import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chatInlineSegments, chatInlineSignature, chatRoleLabel } from '@/lib/chatInlineRefs';

describe('chatInlineSegments', () => {
  it('keeps selected roles in the inline editor render signature', () => {
    expect(chatInlineSignature('hello', [], 'role-a')).not.toBe(chatInlineSignature('hello', [], 'role-b'));
    expect(chatInlineSignature('hello', [], 'role-a')).toBe(chatInlineSignature('hello', [], 'role-a'));
  });

  it('truncates role labels after four user-perceived characters', () => {
    expect(chatRoleLabel(' 创意导演 ')).toBe('创意导演');
    expect(chatRoleLabel('视觉创意导演')).toBe('视觉创意...');
  });

  it('role reference tokens use a non-editable inline tag and single-delete semantics', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatComposer.tsx', import.meta.url)), 'utf8');
    const css = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatPanel.css', import.meta.url)), 'utf8');
    expect(source).toContain("token.contentEditable = 'false'");
    expect(source).toContain('data-chat-role-token');
    expect(source).toContain('inlineTokenAdjacentToCaret');
    expect(source).toContain('activeRole && !editor.querySelector');
    expect(css).toMatch(/\.hb-chat-role-inline-token\s*\{[^}]*display:\s*inline-flex/s);
    expect(css).toMatch(/\.hb-chat-role-inline-token img\s*\{[^}]*width:\s*var\(--spacing-6\)[^}]*height:\s*var\(--spacing-6\)[^}]*border:\s*var\(--chat-role-avatar-outline-width\) solid var\(--chat-role-avatar-outline\)/s);
    expect(css).toMatch(/\.hb-chat-role-inline-token-avatar\s*\{[^}]*width:\s*var\(--spacing-6\)[^}]*height:\s*var\(--spacing-6\)/s);
    expect(css).toMatch(/\.hb-chat-role-inline-token-label\s*\{[^}]*font-size:\s*var\(--font-size-xs\)/s);
    expect(css).toMatch(/\.hb-chat-role-inline-token\s*\{[^}]*padding:\s*var\(--spacing-1\) var\(--spacing-1\) var\(--spacing-1\) var\(--spacing-1\)/s);
    expect(css).toMatch(/\.hb-chat-composer\s*\{[^}]*min-height:\s*160px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.hb-chat-composer\s*\{[^}]*min-height:\s*160px/s);
  });

  it('provides a keyboard-accessible role close button without clearing the draft or image references', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatComposer.tsx', import.meta.url)), 'utf8');
    const css = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatPanel.css', import.meta.url)), 'utf8');
    expect(source).toContain("remove.type = 'button'");
    expect(source).toContain('remove.dataset.removeChatRole = role.id');
    expect(source).toContain('`取消角色 ${role.name}`');
    expect(source).toContain("if ((event.target as HTMLElement).closest('[data-remove-chat-role]')) return;");
    const removal = source.match(/const removeInlineToken = \([\s\S]*?\n  \};/)?.[0] || '';
    expect(removal).toContain('clearActiveRole()');
    expect(removal).toContain('setEditorCaretInlineOffset(next, target)');
    expect(removal).not.toMatch(/clearDraft|setDraft\(|setDraftAttachments/);
    expect(css).toContain('.hb-chat-role-inline-token-remove:focus-visible');
  });

  it('restores caret positions in inline-offset space instead of plain text length', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatComposer.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('function rawOffsetForLogicalOffset');
    expect(source).toContain('function inlineLengthFromNode');
    expect(source).toContain('function caretInlineOffset');
    expect(source).toContain('function setEditorCaretInlineOffset');
    expect(source).toContain('function setCaretAfterInlineToken');
    expect(source).toContain('function caretRangeAtEnd');
    expect(source).toContain('range.setStart(trailing, 0)');
    expect(source).toContain('if (node.dataset.chatRoleToken) return 0;');
    expect(source).toContain('if (node.dataset.chatInlineToken !== undefined) return 1;');
    expect(source).toContain('attachments.length <= previous');
    expect(source).not.toContain('setEditorCaretOffset(editor, draft.length)');
  });

  it('does not rebuild the editable DOM while an IME composition is in flight', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatComposer.tsx', import.meta.url)), 'utf8');
    expect(source).toContain('const composingRef = useRef(false)');
    expect(source).toContain('onCompositionStart');
    expect(source).toContain('onCompositionEnd');
    expect(source).toContain('if (composingRef.current) return;');
    expect(source).toContain('if (composingRef.current || native.isComposing) {');
    expect(source).toContain('if (composingRef.current || event.nativeEvent.isComposing) return;');
    expect(source).toContain('if (composingRef.current || (event.nativeEvent as InputEvent).isComposing) return;');
    expect(source).toContain('syncEditorRef.current(next)');
  });

  it('keeps the actual editable chat area at 98px across viewports', () => {
    const css = readFileSync(fileURLToPath(new URL('../src/components/chat/ChatPanel.css', import.meta.url)), 'utf8');
    expect(css).toMatch(/\.hb-chat-input\s*\{[^}]*min-height:\s*98px/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*640px\)[\s\S]*?\.hb-chat-input\s*\{[^}]*min-height:\s*98px/s);
  });

  it('keeps references between the surrounding text segments', () => {
    const segments = chatInlineSegments('合成这两张图', [
      { canvasId: 'c1', nodeId: 'a', position: 2, title: '图一' },
      { canvasId: 'c1', nodeId: 'b', position: 4, title: '图二' },
    ]);
    expect(segments).toEqual([
      { type: 'text', text: '合成' },
      { type: 'reference', reference: { canvasId: 'c1', nodeId: 'a', position: 2, title: '图一' } },
      { type: 'text', text: '这两' },
      { type: 'reference', reference: { canvasId: 'c1', nodeId: 'b', position: 4, title: '图二' } },
      { type: 'text', text: '张图' },
    ]);
  });

  it('clamps legacy and out-of-range offsets to the text end', () => {
    const segments = chatInlineSegments('abc', [
      { canvasId: 'c1', nodeId: 'legacy' },
      { canvasId: 'c1', nodeId: 'late', position: 30 },
    ]);
    expect(segments.map((segment) => segment.type === 'text' ? segment.text : segment.reference.nodeId))
      .toEqual(['abc', 'legacy', 'late']);
  });
});
