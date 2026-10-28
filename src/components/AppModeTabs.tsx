import type { MouseEvent } from 'react';
import './AppModeTabs.css';

export type AppMode = 'canvas' | 'workbench';

const MODES = [
  { id: 'canvas', label: '无限画布', path: '/' },
  { id: 'workbench', label: '工作台', path: '/workbench' },
] as const satisfies ReadonlyArray<{ id: AppMode; label: string; path: string }>;

interface AppModeTabsProps {
  mode: AppMode;
}

export default function AppModeTabs({ mode }: AppModeTabsProps) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: string, active: boolean) => {
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;

    event.preventDefault();
    if (active || typeof window === 'undefined') return;

    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  return (
    <nav className="app-mode-tabs" aria-label="工作模式">
      {MODES.map((item) => {
        const active = item.id === mode;
        return (
          <a
            key={item.id}
            className="app-mode-tabs__link"
            href={item.path}
            aria-current={active ? 'page' : undefined}
            onClick={(event) => navigate(event, item.path, active)}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
