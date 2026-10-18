/** 比例「自动」档 / 分辨率 / 生成数量的纯函数测试。 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_RATIO,
  clampImageCount,
  IMAGE_SIZE_LIMITS,
  MAX_IMAGE_COUNT,
  pickSizeForResolution,
  ratioToLabel,
  referenceRatio,
  resolveAutoRatio,
} from '@/lib/aspect';

describe('referenceRatio', () => {
  it('取第一张带尺寸的参考图', () => {
    expect(referenceRatio([{ width: 1920, height: 1080 }])).toBe(0.56); // formatRatio 两位小数舍入：1080/1920=0.5625 -> 0.56
    expect(referenceRatio([{ width: 100, height: 500 }, { width: 200, height: 100 }])).toBeCloseTo(5, 5);
  });

  it('没有可用尺寸时返回 0（交给上层退回 1:1）', () => {
    expect(referenceRatio(undefined)).toBe(0);
    expect(referenceRatio([{}, { width: 0, height: 10 }])).toBe(0);
  });
});

describe('resolveAutoRatio', () => {
  it('提示词写明比例时优先', () => {
    expect(resolveAutoRatio({ prompt: '来一张 9:16 的海报', references: [{ width: 1920, height: 1080 }] })).toBe(1.78); // 提示词 9:16 竖幅 -> 高/宽 16/9，两位小数 1.78
  });

  it('提示词没写时按参考图比例', () => {
    expect(resolveAutoRatio({ prompt: '一只柴犬', references: [{ width: 1024, height: 1536 }] })).toBe(1.5);
  });

  it('都没有时退回 1:1', () => {
    expect(resolveAutoRatio({ prompt: '一只柴犬', references: [] })).toBe(1);
    expect(resolveAutoRatio({})).toBe(1);
  });
});

describe('pickSizeForResolution', () => {
  it('1:1 各档都是正方形', () => {
    expect(pickSizeForResolution(1, '1K')).toBe('1024x1024');
    expect(pickSizeForResolution(1, '2K')).toBe('2048x2048');
    expect(pickSizeForResolution(1, '4K')).toBe('2880x2880'); // 4096 超过单边/总像素上限
  });

  it('横幅（高/宽<1）尽量接近档位，并按 16 的倍数取整', () => {
    expect(pickSizeForResolution(9 / 16, '1K')).toBe('1088x608'); // 1024x576 像素不足最低面积
    expect(pickSizeForResolution(9 / 16, '2K')).toBe('2048x1152');
  });

  it('竖幅（高/宽>=1）相反，长边是高', () => {
    expect(pickSizeForResolution(16 / 9, '1K')).toBe('608x1088'); // 576x1024 像素不足最低面积
    expect(pickSizeForResolution(16 / 9, '2K')).toBe('1152x2048');
    expect(pickSizeForResolution(4 / 3, '4K')).toBe('2480x3312'); // 长边与总像素均受官方上限约束
  });

  it('任何比例和档位都满足图像 API 的尺寸约束', () => {
    const ratios = [0.01, 1 / 3, 9 / 16, 1, 4 / 3, 16 / 9, 3, 20];
    for (const ratio of ratios) {
      for (const resolution of ['1K', '2K', '4K']) {
        const [width, height] = pickSizeForResolution(ratio, resolution).split('x').map(Number);
        const pixels = width * height;
        expect(width % IMAGE_SIZE_LIMITS.minEdge).toBe(0);
        expect(height % IMAGE_SIZE_LIMITS.minEdge).toBe(0);
        expect(Math.max(width, height)).toBeLessThanOrEqual(IMAGE_SIZE_LIMITS.maxEdge);
        expect(Math.max(width, height) / Math.min(width, height)).toBeLessThanOrEqual(IMAGE_SIZE_LIMITS.maxAspect);
        expect(pixels).toBeGreaterThanOrEqual(IMAGE_SIZE_LIMITS.minPixels);
        expect(pixels).toBeLessThanOrEqual(IMAGE_SIZE_LIMITS.maxPixels);
      }
    }
  });

  it('未知档位退回 1K', () => {
    expect(pickSizeForResolution(1, '8K')).toBe('1024x1024');
  });
});

describe('clampImageCount', () => {
  it('收敛到 1~8', () => {
    expect(clampImageCount(0)).toBe(1);
    expect(clampImageCount(9)).toBe(MAX_IMAGE_COUNT);
    expect(clampImageCount(2.7)).toBe(2);
    expect(clampImageCount(undefined)).toBe(1);
    expect(clampImageCount('abc')).toBe(1);
    expect(clampImageCount('3')).toBe(3);
  });
});

describe('ratioToLabel', () => {
  it('常见比例给标准标签', () => {
    expect(ratioToLabel(1)).toBe('1:1');
    expect(ratioToLabel(9 / 16)).toBe('9:16');
    expect(ratioToLabel(3 / 4)).toBe('3:4');
    expect(ratioToLabel(16 / 9)).toBe('16:9');
  });

  it('auto 哨兵与怪比例都有兜底', () => {
    expect(AUTO_RATIO).toBe('auto');
    expect(ratioToLabel(0)).toBe(AUTO_RATIO);
    expect(ratioToLabel(1.234)).toMatch(/^\d+:\d+$/);
  });
});
