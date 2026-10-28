import type { VideoModelSchema, VideoParamOption, VideoParamSpec } from '@/types';

export interface VideoSchemaDefaults {
  model: string;
  seconds: number;
  resolution: string;
  ratio: string;
}

export function videoUploadParamForMode(schema: VideoModelSchema, mode: string): VideoParamSpec | undefined {
  const uploadParams = schema.params.filter((spec) => spec.type === 'upload');
  const selectedMode = String(mode || '').trim().toLowerCase();
  return uploadParams.find((spec) => (
    selectedMode && String(spec.description || '').toLowerCase().replace(/\s+/g, '').includes(`mode=${selectedMode}`)
  )) || uploadParams[0];
}

function normalizeOption(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]/g, '');
}

function findOption(spec: VideoParamSpec, terms: string[]): VideoParamOption | undefined {
  const candidates = terms.map(normalizeOption).filter(Boolean);
  return spec.options?.find((option) => {
    const text = normalizeOption(`${option.value} ${option.label}`);
    return candidates.some((term) => text.includes(term));
  });
}

function nearestNumericOption(spec: VideoParamSpec, value: number): VideoParamOption | undefined {
  if (!Number.isFinite(value)) return undefined;
  return spec.options
    ?.map((option) => ({
      option,
      numeric: Number(option.value) || Number(String(option.label).match(/\d+(?:\.\d+)?/)?.[0]),
    }))
    .filter((entry) => Number.isFinite(entry.numeric))
    .sort((left, right) => Math.abs(left.numeric - value) - Math.abs(right.numeric - value))[0]
    ?.option;
}

function resolutionRank(value: string): number {
  const normalized = normalizeOption(value);
  if (normalized.includes('4k')) return 2160;
  const pixels = Number(normalized.match(/\d{3,4}/)?.[0]);
  return Number.isFinite(pixels) ? pixels : Number.NaN;
}

function defaultOption(spec: VideoParamSpec, defaults: VideoSchemaDefaults): VideoParamOption | undefined {
  const name = spec.name.trim().toLowerCase();

  if (/^(duration|seconds|video_seconds)$/.test(name)) {
    return nearestNumericOption(spec, defaults.seconds);
  }

  if (/^(aspect_ratio|ratio)$/.test(name)) {
    const ratio = defaults.ratio.toLowerCase() === 'auto' ? 'adaptive' : defaults.ratio;
    return findOption(spec, [ratio]) || findOption(spec, ['adaptive', 'auto']) || spec.options?.[0];
  }

  if (/^(resolution|quality)$/.test(name)) {
    const resolution = defaults.resolution.toLowerCase().replace(/p$/, '');
    const exact = findOption(spec, [defaults.resolution, resolution]);
    if (exact || name === 'quality') return exact || spec.options?.[0];
    const requestedRank = resolutionRank(defaults.resolution);
    return spec.options
      ?.map((option) => ({ option, rank: resolutionRank(`${option.value} ${option.label}`) }))
      .filter((entry) => Number.isFinite(entry.rank) && Number.isFinite(requestedRank))
      .sort((left, right) => Math.abs(left.rank - requestedRank) - Math.abs(right.rank - requestedRank))[0]
      ?.option || spec.options?.[0];
  }

  if (/^(mode|generation_mode)$/.test(name)) {
    return findOption(spec, ['shouweizhen', 'first_frame', 'frames', '首尾帧']);
  }

  if (/^(version|model_version|variant)$/.test(name)) {
    const model = defaults.model.toLowerCase();
    if (/mini/.test(model)) return findOption(spec, ['mini', '迷你']);
    if (/fast|quick|turbo/.test(model)) return findOption(spec, ['fast', 'quick', 'turbo', '快速', '极速']);
    return findOption(spec, ['standard', 'normal', '标准', '满血']);
  }

  return spec.options?.[0];
}

/** Fill schema values from the node's visible settings before using provider defaults. */
export function fillVideoSchemaDefaults(
  schema: VideoModelSchema,
  current: Record<string, unknown>,
  defaults: VideoSchemaDefaults,
): Record<string, unknown> {
  const next = { ...current };
  for (const spec of schema.params) {
    if (spec.type === 'upload' || spec.type === 'textarea') continue;
    const value = next[spec.name];
    const optionValues = spec.options?.map((option) => option.value);
    if (value !== undefined && value !== null && value !== ''
      && (!optionValues?.length || optionValues.includes(String(value)))) continue;
    if (spec.type === 'switch') {
      next[spec.name] = false;
      continue;
    }
    const option = defaultOption(spec, defaults);
    if (option) next[spec.name] = option.value;
  }
  return next;
}
