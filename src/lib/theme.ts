export type AppTheme = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'huiban:theme';
const THEME_TRANSITION_CLASS = 'is-theme-transitioning';
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

let systemThemeQuery: MediaQueryList | null = null;
let systemThemeListener: ((event: MediaQueryListEvent) => void) | null = null;

export interface ThemeTransitionOrigin {
  x: number;
  y: number;
}

export function normalizeTheme(value: unknown): AppTheme {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'dark';
}

export function readStoredTheme(): AppTheme {
  if (typeof window === 'undefined') return 'dark';
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'dark';
  }
}

export function themeRevealRadius(
  origin: ThemeTransitionOrigin,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const farthestX = Math.max(origin.x, viewportWidth - origin.x);
  const farthestY = Math.max(origin.y, viewportHeight - origin.y);
  return Math.ceil(Math.hypot(farthestX, farthestY));
}

export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(SYSTEM_THEME_QUERY).matches;
}

export function resolveTheme(theme: AppTheme, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (theme !== 'system') return theme;
  return prefersDark ? 'dark' : 'light';
}

function stopWatchingSystemTheme(): void {
  if (!systemThemeQuery || !systemThemeListener) return;
  if (typeof systemThemeQuery.removeEventListener === 'function') {
    systemThemeQuery.removeEventListener('change', systemThemeListener);
  } else {
    systemThemeQuery.removeListener(systemThemeListener);
  }
  systemThemeQuery = null;
  systemThemeListener = null;
}

function watchSystemTheme(): void {
  stopWatchingSystemTheme();
  if (
    typeof window === 'undefined'
    || typeof document === 'undefined'
    || typeof window.matchMedia !== 'function'
  ) return;

  const query = window.matchMedia(SYSTEM_THEME_QUERY);
  const listener = (event: MediaQueryListEvent) => {
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
  };
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', listener);
  } else {
    query.addListener(listener);
  }
  systemThemeQuery = query;
  systemThemeListener = listener;
}

export function applyTheme(
  theme: AppTheme,
  options: { origin?: ThemeTransitionOrigin } = {},
): void {
  const resolvedTheme = resolveTheme(theme);

  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const origin = options.origin;
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = origin
      && !reduceMotion
      && root.dataset.theme !== resolvedTheme
      && typeof document.startViewTransition === 'function';

    const commitTheme = () => {
      root.dataset.theme = resolvedTheme;
    };

    if (canAnimate) {
      const radius = themeRevealRadius(origin, window.innerWidth, window.innerHeight);
      const cleanup = () => {
        root.classList.remove(THEME_TRANSITION_CLASS);
        root.style.removeProperty('--theme-reveal-x');
        root.style.removeProperty('--theme-reveal-y');
        root.style.removeProperty('--theme-reveal-radius');
      };

      root.classList.add(THEME_TRANSITION_CLASS);
      root.style.setProperty('--theme-reveal-x', `${origin.x}px`);
      root.style.setProperty('--theme-reveal-y', `${origin.y}px`);
      root.style.setProperty('--theme-reveal-radius', `${radius}px`);

      try {
        const transition = document.startViewTransition(commitTheme);
        void transition.finished.then(cleanup, cleanup);
      } catch {
        cleanup();
        commitTheme();
      }
    } else {
      commitTheme();
    }
  }
  if (theme === 'system') {
    watchSystemTheme();
  } else {
    stopWatchingSystemTheme();
  }
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing or a locked-down storage policy: the visual theme still applies.
  }
}
