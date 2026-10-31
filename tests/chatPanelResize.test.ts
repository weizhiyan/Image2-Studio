import { describe, expect, it } from 'vitest';
import {
  getChatPanelResizeWidth,
  getNextChatPanelResizePhase,
  type ChatPanelResizePhase,
} from '@/lib/chatPanelResize';

describe('chat panel resize interaction', () => {
  const minWidth = 320;
  const maxWidth = 640;

  it('keeps the panel at its minimum width until the half-width collapse threshold', () => {
    const widths = [320, 240, 161].map((desiredWidth) => {
      const phase = getNextChatPanelResizePhase('expanded', desiredWidth, minWidth);
      return getChatPanelResizeWidth(desiredWidth, minWidth, maxWidth, phase);
    });

    expect(widths).toEqual([320, 320, 320]);
    expect(getNextChatPanelResizePhase('expanded', 160, minWidth)).toBe('collapsing');
  });

  it('keeps the collapse threshold latched until reverse dragging reaches minimum width', () => {
    let phase: ChatPanelResizePhase = 'expanded';
    phase = getNextChatPanelResizePhase(phase, 160, minWidth);
    expect(phase).toBe('collapsing');
    phase = getNextChatPanelResizePhase(phase, 240, minWidth);
    expect(phase).toBe('collapsing');
    phase = getNextChatPanelResizePhase('collapsed', 319, minWidth);
    expect(phase).toBe('collapsed');
    phase = getNextChatPanelResizePhase('collapsed', 320, minWidth);
    expect(phase).toBe('expanding');
  });

  it('allows free resizing after expansion and respects available viewport width', () => {
    expect(getChatPanelResizeWidth(480, minWidth, maxWidth, 'expanded')).toBe(480);
    expect(getChatPanelResizeWidth(720, minWidth, maxWidth, 'expanded')).toBe(640);
    expect(getChatPanelResizeWidth(240, minWidth, maxWidth, 'expanded')).toBe(320);
    expect(getChatPanelResizeWidth(240, minWidth, maxWidth, 'collapsed')).toBe(320);
  });

  it('keeps responsive minimum width within a narrow viewport', () => {
    expect(getChatPanelResizeWidth(120, 120, 120, 'expanded')).toBe(120);
    expect(getChatPanelResizeWidth(120, 120, 120, 'collapsing')).toBe(120);
  });

  it('re-enters collapse only after the half-width threshold is crossed again', () => {
    expect(getNextChatPanelResizePhase('expanding', 200, minWidth)).toBe('expanding');
    expect(getNextChatPanelResizePhase('expanding', 160, minWidth)).toBe('collapsing');
  });
});
