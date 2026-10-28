export interface VideoPlaybackStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface VideoPlaybackStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
  getServerSnapshot: () => boolean;
  setMuted: (muted: boolean) => void;
  toggle: () => void;
}

export const VIDEO_MUTED_STORAGE_KEY = 'huiban-video-playback-muted';

function browserStorage(): VideoPlaybackStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * 视频声音是播放偏好，不是节点数据：所有视频节点共享同一份静音状态，
 * 切换节点、刷新页面后都保持一致。存储不可用时退化为内存状态，不影响播放。
 */
export function createVideoPlaybackStore(storage: VideoPlaybackStorage | null): VideoPlaybackStore {
  let muted = false;
  try {
    muted = storage?.getItem(VIDEO_MUTED_STORAGE_KEY) === '1';
  } catch {
    muted = false;
  }
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const setMuted = (next: boolean) => {
    if (muted === next) return;
    muted = next;
    try {
      storage?.setItem(VIDEO_MUTED_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // 隐私模式 / 配额受限时只保留当前会话状态。
    }
    emit();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => muted,
    getServerSnapshot: () => false,
    setMuted,
    toggle() {
      setMuted(!muted);
    },
  };
}

export const videoPlaybackStore = createVideoPlaybackStore(browserStorage());
