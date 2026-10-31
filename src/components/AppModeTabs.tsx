import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { applyTheme, readStoredTheme, type AppTheme } from '@/lib/theme';
import './AppModeTabs.css';

export type AppMode = 'canvas' | 'workbench';

const MODES = [
  { id: 'canvas', label: '无限画布', actionLabel: '切换到无限画布', path: '/' },
  { id: 'workbench', label: '工作台', actionLabel: '切换到工作台', path: '/workbench' },
] as const satisfies ReadonlyArray<{
  id: AppMode;
  label: string;
  actionLabel: string;
  path: string;
}>;

const LOGO_SRC = '/logo.png';

interface AppModeTabsProps {
  mode: AppMode;
}

function ModeIcon({ mode }: { mode: AppMode }) {
  if (mode === 'canvas') {
    return (
      <svg className="app-mode-tabs__mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path
          d="M17.6834 2.52637C18.6886 2.52637 19.6526 2.92567 20.3633 3.63643C21.0741 4.3472 21.4734 5.3112 21.4734 6.31637V17.6844C21.4734 18.6895 21.0741 19.6535 20.3633 20.3643C19.6526 21.0751 18.6886 21.4744 17.6834 21.4744H6.31539C5.31022 21.4744 4.34622 21.0751 3.63546 20.3643C2.92469 19.6535 2.52539 18.6895 2.52539 17.6844V6.31637C2.52539 5.3112 2.92469 4.3472 3.63546 3.63643C4.34622 2.92567 5.31022 2.52637 6.31539 2.52637H17.6834ZM13.5234 6.75937C13.2034 6.74337 12.9064 6.85437 12.6894 6.95737C12.4337 7.08393 12.1894 7.23249 11.9594 7.40137C10.9824 8.09937 9.66739 9.37737 8.33239 10.8214C6.9547 12.3166 5.64311 13.8714 4.40139 15.4814C4.3333 15.5666 4.2829 15.6646 4.25312 15.7696C4.22334 15.8746 4.21479 15.9844 4.22796 16.0928C4.24113 16.2011 4.27576 16.3057 4.32983 16.4005C4.3839 16.4953 4.45633 16.5783 4.54287 16.6448C4.62941 16.7112 4.72833 16.7598 4.83385 16.7876C4.93937 16.8154 5.04937 16.8218 5.15742 16.8066C5.26548 16.7914 5.36941 16.7548 5.46316 16.699C5.5569 16.6431 5.63857 16.5691 5.70339 16.4814C6.91488 14.9112 8.19443 13.3948 9.53839 11.9364C10.7714 10.6024 11.9124 9.49637 12.7334 8.87037C12.6294 9.16237 12.4834 9.52137 12.2874 9.95637C11.8694 10.8804 11.2474 12.0924 10.3774 13.6424C9.93739 14.4264 9.64339 15.0034 9.54439 15.3684C9.50257 15.5121 9.48765 15.6623 9.50039 15.8114C9.52339 16.0244 9.65139 16.4094 10.0824 16.5614C10.3924 16.6714 10.6624 16.5744 10.7414 16.5434C10.8564 16.5004 10.9584 16.4404 11.0344 16.3934C11.3194 16.2104 11.7164 15.8684 12.1084 15.5284L12.2024 15.4484C12.5964 15.1064 13.0344 14.7264 13.4914 14.3654C13.9864 13.9734 14.4774 13.6224 14.9264 13.3774C15.3964 13.1204 15.7164 13.0384 15.8964 13.0474C15.9225 13.0483 15.9484 13.0527 15.9734 13.0604C15.9874 13.0649 16.0005 13.0717 16.0124 13.0804C16.0324 13.0944 16.0874 13.1404 16.1484 13.2804C16.2834 13.5864 16.3884 14.1924 16.3154 15.2804L16.3134 15.3024V15.3354C16.3134 15.5664 16.3454 15.8414 16.4334 16.1124C16.5214 16.3774 16.6854 16.7004 16.9944 16.9394C17.7234 17.5024 18.6274 17.2194 19.4244 16.6514C19.5122 16.5887 19.5868 16.5094 19.6439 16.4179C19.701 16.3265 19.7396 16.2246 19.7574 16.1183C19.7752 16.0119 19.7718 15.9031 19.7475 15.798C19.7233 15.6929 19.6785 15.5937 19.6159 15.5059C19.5532 15.4181 19.4739 15.3435 19.3825 15.2864C19.291 15.2292 19.1892 15.1907 19.0828 15.1729C18.9764 15.1551 18.8676 15.1584 18.7625 15.1827C18.6574 15.207 18.5582 15.2517 18.4704 15.3144C18.2374 15.4804 18.0804 15.5524 17.9884 15.5814C17.968 15.5087 17.9569 15.4338 17.9554 15.3584C18.0304 14.2014 17.9454 13.2844 17.6514 12.6184C17.5069 12.2712 17.2713 11.9695 16.9694 11.7454C16.6783 11.5385 16.3332 11.4211 15.9764 11.4074C15.3344 11.3764 14.6864 11.6374 14.1394 11.9364C13.6084 12.2368 13.1019 12.5786 12.6244 12.9584C13.1054 12.0554 13.4884 11.2844 13.7834 10.6334C14.2194 9.66937 14.4904 8.90637 14.5694 8.34637C14.6074 8.07837 14.6214 7.73137 14.4794 7.41237C14.3957 7.22045 14.2586 7.05662 14.0844 6.94037C13.917 6.83106 13.7232 6.76888 13.5234 6.76037V6.75937Z"
          fill="currentColor"
        />
      </svg>
    );
  }

  return (
    <svg className="app-mode-tabs__mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="11.043" y="3.55469" width="11.3798" height="7.77291" rx="1.8" fill="currentColor" />
      <rect x="11.043" y="12.6729" width="11.3798" height="7.77291" rx="1.8" fill="currentColor" />
      <rect
        x="9.34961"
        y="3.55469"
        width="16.8909"
        height="7.77291"
        rx="1.8"
        transform="rotate(90 9.34961 3.55469)"
        fill="currentColor"
      />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: AppTheme }) {
  if (theme === 'system') {
    return (
      <svg className="app-mode-tabs__theme-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        <rect x="2.75" y="3.25" width="14.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 16.75h6M10 13.75v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (theme === 'light') {
    return (
      <svg className="app-mode-tabs__theme-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="3.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 2.25v1.5M10 16.25v1.5M2.25 10h1.5M16.25 10h1.5M4.52 4.52l1.06 1.06M14.42 14.42l1.06 1.06M15.48 4.52l-1.06 1.06M5.58 14.42l-1.06 1.06" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg className="app-mode-tabs__theme-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d="M16.3 12.35A6.75 6.75 0 0 1 7.65 3.7a6.75 6.75 0 1 0 8.65 8.65Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export default function AppModeTabs({ mode }: AppModeTabsProps) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<AppTheme>(readStoredTheme);
  const rootRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRef = useRef<HTMLAnchorElement>(null);
  const menuId = useId();
  const current = MODES.find((item) => item.id === mode) ?? MODES[0];
  const target = MODES.find((item) => item.id !== mode) ?? MODES[1];

  useEffect(() => {
    setOpen(false);
  }, [mode]);

  useEffect(() => {
    if (!open) return undefined;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    window.addEventListener('pointerdown', closeOnOutsidePointer, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => menuItemRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: string, active: boolean) => {
    setOpen(false);
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

  const chooseTheme = (nextTheme: AppTheme) => {
    setTheme(nextTheme);
    const rect = triggerRef.current?.getBoundingClientRect();
    applyTheme(nextTheme, {
      origin: rect
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : undefined,
    });
  };

  return (
    <nav className="app-mode-tabs" aria-label="绘板菜单" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="app-mode-tabs__trigger"
        aria-label={`当前为${current.label}，打开菜单`}
        title={`当前为${current.label}，打开菜单`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        <img className="app-mode-tabs__logo" src={LOGO_SRC} alt="" width={44} height={44} draggable={false} />
      </button>
      <div
        id={menuId}
        className="app-mode-tabs__menu"
        role="menu"
        aria-label="绘板菜单"
        hidden={!open}
      >
        <a
          ref={menuItemRef}
          className="app-mode-tabs__menu-item"
          href={target.path}
          role="menuitem"
          onClick={(event) => navigate(event, target.path, target.id === mode)}
        >
          <ModeIcon mode={target.id} />
          <span>{target.actionLabel}</span>
        </a>
        <div className="app-mode-tabs__separator" role="separator" />
        <div className="app-mode-tabs__appearance" role="group" aria-label="外观">
          <button
            type="button"
            className="app-mode-tabs__theme-option"
            role="menuitemradio"
            aria-checked={theme === 'system'}
            onClick={() => chooseTheme('system')}
          >
            <ThemeIcon theme="system" />
            <span>跟随系统</span>
          </button>
          <button
            type="button"
            className="app-mode-tabs__theme-option"
            role="menuitemradio"
            aria-checked={theme === 'light'}
            onClick={() => chooseTheme('light')}
          >
            <ThemeIcon theme="light" />
            <span>浅色</span>
          </button>
          <button
            type="button"
            className="app-mode-tabs__theme-option"
            role="menuitemradio"
            aria-checked={theme === 'dark'}
            onClick={() => chooseTheme('dark')}
          >
            <ThemeIcon theme="dark" />
            <span>深色</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
