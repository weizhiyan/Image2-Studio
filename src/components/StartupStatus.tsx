import type { ServiceHealth } from '@/lib/bridge';
import './StartupStatus.css';

interface StartupStatusProps {
  mode: 'checking' | 'offline' | 'model-warning';
  checking?: boolean;
  overlay?: boolean;
  imageModel?: ServiceHealth['imageModel'];
  onRetry?: () => void;
  onOpenSettings?: () => void;
}

export default function StartupStatus({
  mode,
  checking = false,
  overlay = false,
  imageModel,
  onRetry,
  onOpenSettings,
}: StartupStatusProps) {
  if (mode === 'model-warning') {
    const configured = Boolean(imageModel?.configured);
    return (
      <aside className="hb-startup-notice" role="status" aria-live="polite">
        <span className="hb-startup-notice-mark" aria-hidden="true">!</span>
        <div className="hb-startup-notice-copy">
          <strong>{configured ? '模型列表尚未拉取' : '生图模型尚未配置'}</strong>
          <p>{configured
            ? `“${imageModel?.profileName || '当前配置'}”已填写默认模型“${imageModel?.modelName || '未命名'}”，但还没有拉取可选模型列表。可以继续尝试生成，若调用失败请先获取模型列表并保存。`
            : '当前没有完整可用的生图配置。请补全 API 地址、Key 和默认模型后再生成，避免操作失败。'}</p>
        </div>
        <button type="button" className="hb-startup-action" onClick={onOpenSettings}>
          打开模型设置
        </button>
      </aside>
    );
  }

  const isChecking = mode === 'checking';
  return (
    <main className={`hb-startup-screen${overlay ? ' is-overlay' : ''}`} role={isChecking ? 'status' : 'alert'}>
      <section className="hb-startup-card">
        <span className={`hb-startup-mark${isChecking ? ' is-loading' : ''}`} aria-hidden="true">
          {isChecking ? '…' : '!'}</span>
        <h1>{isChecking ? '正在连接绘板后台' : overlay ? '后台连接已中断' : '绘板后台未启动'}</h1>
        <p>
          {isChecking
            ? '正在检查本机服务状态，请稍候。'
            : overlay
              ? '页面保持在当前状态；后台恢复后重新检查即可继续，不会自动刷新。'
              : '页面服务和绘板后台需要同时运行。后台未响应时，配置、画布同步和模型调用都不可用。启动绘板后台后重新检查。'}
        </p>
        {!isChecking ? (
          <button type="button" className="hb-startup-action is-primary" disabled={checking} onClick={onRetry}>
            {checking ? '正在检查…' : '重新检查'}
          </button>
        ) : null}
      </section>
    </main>
  );
}
