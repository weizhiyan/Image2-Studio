import { useEffect, useRef, useState } from 'react';
import CanvasPage from '@/pages/CanvasPage';
import WorkbenchPage, { isWorkbenchPath } from '@/pages/WorkbenchPage';
import ErrorBoundary from '@/components/ErrorBoundary';
import '@/styles/mode-transition.css';

type AppMode = 'canvas' | 'workbench';
type ModeTransition = { from: AppMode; to: AppMode; phase: 'exit' | 'enter' };

const EXIT_MS = 360;
const TOTAL_MS = { canvas: 820, workbench: 1000 } as const;

function modeOfPath(pathname: string): AppMode {
  return isWorkbenchPath(pathname) ? 'workbench' : 'canvas';
}

export default function App() {
  const [mode, setMode] = useState<AppMode>(() => (
    typeof window === 'undefined' ? 'canvas' : modeOfPath(window.location.pathname)
  ));
  const [transition, setTransition] = useState<ModeTransition | null>(null);
  const modeRef = useRef(mode);
  const timersRef = useRef<number[]>([]);
  modeRef.current = mode;

  useEffect(() => {
    const clearTimers = () => {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current = [];
    };
    const syncPathname = () => {
      const next = modeOfPath(window.location.pathname);
      if (next === modeRef.current) return;
      const from = modeRef.current;
      clearTimers();
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTransition(null);
        setMode(next);
        return;
      }
      // 先挂载目标页、保留来源页，退出结束后再卸载来源页并播放目标页入场。
      setTransition({ from, to: next, phase: 'exit' });
      setMode(next);
      timersRef.current.push(window.setTimeout(() => {
        setTransition({ from, to: next, phase: 'enter' });
      }, EXIT_MS));
      timersRef.current.push(window.setTimeout(() => {
        setTransition(null);
      }, TOTAL_MS[next]));
    };
    window.addEventListener('popstate', syncPathname);
    return () => {
      window.removeEventListener('popstate', syncPathname);
      clearTimers();
    };
  }, []);

  const outgoing = transition?.phase === 'exit' ? transition.from : null;
  const incoming = transition?.to || null;
  const canvasMounted = mode === 'canvas' || outgoing === 'canvas';
  const workbenchMounted = mode === 'workbench' || outgoing === 'workbench';

  const layerClass = (target: AppMode) => [
    'app-mode-layer',
    (target === 'canvas' ? canvasMounted : workbenchMounted) ? 'is-mounted' : '',
    mode === target ? 'is-current' : '',
    outgoing === target ? 'is-outgoing' : '',
    incoming === target ? 'is-incoming' : '',
    incoming === target && transition?.phase === 'enter' ? 'is-entering' : '',
  ].filter(Boolean).join(' ');

  return (
    <ErrorBoundary>
      <div className="app-mode-root">
        <div className={layerClass('canvas')} data-mode="canvas" aria-hidden={mode !== 'canvas'}>
          {canvasMounted ? <CanvasPage /> : null}
        </div>
        <div className={layerClass('workbench')} data-mode="workbench" aria-hidden={mode !== 'workbench'}>
          {workbenchMounted ? <WorkbenchPage /> : null}
        </div>
      </div>
    </ErrorBoundary>
  );
}
