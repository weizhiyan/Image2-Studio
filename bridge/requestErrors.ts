class NetworkFailure extends Error {}

export function networkErrorCode(error: unknown): string {
  const value = error as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } } | null;
  const code = String(value?.cause?.code || value?.cause?.errors?.[0]?.code || value?.code || '');
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : '';
}

export function safeToRetryImageConnection(error: unknown): boolean {
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(networkErrorCode(error));
}

export function describeNetworkFailure(error: unknown, stage: 'text' | 'image' | 'download'): Error | null {
  if (error instanceof NetworkFailure) return error;
  const code = networkErrorCode(error);
  const message = error instanceof Error ? error.message : '';
  if (!/^(?:E(?:CONN|TIMEDOUT|NOTFOUND|AI_AGAIN|PIPE)|UND_ERR_)/.test(code)
    && !/^(?:fetch failed|terminated)$/i.test(message)
    && !(error instanceof Error && error.name === 'TimeoutError')) return null;
  const suffix = code ? `（${code}）` : '';
  const context = stage === 'download'
    ? '上游已返回图片地址，但下载图片时连接中断'
    : stage === 'image'
      ? '生图请求连接中断，未收到完整结果，无法确认上游是否已完成'
      : '提示词模型连接中断或超时，未收到完整提示词';
  return new NetworkFailure(`${context}${suffix}。请检查网络、代理或该模型服务状态后重试。`, { cause: error });
}
