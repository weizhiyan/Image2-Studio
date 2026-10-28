import { describe, expect, it, vi } from 'vitest';
import {
  VIDEO_MUTED_STORAGE_KEY,
  createVideoPlaybackStore,
  type VideoPlaybackStorage,
} from '@/lib/videoPlayback';

function memoryStorage(initial: Record<string, string> = {}): VideoPlaybackStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('视频播放静音状态', () => {
  it('默认有声音', () => {
    const store = createVideoPlaybackStore(memoryStorage());
    expect(store.getSnapshot()).toBe(false);
    expect(store.getServerSnapshot()).toBe(false);
  });

  it('切换后通知订阅者并持久化', () => {
    const storage = memoryStorage();
    const store = createVideoPlaybackStore(storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.toggle();
    expect(store.getSnapshot()).toBe(true);
    expect(storage.values.get(VIDEO_MUTED_STORAGE_KEY)).toBe('1');
    expect(listener).toHaveBeenCalledTimes(1);

    store.setMuted(false);
    expect(storage.values.get(VIDEO_MUTED_STORAGE_KEY)).toBe('0');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.toggle();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('启动时读取已保存的静音偏好', () => {
    const store = createVideoPlaybackStore(memoryStorage({ [VIDEO_MUTED_STORAGE_KEY]: '1' }));
    expect(store.getSnapshot()).toBe(true);
  });

  it('存储读写抛错时仍可正常切换', () => {
    const storage: VideoPlaybackStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const store = createVideoPlaybackStore(storage);
    expect(store.getSnapshot()).toBe(false);
    expect(() => store.toggle()).not.toThrow();
    expect(store.getSnapshot()).toBe(true);
  });
});
