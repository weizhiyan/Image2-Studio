import type { ChatRuntimeSettings, MemorySettings } from '@/types';

// Browser-only value helpers. Kept in sync with server validation by regression tests;
// importing bridge/settings here would pull node:fs into the browser bundle.
export function defaultMemorySettings(): MemorySettings {
  return { enabled: true, shortTermMessageLimit: 12, shortTermTokenBudget: 4500, summaryTriggerTokens: 8000, summaryTargetTokens: 900, maxRecentOutputs: 4 };
}

const objectOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const bound = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;

export function normalizeMemorySettings(raw: unknown): MemorySettings {
  const value = objectOf(raw);
  const defaults = defaultMemorySettings();
  const shortTermTokenBudget = bound(value.shortTermTokenBudget, defaults.shortTermTokenBudget, 2000, 16000);
  const summaryTargetTokens = bound(value.summaryTargetTokens, defaults.summaryTargetTokens, 300, 1600);
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : defaults.enabled,
    shortTermMessageLimit: bound(value.shortTermMessageLimit, defaults.shortTermMessageLimit, 6, 40),
    shortTermTokenBudget,
    summaryTriggerTokens: Math.max(shortTermTokenBudget + summaryTargetTokens, bound(value.summaryTriggerTokens, defaults.summaryTriggerTokens, 4000, 24000)),
    summaryTargetTokens,
    maxRecentOutputs: bound(value.maxRecentOutputs, defaults.maxRecentOutputs, 1, 4),
  };
}

export function defaultChatRuntimeSettings(): ChatRuntimeSettings {
  return { maxModelRounds: 4, maxToolCalls: 2, maxImagesPerRun: 4, confirmImagesAbove: 1, maxOutputTokens: 4096 };
}

export function normalizeChatRuntimeSettings(raw: unknown): ChatRuntimeSettings {
  const value = objectOf(raw);
  const defaults = defaultChatRuntimeSettings();
  return {
    maxModelRounds: bound(value.maxModelRounds, defaults.maxModelRounds, 4, 8),
    maxToolCalls: bound(value.maxToolCalls, defaults.maxToolCalls, 1, 2),
    maxImagesPerRun: bound(value.maxImagesPerRun, defaults.maxImagesPerRun, 1, 8),
    confirmImagesAbove: 1,
    maxOutputTokens: bound(value.maxOutputTokens, defaults.maxOutputTokens, 2048, 8192),
  };
}
