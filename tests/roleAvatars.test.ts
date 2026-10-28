import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_AVATARS } from '../src/lib/roleAvatars';

describe('内置角色头像', () => {
  it('提供十六个独立裁切、轻量且可随项目部署的 WebP 头像', () => {
    expect(ROLE_AVATARS).toHaveLength(16);
    expect(new Set(ROLE_AVATARS.map((avatar) => avatar.name)).size).toBe(16);
    const hashes = ROLE_AVATARS.map((avatar) => {
      const file = readFileSync(new URL(`../public${avatar.url}`, import.meta.url));
      expect(file.subarray(0, 4).toString()).toBe('RIFF');
      expect(file.subarray(8, 12).toString()).toBe('WEBP');
      expect(file.byteLength).toBeLessThan(32_768);
      return createHash('sha256').update(file).digest('hex');
    });
    expect(new Set(hashes).size).toBe(16);
  });
});
