import { describe, expect, it } from 'vitest';
import { composerWidthForRatio, detectPromptRatio, formatRatio, nodeAspectRatio, nodeBoxFor, nodeRatio, nodeWidthFor, nodeWidthForAspect, normalizeAspectRatio, parseSizeRatio, pickSize, ratioToNumber, requestedRatioFromPrompt } from '@/lib/aspect';
import type { CanvasNode, CanvasNodeData } from '@/types';

function node(data: Partial<CanvasNode['data']>): CanvasNode {
  return { id: 'n1', type: 'flow-image', position: { x: 0, y: 0 }, data: { kind: 'image', label: '', ...data } };
}

describe('parseSizeRatio', () => {
  it('解析标准尺寸字符串', () => {
    expect(parseSizeRatio('1024x1024')).toBe(1);
    expect(parseSizeRatio('1024x1536')).toBeCloseTo(1.5, 5);
    expect(parseSizeRatio('1536x1024')).toBeCloseTo(0.667, 3);
  });

  it('脏输入回落到 1', () => {
    expect(parseSizeRatio(undefined)).toBe(1);
    expect(parseSizeRatio('abc')).toBe(1);
    expect(parseSizeRatio('0x100')).toBe(1);
  });
});

describe('pickSize', () => {
  it('按比例选竖/横/方', () => {
    expect(pickSize(1)).toBe('1024x1024');
    expect(pickSize(1.5)).toBe('1024x1536');
    expect(pickSize(0.6)).toBe('1536x1024');
  });
});

describe('requestedRatioFromPrompt', () => {
  it('识别比例写法', () => {
    expect(requestedRatioFromPrompt('画一只猫 9:16 竖构图')).toBeCloseTo(16 / 9, 2);
    expect(requestedRatioFromPrompt('16:9 宽幅')).toBeCloseTo(9 / 16, 2);
  });

  it('识别中文横竖', () => {
    expect(requestedRatioFromPrompt('竖构图海报')).toBeCloseTo(4 / 3, 2);
    expect(requestedRatioFromPrompt('横构图 landscapes')).toBeCloseTo(3 / 4, 2);
  });

  it('没有线索时回落', () => {
    expect(requestedRatioFromPrompt('一只在月光下的猫', 0.8)).toBe(0.8);
  });
});

describe('nodeRatio', () => {
  it('位图真实尺寸优先', () => {
    expect(nodeRatio(node({ width: 800, height: 400 }))).toBe(0.5);
  });

  it('没有位图信息时用尺寸串', () => {
    expect(nodeRatio(node({ size: '1024x1536' }))).toBeCloseTo(1.5, 5);
  });
});

describe('formatRatio', () => {
  it('保留两位小数并兜底', () => {
    expect(formatRatio(1.23456)).toBe(1.23);
    expect(formatRatio(-1)).toBe(1);
  });
});

describe('ratioToNumber', () => {
  it('按宽:高解析成高度/宽度比例', () => {
    expect(ratioToNumber('16:9')).toBeCloseTo(0.56, 2);
    expect(ratioToNumber('3:4')).toBeCloseTo(1.33, 2);
    expect(ratioToNumber('9:16')).toBeCloseTo(1.78, 2);
    expect(ratioToNumber('1:1')).toBe(1);
  });

  it('脏输入返回 0（让调用方走默认尺寸）', () => {
    expect(ratioToNumber('')).toBe(0);
    expect(ratioToNumber('abc')).toBe(0);
    expect(ratioToNumber('16:0')).toBe(0);
  });
});

describe('detectPromptRatio', () => {
  it('没提画幅时返回 0', () => {
    expect(detectPromptRatio('一只在月光下的猫')).toBe(0);
  });

  it('提示词优先于工具栏预设', () => {
    expect(detectPromptRatio('竖构图 9:16')).toBeCloseTo(1.78, 2);
    expect(detectPromptRatio('16:9 宽幅')).toBeCloseTo(0.56, 2);
  });
});

describe('composerWidthForRatio', () => {
  it('横幅放宽、竖幅收窄、方图居中', () => {
    expect(composerWidthForRatio(0.56)).toBe(400);
    expect(composerWidthForRatio(1)).toBe(320);
    expect(composerWidthForRatio(1.78)).toBe(280);
    expect(composerWidthForRatio(0)).toBe(320);
  });
});

function data(partial: Partial<CanvasNodeData>): CanvasNodeData {
  return { kind: 'image', label: '', ...partial };
}

describe('normalizeAspectRatio', () => {
  it('非法值回 1，正常值钳在 0.35~3.2', () => {
    expect(normalizeAspectRatio(0)).toBe(1);
    expect(normalizeAspectRatio(-2)).toBe(1);
    expect(normalizeAspectRatio(Number.NaN)).toBe(1);
    expect(normalizeAspectRatio(8)).toBe(3.2);
    expect(normalizeAspectRatio(0.1)).toBe(0.35);
    expect(normalizeAspectRatio(1.5)).toBe(1.5);
  });
});

describe('nodeAspectRatio', () => {
  it('位图实际像素优先，且是宽/高（CSS aspect-ratio 同向）', () => {
    expect(nodeAspectRatio(data({ width: 1536, height: 1024 }))).toBeCloseTo(1.5, 5);
    expect(nodeAspectRatio(data({ width: 1024, height: 1536 }))).toBeCloseTo(0.667, 3);
    expect(nodeAspectRatio(data({ width: 1024, height: 1024 }))).toBe(1);
  });

  it('没有位图像素时按尺寸字符串', () => {
    expect(nodeAspectRatio(data({ size: '1536x1024' }))).toBeCloseTo(1.5, 5);
    expect(nodeAspectRatio(data({ size: '1024x1536' }))).toBeCloseTo(0.667, 3);
  });

  it('兜底按工具栏比例预设（label 经 ratioToNumber 的两位小数）', () => {
    expect(nodeAspectRatio(data({ ratio: '16:9' }))).toBeCloseTo(1 / ratioToNumber('16:9'), 5);
    expect(nodeAspectRatio(data({ ratio: '9:16' }))).toBeCloseTo(1 / ratioToNumber('9:16'), 5);
  });

  it('位图比例压过尺寸字符串和预设', () => {
    expect(nodeAspectRatio(data({ width: 1024, height: 1024, size: '1536x1024', ratio: '9:16' }))).toBe(1);
  });

  it('全空时回 1', () => {
    expect(nodeAspectRatio(data({}))).toBe(1);
  });
});

describe('nodeWidthForAspect', () => {
  it('横幅 400 / 标准 320 / 竖幅 280', () => {
    expect(nodeWidthForAspect(16 / 9)).toBe(400);
    expect(nodeWidthForAspect(1.5)).toBe(320);
    expect(nodeWidthForAspect(9 / 16)).toBe(280);
    expect(nodeWidthForAspect(0.7)).toBe(280);
    expect(nodeWidthForAspect(1.55)).toBe(400);
  });
});

describe('nodeWidthFor', () => {
  it('出图节点按真实比例重算，不受存的 cardWidth 影响', () => {
    expect(nodeWidthFor(data({ imageUrl: '/api/files/a.png', cardWidth: 400, width: 1024, height: 1536 }))).toBe(280);
    expect(nodeWidthFor(data({ referenceDataUrl: 'data:image/png;base64,x', width: 1920, height: 1080 }))).toBe(400);
  });

  it('composer 用 cardWidth，默认 320，钳在 280~600', () => {
    expect(nodeWidthFor(data({ kind: 'composer', cardWidth: 400 }))).toBe(400);
    expect(nodeWidthFor(data({ kind: 'composer' }))).toBe(320);
    expect(nodeWidthFor(data({ kind: 'composer', cardWidth: 50 }))).toBe(280);
    expect(nodeWidthFor(data({ kind: 'composer', cardWidth: 9999 }))).toBe(600);
  });
});

describe('nodeBoxFor', () => {
  it('出图节点：宽按比例，高 = 宽/比例（自动定位的居中盒子）', () => {
    const landscape = nodeBoxFor(data({ imageUrl: '/api/files/a.png', width: 1536, height: 1024 }));
    expect(landscape.width).toBe(320);
    expect(landscape.height).toBeCloseTo(213.33, 2);
    expect(nodeBoxFor(data({ imageUrl: '/api/files/a.png', width: 1024, height: 1536 }))).toEqual({ width: 280, height: 420 });
    expect(nodeBoxFor(data({ imageUrl: '/api/files/a.png', width: 1024, height: 1024 }))).toEqual({ width: 320, height: 320 });
  });

  it('composer：用 cardWidth，高按比例兜底', () => {
    const wide = nodeBoxFor(data({ kind: 'composer', cardWidth: 400, ratio: '16:9' }));
    expect(wide.width).toBe(400);
    expect(wide.height).toBeCloseTo(224, 6);
    expect(nodeBoxFor(data({ kind: 'composer' }))).toEqual({ width: 320, height: 320 });
  });
});
