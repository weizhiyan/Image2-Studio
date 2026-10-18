import { describe, expect, it } from 'vitest';
import type { CanvasNodeData } from '@/types';
import { activeVersionOf, isReditVersion, newestVersionsFirst, normalizeVersions, reditCountOf, versionIndexOf, versionLabel } from '@/lib/versions';

function version(id: string, extra: Record<string, unknown> = {}) {
  return { id, imageUrl: `/api/files/${id}.png`, fileName: `${id}.png`, prompt: `p-${id}`, model: 'm', size: '1024x1024', createdAt: '2026-09-23T10:00:00Z', finishedAt: '2026-09-23T10:00:01Z', ...extra };
}

describe('结果节点版本链', () => {
  it('老节点（只有 imageUrl）按当前图补成一版', () => {
    const data: CanvasNodeData = {
      kind: 'image', label: '结果', imageUrl: '/api/files/a.png', fileName: 'a.png',
      prompt: '一只猫', model: 'gpt-image', size: '1024x1024',
    };
    const versions = normalizeVersions(data);
    expect(versions).toHaveLength(1);
    expect(versions[0].imageUrl).toBe('/api/files/a.png');
    expect(versions[0].prompt).toBe('一只猫');
    expect(activeVersionOf(data)).toEqual(versions[0]);
  });

  it('没有图的节点版本链为空', () => {
    expect(normalizeVersions({ kind: 'composer', label: 'x' })).toEqual([]);
    expect(activeVersionOf({ kind: 'composer', label: 'x' })).toBeNull();
    expect(reditCountOf({ kind: 'composer', label: 'x' })).toBe(0);
  });

  it('默认取最新一版，activeVersionId 可指定主图', () => {
    const data: CanvasNodeData = { kind: 'image', label: 'r', versions: [version('v1'), version('v2'), version('v3')] };
    expect(activeVersionOf(data)?.id).toBe('v3');
    expect(activeVersionOf({ ...data, activeVersionId: 'v1' })?.id).toBe('v1');
    expect(versionIndexOf(data, 'v2')).toBe(2);
    expect(versionIndexOf(data, 'nope')).toBe(0);
    expect(versionLabel(2)).toBe('V2');
    expect(reditCountOf(data)).toBe(2);
  });

  it('展开版本时最新生成的一版始终排在第一位', () => {
    const data: CanvasNodeData = { kind: 'image', label: 'r', activeVersionId: 'v1', versions: [version('v1'), version('v2'), version('v3')] };
    expect(newestVersionsFirst(data).map((item) => item.id)).toEqual(['v3', 'v2', 'v1']);
  });

  it('activeVersionId 指向已删除的版本时回落到最新一版', () => {
    const data: CanvasNodeData = { kind: 'image', label: 'r', activeVersionId: 'gone', versions: [version('v1'), version('v2')] };
    expect(activeVersionOf(data)?.id).toBe('v2');
  });

  it('二次编辑来的版本带 baseVersionId', () => {
    const data: CanvasNodeData = { kind: 'image', label: 'r', versions: [version('v1'), version('v2', { baseVersionId: 'v1' })] };
    expect(isReditVersion(activeVersionOf(data) ?? undefined)).toBe(true);
    expect(isReditVersion(normalizeVersions(data)[0])).toBe(false);
  });
});
