import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import StartupStatus from './components/StartupStatus';
import { getServiceHealth, type ServiceHealth } from './lib/bridge';
import './styles/global.css';

function Bootstrap() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const requestInFlight = useRef(false);

  const checkService = useCallback(async (showLoading = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (showLoading) setChecking(true);
    try {
      const next = await getServiceHealth();
      setHealth(next);
      setConnected(true);
      setEverConnected(true);
    } catch {
      setConnected(false);
    } finally {
      requestInFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkService(true);
    const interval = window.setInterval(() => void checkService(), 10000);
    const refreshAfterSave = () => void checkService();
    window.addEventListener('huiban:settings-saved', refreshAfterSave);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('huiban:settings-saved', refreshAfterSave);
    };
  }, [checkService]);

  const openModelSettings = () => {
    window.dispatchEvent(new CustomEvent('huiban:open-settings', {
      detail: { path: window.location.pathname.startsWith('/workbench') ? 'workbench' : 'canvas' },
    }));
  };

  if (!everConnected) {
    return <StartupStatus mode={checking ? 'checking' : 'offline'} checking={checking} onRetry={() => void checkService(true)} />;
  }

  return (
    <>
      <App />
      {!connected ? (
        <StartupStatus mode="offline" checking={checking} overlay onRetry={() => void checkService(true)} />
      ) : null}
      {connected && health && (!health.imageModel.configured || !health.imageModel.modelsLoaded) ? (
        <StartupStatus
          mode="model-warning"
          imageModel={health.imageModel}
          onOpenSettings={openModelSettings}
        />
      ) : null}
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Bootstrap />
  </React.StrictMode>,
);
