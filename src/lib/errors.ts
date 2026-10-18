/**
 * 网络层错误的人话翻译：用法对齐灵枢 sidecar 的 normalizeModelListError。
 * fetch 自己抛的是 "fetch failed" 这种底层字样，直接展示用户看不懂。
 */
export function describeRequestError(error: unknown, baseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/fetch failed|failed to fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|Couldn't connect|connect/i.test(message)) {
    const target = baseUrl.trim() || '该地址';
    return `连接失败：无法访问 ${target}。请检查 Base URL 是否填写正确、服务是否已启动；远程接口再确认网络与鉴权。`;
  }
  return message;
}
