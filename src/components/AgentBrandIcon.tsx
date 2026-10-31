export type AgentBrandKind = 'claude' | 'codex' | 'workbuddy' | 'generic';

/** 第三方 Agent 的简化标记：只借形状做区分，不用品牌 logo 资源。 */
export default function AgentBrandIcon({ kind, size = 18 }: { kind: AgentBrandKind; size?: number }) {
  if (kind === 'claude') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M9 1.9v14.2M1.9 9h14.2M3.9 3.9l10.2 10.2M14.1 3.9 3.9 14.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'codex') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M9 2.1 15 5.6v6.8L9 15.9l-6-3.5V5.6L9 2.1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="9" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9 6.6V2.1M11.1 10.2l3.9 2.2M6.9 10.2l-3.9 2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === 'workbuddy') {
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <rect x="2.4" y="2.4" width="13.2" height="13.2" rx="3.6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9 5.4 10.1 8l2.6 1.1-2.6 1.1L9 12.8 7.9 10.2 5.3 9.1 7.9 8 9 5.4Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.4" y="2.4" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.2" y="2.4" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.4" y="10.2" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10.2" y="10.2" width="5.4" height="5.4" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
