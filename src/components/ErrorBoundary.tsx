import { Component, type ErrorInfo, type ReactNode } from 'react';
import './ErrorBoundary.css';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 根级错误边界：渲染崩溃落成一张可恢复的报错页，绝不留纯白。
 * 画布与图片都存在 bridge 侧，「重试渲染」不清状态，「重新加载」整页重来，两条路都不丢数据。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[绘板] 渲染崩溃：', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  private handleCopy = () => {
    const error = this.state.error;
    if (!error) return;
    const text = `${error.name}: ${error.message}\n${error.stack ?? ''}`;
    void navigator.clipboard?.writeText(text).catch(() => {
      // 剪贴板拿不到就静默失败：错误信息已在屏幕上，用户可手动选取复制
    });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="hb-error-screen" role="alert">
        <section className="hb-error-card">
          <strong className="hb-error-title">页面出错了</strong>
          <p className="hb-error-desc">
            界面在这里停下来，而不是变成一片白。画布和图片都保存在本机 bridge 里，不会丢；点「重试渲染」回去，不行再「重新加载」。
          </p>
          <pre className="hb-error-message">{error.message || String(error)}</pre>
          <div className="hb-error-actions">
            <button type="button" className="hb-error-action is-primary" onClick={this.handleRetry}>重试渲染</button>
            <button type="button" className="hb-error-action" onClick={this.handleReload}>重新加载</button>
            <button type="button" className="hb-error-action is-ghost" onClick={this.handleCopy}>复制错误信息</button>
          </div>
        </section>
      </div>
    );
  }
}
