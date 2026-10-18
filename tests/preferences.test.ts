import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEntries, readRecentCreations } from '../bridge/preferences';
import fs from 'node:fs/promises';

afterEach(() => vi.restoreAllMocks());

describe('偏好归纳结果', () => {
  it('只接受明确的 JSON 条目', () => {
    expect(parseEntries('[{"text":"偏好柔和自然光"}]').map((entry) => entry.text)).toEqual(['偏好柔和自然光']);
    expect(parseEntries('```json\n[{"text":"偏好留白"}]\n```').map((entry) => entry.text)).toEqual(['偏好留白']);
  });

  it('模型解释或普通列表不能变成长期偏好', () => {
    expect(parseEntries('没有足够证据归纳。')).toEqual([]);
    expect(parseEntries('- 我认为用户可能喜欢蓝色\n- 仅供参考')).toEqual([]);
    expect(parseEntries('[{"content":"偏好蓝色"}]')).toEqual([]);
    expect(parseEntries('以下是结果：[{"text":"偏好蓝色"}]')).toEqual([]);
  });
});

describe('偏好归纳证据', () => {
  it('取最近的不同提示词，同一提示词多次生成不占满上限', async () => {
    const nodes = [
      ...Array.from({ length: 40 }, (_, index) => ({ data: { kind: 'image', imageUrl: '/a.png', prompt: '同一句', createdAt: `2026-09-27T12:${String(index).padStart(2, '0')}:00Z` } })),
      { data: { kind: 'image', imageUrl: '/b.png', prompt: '另一句', createdAt: '2026-09-26T12:00:00Z' } },
    ];
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({ canvas: { nodes } }));
    expect((await readRecentCreations()).map((item) => item.prompt)).toEqual(['同一句', '另一句']);
  });
});
