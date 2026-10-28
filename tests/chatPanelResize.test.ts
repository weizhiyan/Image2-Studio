import { describe, expect, it } from 'vitest';
import { getChatPanelResizeFrame } from '@/lib/chatPanelResize';

describe('chat panel resize frame', () => {
  it('fades content across the readable width boundary', () => {
    const full = getChatPanelResizeFrame(320, 320);
    const midFade = getChatPanelResizeFrame(314, 320);
    const hidden = getChatPanelResizeFrame(308, 320);

    expect(full.contentOpacity).toBe(1);
    expect(midFade.contentOpacity).toBe(0.5);
    expect(hidden.contentOpacity).toBe(0);
    expect(hidden.contentHidden).toBe(true);
  });

  it('slides the collapsed shell out continuously and reverses along the same values', () => {
    const collapsed = getChatPanelResizeFrame(160, 320);
    const furtherCollapsed = getChatPanelResizeFrame(80, 320);
    const fullyCollapsed = getChatPanelResizeFrame(0, 320);
    const expandedAgain = getChatPanelResizeFrame(80, 320);

    expect(collapsed).toMatchObject({
      shellWidth: 160,
      collapseOffset: 0,
      shellOpacity: 1,
      collapsed: true,
    });
    expect(furtherCollapsed).toMatchObject({
      shellWidth: 160,
      collapseOffset: 80,
      shellOpacity: 0.5,
      collapsed: true,
    });
    expect(fullyCollapsed).toMatchObject({
      shellWidth: 160,
      collapseOffset: 160,
      shellOpacity: 0,
      collapsed: true,
    });
    expect(expandedAgain).toEqual(furtherCollapsed);
    expect(getChatPanelResizeFrame(161, 320).collapsed).toBe(false);
  });

  it('keeps the inner edge under the pointer throughout collapse and reversal', () => {
    const widths = [360, 320, 314, 240, 160, 159, 80, 0, -40, 0, 80, 160, 240, 320, 360];
    const frames = widths.map((width) => getChatPanelResizeFrame(width, 320));

    frames.forEach((frame, index) => {
      expect(frame.shellWidth - frame.collapseOffset).toBe(widths[index]);
      expect(frame.shellOpacity).toBeGreaterThanOrEqual(0);
      expect(frame.shellOpacity).toBeLessThanOrEqual(1);
      expect(frame.contentOpacity).toBeGreaterThanOrEqual(0);
      expect(frame.contentOpacity).toBeLessThanOrEqual(1);
    });
    expect(frames.at(-1)).toEqual(frames[0]);
  });

  it.each([160, 308, 320])('has no visible jump across the %ipx boundary', (boundary) => {
    const before = getChatPanelResizeFrame(boundary - 0.01, 320);
    const after = getChatPanelResizeFrame(boundary + 0.01, 320);

    expect(Math.abs(after.shellWidth - before.shellWidth)).toBeLessThan(0.03);
    expect(Math.abs(after.collapseOffset - before.collapseOffset)).toBeLessThan(0.03);
    expect(Math.abs(after.shellOpacity - before.shellOpacity)).toBeLessThan(0.002);
    expect(Math.abs(after.contentOpacity - before.contentOpacity)).toBeLessThan(0.002);
  });
});
