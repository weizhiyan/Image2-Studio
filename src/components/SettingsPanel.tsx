import { useEffect, useMemo, useRef, useState } from 'react';
import { SIZE_PRESETS } from '@/lib/aspect';
import { pickSingleLanguageProfileId, withSingleLanguageProfile } from '@/lib/profileEnable';
import { useSettingsStore } from '@/stores/settingsStore';
import { fetchModels, postPreferenceAction, revealSavedApiKey, testConnection } from '@/lib/bridge';
import { describeRequestError } from '@/lib/errors';
import { TrashIcon } from '@/components/canvas/NodeChrome';
import type { ImageApiMode, PreferenceProfile, ProfileKind, TextApiFormat } from '@/types';
import './model-config.css';

function EyeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m4 4 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.5 6.4A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a16.6 16.6 0 0 1-2.2 2.8M14 17.7a9.7 9.7 0 0 1-2 .3c-6 0-9.5-6-9.5-6a16.4 16.4 0 0 1 3.9-4.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.25 8.25 2.9 2.9 6.6-6.45" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** 一路配置的编辑草稿：apiKey 留空表示"沿用已保存的 Key"（不回显）。 */
interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultSize: string;
  models: string[];
  enabledModels: string[];
  kind: ProfileKind;
  textFormat: TextApiFormat;
  imageApiMode: ImageApiMode;
  responsesModel: string;
  keyConfigured: boolean;
  /** false = 停用这路配置：不参与默认竞选，列表置灰 */
  enabled: boolean;
}

/**
 * 左侧配置列表的一行（参考图）：名称 + 模型名 + 右侧开关与删除。
 * 生图配置可多路同时启用（开关各自独立）；
 * 语言模型同时只启用一路——开新的会自动让位旧的（互斥在 toggleDraftEnabled 里）。
 * 行主体点开是右侧编辑器。
 */
export interface ProfileRowProps {
  id: string;
  name: string;
  kind: ProfileKind;
  model: string;
  enabled: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleEnabled: (id: string) => void;
  onDelete: (id: string) => void;
}

export function ProfileRow({
  id,
  name,
  kind,
  model,
  enabled,
  selected,
  onSelect,
  onToggleEnabled,
  onDelete,
}: ProfileRowProps) {
  const isText = kind === 'text';
  // filter(Boolean)：拼空串会留下双空格，class 里看着像两个类其实有一个是空的
  const rowClass = ['model-config-profile-row', selected ? 'selected' : '', enabled ? '' : 'is-disabled']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={rowClass}>
      <button
        type="button"
        className="model-config-profile-main"
        onClick={() => onSelect(id)}
        title={enabled ? undefined : '已停用：不参与默认选用'}
      >
        <strong>{name}</strong>
        <small>{model}</small>
      </button>
      <div className="model-config-profile-actions">
        {/* 启停开关：生图可多开，语言模型互斥（toggleDraftEnabled 里让位） */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          className={`model-config-profile-switch ${enabled ? 'on' : ''}`}
          title={enabled
            ? (isText ? '当前使用中，点击停用' : '已启用：参与默认选用，点击停用')
            : (isText ? '点击启用：设为当前语言模型（其它语言模型会让位）' : '已停用：不参与默认选用，点击启用')}
          aria-label={`${enabled ? '停用' : '启用'} ${name}`}
          onClick={() => onToggleEnabled(id)}
        >
          <span className="model-config-profile-switch-track" aria-hidden="true"><i /></span>
        </button>
        <button
          type="button"
          className="model-config-profile-delete"
          title="删除这路配置"
          aria-label={`删除 ${name}`}
          onClick={() => onDelete(id)}
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

/** 旧配置没有语言模型时，Responses 链路的兼容兜底。 */
const DEFAULT_RESPONSES_MODEL = 'gpt-5.5';

interface SettingsPanelProps {
  onClose: () => void;
}

/**
 * 生图设置：支持同时存在多路生图配置（各自的 Base URL / Key / 模型列表），
 * 交互对齐灵枢 ModelConfigModal 的图像子集；左侧是配置列表，右侧是当前编辑的那一路。
 */
export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const { settings, error: storeError, save, load, loading } = useSettingsStore();
  /** 每次打开都重新读 Bridge：Bridge 重启或局域网切换后，旧标签页不能继续显示过期配置。 */
  useEffect(() => {
    void load();
  }, [load]);
  const [drafts, setDrafts] = useState<ProfileDraft[]>([]);
  const [activeId, setActiveId] = useState('');
  const [textProfileId, setTextProfileId] = useState('');
  const [direct, setDirect] = useState(true);
  /** 设置弹窗的三个 Tab：生图模型 / 语言模型 / 偏好档案（参考图：前两者各自独立管理）。 */
  const [tab, setTab] = useState<'image' | 'text' | 'preferences'>('image');
  /** 偏好档案：跟随 store，任何操作后重新 load 同步。 */
  const [prefs, setPrefs] = useState<PreferenceProfile>({ enabled: false, entries: [], updatedAt: '' });
  const [prefBusy, setPrefBusy] = useState<'' | 'distill' | 'clear'>('');
  const [prefNotice, setPrefNotice] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const [manualModel, setManualModel] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorText, setErrorText] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  /** 是否已完成首次水合：保存成功后 settings 会刷新一次，那时只同步数据、不切回默认配置 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!settings) return;
    // 首次水合才定"当前看哪一路"：保存成功后 settings 也会刷新，
    // 那时若再 setSelectedId 会把用户正在编辑的那一路弹回默认配置（旧行为，顺手修掉）
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const firstImage = settings.profiles.find((profile) => (profile.kind || 'image') === 'image')?.id;
      const fallbackId = settings.activeProfileId || firstImage || settings.profiles[0]?.id || '';
      setActiveId(fallbackId);
      setSelectedId(fallbackId);
      setTextProfileId(settings.textProfileId || settings.profiles.find((profile) => profile.kind === 'text')?.id || '');
    }
    setDirect(settings.direct !== false);
    setPrefs(settings.preferences || { enabled: false, entries: [], updatedAt: '' });
    // 保存成功后 settings 会刷新一次：已输入但还没被 store 认下的 Key 要原样留在输入框里，
    // 否则用户刚填完 Key 点保存，输入框瞬间清空，看起来就像"Key 没存上"。
    // 老配置里可能躺着两路同时启用的语言模型：按 textProfileId 归一，只留一路
    const languageKeepId = pickSingleLanguageProfileId(settings.profiles, settings.textProfileId);
    setDrafts((current) => settings.profiles.map((profile) => {
      const typed = current.find((draft) => draft.id === profile.id)?.apiKey || '';
      return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      apiKey: typed,
      model: profile.model,
      defaultSize: profile.defaultSize,
      models: profile.models || [],
      enabledModels: profile.enabledModels || [],
      kind: profile.kind || 'image',
      textFormat: profile.textFormat || 'auto',
      imageApiMode: profile.imageApiMode || 'images',
      responsesModel: profile.responsesModel || DEFAULT_RESPONSES_MODEL,
      keyConfigured: profile.keyConfigured,
      enabled: profile.kind === 'text' ? profile.id === languageKeepId : profile.enabled !== false,
      };
    }));
  }, [settings]);

  /* Esc 关闭，对齐灵枢 Dialog */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  /* 点外部收起模型下拉（生图默认模型 + 优化用语言模型两个） */
  useEffect(() => {
    if (!pickerOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (pickerOpen && !pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [pickerOpen]);

  const selected = drafts.find((draft) => draft.id === selectedId) || drafts[0] || null;
  const error = errorText || storeError;
  const canTest = Boolean(selected && (selected.apiKey.trim() || selected.keyConfigured)
    && (selected.kind === 'image' || selected.model.trim()));

  useEffect(() => {
    setApiKeyVisible(false);
    setRevealingApiKey(false);
  }, [selectedId]);

  /** 切 tab 时把选中项指到该类型的第一路：否则右栏还显示着另一类型的配置 */
  useEffect(() => {
    if (tab === 'preferences') return;
    const wanted = tab === 'image' ? 'image' : 'text';
    if (selected && (selected.kind || 'image') === wanted) return;
    const first = drafts.find((draft) => (draft.kind || 'image') === wanted);
    if (first) setSelectedId(first.id);
  }, [tab, selected, drafts]);

  const toggleApiKeyVisibility = async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    if (!selected) return;
    if (selected.apiKey.trim() || !selected.keyConfigured) {
      setApiKeyVisible(true);
      return;
    }
    setRevealingApiKey(true);
    setErrorText('');
    try {
      const apiKey = await revealSavedApiKey(selected.id);
      patchDraft(selected.id, { apiKey });
      setApiKeyVisible(true);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : '读取已保存的 API Key 失败');
    } finally {
      setRevealingApiKey(false);
    }
  };

  /** 按 id 改草稿：左侧列表的勾选能点到"当前没在编辑"的那一路，不能再默认只改 selected */
  const patchDraft = (id: string, patch: Partial<ProfileDraft>) => {
    setDrafts((current) => current.map((draft) => (
      draft.id === id ? { ...draft, ...patch } : draft
    )));
  };

  const patchSelected = (patch: Partial<ProfileDraft>) => {
    if (!selected) return;
    patchDraft(selected.id, patch);
  };

  /**
   * 启停开关（右侧编辑区的 switch 与左侧列表的勾选共用）：
   * 生图配置可以多路同时启用（画布上默认走哪一路由星标决定，也可按 id 手动指定）；
   * 语言模型同时只跑一路——启用新的一路会让位旧的，与"提示词优化只能启用一路"对齐。
   */
  const toggleDraftEnabled = (draft: ProfileDraft) => {
    const next = !draft.enabled;
    let nextDrafts = drafts.map((item) => item.id === draft.id ? { ...item, enabled: next } : item);
    let nextActiveId = activeId;
    let nextTextProfileId = textProfileId;
    if (!next) {
      // 停用当前生效的那路时，自动让位给同类型下一路可用的，别让生图 / 优化指向已停用配置
      if (draft.kind === 'text') {
        const fallback = drafts.find((item) => item.kind === 'text' && item.id !== draft.id && item.enabled);
        if (textProfileId === draft.id) {
          nextTextProfileId = fallback?.id || '';
          setTextProfileId(nextTextProfileId);
        }
        setNotice(fallback ? '已停用这路，提示词优化已切换到其它可用语言模型' : '没有其它可用的语言模型了：提示词优化会暂时不可用');
      } else if (activeId === draft.id) {
        const fallback = drafts.find((item) => item.kind !== 'text' && item.id !== draft.id && item.enabled);
        nextActiveId = fallback?.id || '';
        setActiveId(nextActiveId);
        setNotice(fallback ? '已停用这路，默认生图已切换到其它可用配置' : '没有其它可用的生图配置了：画布上会无法出图');
      }
      setDrafts(nextDrafts);
      window.setTimeout(() => void handleSave(nextDrafts, nextActiveId, nextTextProfileId), 0);
      return;
    }
    if (draft.kind === 'text') {
      // 语言模型只留一路：其余同时停用，提示词优化指向刚启用的这路
      nextDrafts = withSingleLanguageProfile(nextDrafts, draft.id);
      nextTextProfileId = draft.id;
      setTextProfileId(nextTextProfileId);
      setNotice('已启用这路语言模型，其它语言模型已让位（语言模型同时只能启用一路）');
    }
    setDrafts(nextDrafts);
    // 左侧开关是运行态入口，切换后立即落盘；右侧字段仍只在点击“保存配置”时提交。
    window.setTimeout(() => void handleSave(nextDrafts, nextActiveId, nextTextProfileId), 0);
  };

  const handleAddProfile = (kind: ProfileKind) => {
    const index = drafts.filter((draft) => draft.kind === kind).length + 1;
    const draft: ProfileDraft = {
      id: `new_${Date.now().toString(36)}`,
      name: kind === 'text' ? `语言模型 ${index}` : `生图模型 ${index}`,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      defaultSize: SIZE_PRESETS[0],
      models: [],
      enabledModels: [],
      kind,
      textFormat: 'auto',
      imageApiMode: 'images',
      responsesModel: DEFAULT_RESPONSES_MODEL,
      keyConfigured: false,
      enabled: true,
    };
    setDrafts((current) => (
      // 语言模型同时只跑一路：新建的一路直接顶上，其余同时停用
      kind === 'text' ? [...withSingleLanguageProfile(current, draft.id), draft] : [...current, draft]
    ));
    setSelectedId(draft.id);
    if (kind === 'text') setTextProfileId(draft.id);
    setNotice('');
    setErrorText('');
  };

  const handleDeleteProfile = (id: string) => {
    const target = drafts.find((draft) => draft.id === id);
    if (target?.kind !== 'text' && drafts.filter((draft) => draft.kind !== 'text').length <= 1) {
      setErrorText('至少保留一路生图配置');
      return;
    }
    const next = drafts.filter((draft) => draft.id !== id);
    setDrafts(next);
    if (selectedId === id) setSelectedId(next[0].id);
    if (activeId === id) setActiveId(next.find((draft) => draft.kind !== 'text')?.id || next[0].id);
    if (textProfileId === id) setTextProfileId(next.find((draft) => draft.kind === 'text')?.id || '');
  };

  const toggleModel = (name: string) => {
    if (!selected) return;
    const next = new Set(selected.enabledModels);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    const list = Array.from(next);
    patchSelected({
      enabledModels: list,
      model: list.includes(selected.model) ? selected.model : list[0] || '',
    });
  };

  const handleFetch = async () => {
    if (!selected) return;
    setFetching(true);
    setNotice('');
    setErrorText('');
    try {
      const list = await fetchModels({
        baseUrl: selected.baseUrl.trim(),
        apiKey: selected.apiKey.trim(),
        profileId: selected.id,
      });
      const normalized = Array.from(new Set(list.map((item) => String(item).trim()).filter(Boolean)));
      if (normalized.length === 0) {
        // 服务端没给列表：绝不清空用户已勾选/已填的模型，否则默认模型会被抹成空、看着像配置丢了
        setNotice(selected.enabledModels.length > 0
          ? '服务端未返回模型列表，已保留当前勾选与默认模型；也可在下方手填模型名'
          : '服务端未返回模型列表，可在下方手填模型名');
        return;
      }
      // 只刷新候选：已勾选且仍在列表里的留住；第一次获取也不替用户全选，
      // 避免模型数量很多时保存后意外启用整套模型。
      const kept = selected.enabledModels.filter((item) => normalized.includes(item));
      const hadSelection = selected.enabledModels.length > 0;
      const nextEnabled = kept.length > 0 ? kept : (hadSelection ? selected.enabledModels : []);
      const nextModels = Array.from(new Set([...normalized, ...nextEnabled]));
      const nextModel = normalized.includes(selected.model) && nextEnabled.includes(selected.model)
        ? selected.model
        : nextEnabled[0] || '';
      patchSelected({ models: nextModels, enabledModels: nextEnabled, model: nextModel });
      setNotice(kept.length > 0
        ? `已获取 ${normalized.length} 个模型，保留 ${kept.length} 个已选模型`
        : hadSelection
          ? `已获取 ${normalized.length} 个模型；原勾选未出现在列表里，请手动调整`
          : `已获取 ${normalized.length} 个模型，请手动勾选需要使用的模型`);
    } catch (err) {
      // 失败必须亮出真实原因（最常见是这路还没配 Key：「尚未配置 API Key」），
      // 别再一律显示「接口不可用」把真问题盖掉
      setErrorText(describeRequestError(err, selected.baseUrl));
      // 同时清空这一路的模型勾选与默认模型：留着拉不回来的模型名，
      // 只会让界面谎称「有模型可用」，点到生成才失败。修好地址/Key 再拉一次即可。
      patchSelected({ models: [], enabledModels: [], model: '' });
      setNotice('获取模型失败，已清空该路的模型勾选与默认模型；请修正后重新获取，或在下方手动填写模型名');
    } finally {
      setFetching(false);
    }
  };

  const handleAddManualModel = () => {
    const name = manualModel.trim();
    if (!selected || !name) return;
    const nextModels = selected.models.includes(name) ? selected.models : [...selected.models, name];
    const nextEnabled = selected.enabledModels.includes(name) ? selected.enabledModels : [...selected.enabledModels, name];
    setManualModel('');
    patchSelected({
      models: nextModels,
      enabledModels: nextEnabled,
      model: selected.model || name,
    });
    setNotice(`已加入模型 ${name}`);
  };

  const handleTest = async () => {
    if (!selected) return;
    setTesting(true);
    setNotice('');
    setErrorText('');
    try {
      const message = await testConnection({
        baseUrl: selected.baseUrl.trim(),
        apiKey: selected.apiKey.trim(),
        model: selected.model.trim(),
        profileId: selected.id,
        kind: selected.kind,
      });
      setNotice(message);
    } catch (err) {
      setErrorText(describeRequestError(err, selected.baseUrl));
    } finally {
      setTesting(false);
    }
  };

  /** 偏好档案操作：bridge 落盘后重新 load，让档案列表与 store 保持一致 */
  const runPrefAction = async (action: 'distill' | 'clear' | 'remove' | 'toggle', payload: Record<string, unknown> = {}, busy: 'distill' | 'clear' | '' = '') => {
    setPrefBusy(busy);
    setPrefNotice('');
    try {
      await postPreferenceAction(action, payload);
      await load();
      setPrefNotice('偏好档案已更新');
    } catch (err) {
      setPrefNotice(err instanceof Error ? err.message : '偏好档案操作失败');
    } finally {
      setPrefBusy('');
    }
  };

  const handleSave = async (
    draftsToSave: ProfileDraft[] = drafts,
    activeIdToSave: string = activeId,
    textProfileIdToSave: string = textProfileId,
  ) => {
    setSaving(true);
    setNotice('');
    setErrorText('');
    // 草稿为空 = 配置还没加载完（或加载失败）：这时保存会把已存配置整组清空，必须先拦住
    if (draftsToSave.length === 0) {
      setSaving(false);
      setErrorText('配置还没有加载完成，请稍候再保存；若持续如此请确认 bridge 是否在运行');
      return;
    }
    // 全停用生图配置 = 画布上必然出不了图，保存前拦住并说清哪出了问题
    if (!draftsToSave.some((draft) => draft.kind !== 'text' && draft.enabled)) {
      setSaving(false);
      setErrorText('至少要保留一路启用的生图配置：停用全部生图配置后画布上无法出图');
      return;
    }
    try {
      const selectedDraftIndex = selected ? draftsToSave.findIndex((draft) => draft.id === selected.id) : -1;
      // 保存前再归一一次：不管界面怎么绕，落盘的必须还是"语言模型只启用一路"
      const normalizedDrafts = withSingleLanguageProfile(draftsToSave, pickSingleLanguageProfileId(draftsToSave, textProfileIdToSave));
      const savedSettings = await save({
        profiles: normalizedDrafts.map((draft) => ({
          // 保留新配置的临时 ID，bridge 保存时会把它映射成稳定 ID，
          // 这样 textProfileId / activeProfileId 不会在保存后指向不存在的配置。
          id: draft.id,
          name: draft.name.trim() || (draft.kind === 'text' ? '语言模型' : '生图模型'),
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          model: draft.model.trim(),
          defaultSize: draft.defaultSize,
          models: draft.models,
          enabledModels: draft.enabledModels,
          kind: draft.kind,
          textFormat: draft.textFormat,
          imageApiMode: draft.imageApiMode,
          // 生图配置不能把语言模型名写成 Responses 主模型；运行时会按该路生图模型校验。
          responsesModel: draft.kind === 'text' ? draft.model : draft.responsesModel,
          enabled: draft.enabled,
        })),
        activeProfileId: activeIdToSave,
        textProfileId: textProfileIdToSave,
        direct,
      });
      // 新配置的临时 ID 会在 bridge 保存时换成稳定 ID；同步回来避免保存后选中态跳回第一路。
      const persistedSelected = selectedDraftIndex >= 0 ? savedSettings.profiles[selectedDraftIndex] : undefined;
      if (persistedSelected) setSelectedId(persistedSelected.id);
      setActiveId(savedSettings.activeProfileId);
      setTextProfileId(savedSettings.textProfileId || '');
      setNotice('已保存（弹窗不会自动关闭，可继续改）');
      // 保存成功就把 Key 显示出来：用户最常问的就是"我到底存上没有"
      if (selected?.apiKey.trim()) setApiKeyVisible(true);
    } catch (err) {
      // 保存失败：病因多在本地 bridge（fetch 自己抛 fetch failed），不是服务商地址
      const raw = err instanceof Error ? err.message : '';
      const friendly = /fetch failed|failed to fetch/i.test(raw) ? '无法连接到本地服务，请确认 bridge 是否在运行' : raw;
      setErrorText(`保存失败：${friendly || '请检查 bridge 是否在运行'}`);
    } finally {
      setSaving(false);
    }
  };

  const profileSummary = useMemo(() => drafts.map((draft) => ({
    id: draft.id,
    name: draft.name || '未命名配置',
    model: draft.model || '未选模型',
    kind: draft.kind,
    enabled: draft.enabled,
    ready: Boolean(draft.keyConfigured || draft.apiKey.trim()) && Boolean(draft.model),
  })), [drafts]);

  /** 当前这路配好没有：Key + 默认模型都在启用列表里才算。决定黄字警告显隐。 */
  const selectedReady = Boolean(
    selected
    && (selected.keyConfigured || selected.apiKey.trim())
    && selected.model.trim()
    && (selected.kind === 'text' || selected.enabledModels.includes(selected.model)),
  );
  const imageProfiles = profileSummary.filter((profile) => profile.kind !== 'text');
  const textProfiles = profileSummary.filter((profile) => profile.kind === 'text');
  const renderProfileRow = (profile: (typeof profileSummary)[number]) => (
    <ProfileRow
      key={profile.id}
      id={profile.id}
      name={profile.name}
      kind={profile.kind}
      model={profile.model}
      enabled={profile.enabled}
      selected={profile.id === selectedId}
      onSelect={setSelectedId}
      onToggleEnabled={(rowId) => {
        const draft = drafts.find((item) => item.id === rowId);
        if (draft) toggleDraftEnabled(draft);
      }}
      onDelete={handleDeleteProfile}
    />
  );
  /** 偏好档案 Tab 的整块内容：归纳 / 清空 / 条目列表都在这里 */
  const prefsPanel = (
                <div className="model-config-prefs">
                  <div className="model-config-prefs-head">
                    <div>
                      <strong>偏好档案</strong>
                      <span>由生成记录归纳 + 图片预览里「偏好录入」；开启后作为长期偏好注入优化对话（与本次要求冲突时以本次为准）</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={prefs.enabled}
                      aria-label="注入偏好档案"
                      title={prefs.enabled ? '已启用：整理时带上偏好档案' : '已关闭：整理时不参考偏好档案'}
                      className={`model-config-enhance-switch is-bare ${prefs.enabled ? 'on' : ''}`}
                      onClick={() => void runPrefAction('toggle', { enabled: !prefs.enabled })}
                    >
                      <span className="model-config-enhance-switch-track" aria-hidden="true"><i /></span>
                    </button>
                  </div>
                  <div className="model-config-prefs-actions">
                    <button
                      type="button"
                      className="model-config-prefs-action"
                      disabled={prefBusy === 'distill'}
                      onClick={() => void runPrefAction('distill', {}, 'distill')}
                    >
                      {prefBusy === 'distill' ? '归纳中...' : '归纳生成记录（调用语言模型）'}
                    </button>
                    <button
                      type="button"
                      className="model-config-prefs-action"
                      disabled={prefBusy === 'clear' || prefs.entries.length === 0}
                      onClick={() => void runPrefAction('clear', {}, 'clear')}
                    >
                      清空
                    </button>
                  </div>
                  {prefNotice ? <p className="model-config-prefs-notice" role="status">{prefNotice}</p> : null}
                  <div className="model-config-prefs-list">
                    {prefs.entries.length === 0 ? (
                      <p className="model-config-prefs-empty">还没有档案：点「归纳生成记录」自动生成，或在图片预览里点「偏好录入」手动添加</p>
                    ) : prefs.entries.map((entry) => (
                      <span key={entry.id} className="model-config-prefs-chip" title={entry.text}>
                        <i className={`is-${entry.source}`}>{entry.source === 'manual' ? '手动' : '归纳'}</i>
                        <em>{entry.text}</em>
                        <button
                          type="button"
                          aria-label={`删除偏好：${entry.text}`}
                          onClick={() => void runPrefAction('remove', { id: entry.id })}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
  );

  return (
    <div className="hb-modal-overlay" role="presentation">
      <div
        className="model-config-modal model-config-modal-wide"
        role="dialog"
        aria-label="AI 模型设置"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="model-config-modal-head">
          <h2>AI 模型设置</h2>
          <button type="button" className="model-config-close" onClick={onClose} aria-label="关闭 AI 模型设置">×</button>
        </div>

        {error ? (
          <div className="model-config-error-bar" role="alert">
            <strong>出错了</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {/* 状态提示跟错误条并排在标题区：以前放在 body 最底部，内容一多、
            滚动到别处就看不到「已保存」了，用户以为没存上 */}
        {notice ? (
          <div className="model-config-notice" role="status">{notice}</div>
        ) : null}

        <div className="model-config-tabs" role="tablist" aria-label="设置分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'image'}
            className={`model-config-tab ${tab === 'image' ? 'active' : ''}`}
            onClick={() => setTab('image')}
          >
            生图模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            className={`model-config-tab ${tab === 'text' ? 'active' : ''}`}
            onClick={() => setTab('text')}
          >
            语言模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preferences'}
            className={`model-config-tab ${tab === 'preferences' ? 'active' : ''}`}
            onClick={() => setTab('preferences')}
          >
            偏好档案
          </button>
        </div>

        {tab !== 'preferences' ? (
          <>
        <div className="model-config-split">
          <aside className="model-config-profiles" aria-label={tab === 'image' ? '生图配置列表' : '语言模型配置列表'}>
            <div className="model-config-profile-list">
              <section className="model-config-profile-group" aria-label={tab === 'image' ? '生图配置' : '语言模型配置'}>
                {(tab === 'image' ? imageProfiles : textProfiles).length > 0
                  ? (tab === 'image' ? imageProfiles : textProfiles).map(renderProfileRow)
                  : (
                    <p className="model-config-profile-empty">
                      {tab === 'image' ? '还没有生图配置' : '还没有语言模型配置'}
                    </p>
                  )}
              </section>
            </div>
            <div className="model-config-profile-adds">
              <button type="button" className={`model-config-profile-add ${tab === 'text' ? 'is-text' : ''}`} onClick={() => handleAddProfile(tab === 'image' ? 'image' : 'text')}>
                <PlusIcon />
                <span>{tab === 'image' ? '添加生图配置' : '添加语言模型配置'}</span>
              </button>
            </div>
          </aside>

          <div className="model-config-modal-body">
            {!selected ? (
              <div className="model-config-loading" role="status">
                <strong>{storeError ? '配置读取失败' : '配置加载中…'}</strong>
                <span>
                  {/* bridge 不在时 fetch 抛的是 "Failed to fetch"，直接展示用户看不懂 */}
                  {/fetch failed|failed to fetch/i.test(storeError)
                    ? '无法连接本机服务：请确认 bridge（端口 3788）是否在运行，terminal 里执行 npm start 或双击 启动.command 即可'
                    : (storeError || '如果一直停在这里，说明本机 bridge（3788）没有在运行；terminal 里执行 npm start 或 启动.command 即可。')}
                </span>
                <button type="button" onClick={() => void load()} disabled={loading}>
                  {loading ? '读取中…' : (storeError ? '重试读取' : '重新载入')}
                </button>
              </div>
            ) : null}
            {selected ? (
              <>
                {/* 没配好就黄字拍在脸上：以前要等画布上生成失败才知道少选了模型 */}
                {!selectedReady ? (
                  <p className="model-config-warn" role="alert">
                    {selected?.kind === 'text' ? '这路语言模型还没配好' : '这路生图模型还没配好'}
                    ：填好 API Key，再获取并勾选模型，或在下方手动填写准确模型名{selected?.kind === 'text' ? '' : '，否则画布上无法出图'}。
                  </p>
                ) : null}
                <section className="model-config-group" aria-label="基础信息">
                  <h3 className="model-config-group-title">基础信息</h3>
                  <div className="model-config-form-grid">
                <div className="model-config-field">
                  <span className="model-config-field-label">配置名称</span>
                  <div className="model-config-name-row">
                    <input
                      className="model-config-input"
                      value={selected.name}
                      placeholder={selected.kind === 'text' ? '例如：提示词优化模型' : '例如：主中转站 / 备用 Key'}
                      onChange={(event) => patchSelected({ name: event.target.value })}
                    />
                  </div>
                </div>
                  {/* 第二格与配置名称并排：语言模型放「上游接口格式」，生图放「默认尺寸」（参考图） */}
                  {selected.kind === 'text' ? (
                    <div className="model-config-field">
                      <span className="model-config-field-label">上游接口格式</span>
                      <select
                        className="model-config-select"
                        value={selected.textFormat}
                        onChange={(event) => patchSelected({ textFormat: event.target.value as TextApiFormat })}
                      >
                        <option value="auto">自动（先 Chat，失败回落 Responses）</option>
                        <option value="chat">Chat Completions（/chat/completions）</option>
                        <option value="responses">Responses（/responses）</option>
                      </select>
                    </div>
                  ) : (
                    <div className="model-config-field is-compact">
                      <span className="model-config-field-label">默认尺寸</span>
                      <select
                        className="model-config-select"
                        value={selected.defaultSize}
                        onChange={(event) => patchSelected({ defaultSize: event.target.value })}
                      >
                        {SIZE_PRESETS.map((size) => (
                          <option key={size} value={size}>{size}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  </div>
                </section>

                <section className="model-config-group" aria-label="服务连接">
                  <h3 className="model-config-group-title">服务连接</h3>
                  <div className="model-config-form-grid">
                    <div className="model-config-field">
                      <span className="model-config-field-label">API Base URL</span>
                      <input
                        className="model-config-input"
                        value={selected.baseUrl}
                        placeholder="https://api.openai.com/v1"
                        onChange={(event) => patchSelected({ baseUrl: event.target.value })}
                      />
                    </div>

                    <div className="model-config-field">
                      <span className="model-config-field-label">API Key</span>
                      <div className="model-config-api-key">
                        <input
                          type={apiKeyVisible ? 'text' : 'password'}
                          value={selected.apiKey}
                          placeholder={selected.keyConfigured ? '已保存，留空表示不修改' : 'sk-...'}
                          onChange={(event) => patchSelected({ apiKey: event.target.value })}
                        />
                        <button
                          type="button"
                          onClick={() => void toggleApiKeyVisibility()}
                          disabled={revealingApiKey}
                          aria-label={apiKeyVisible ? '隐藏 API Key' : '显示 API Key'}
                        >
                          {revealingApiKey ? '…' : (apiKeyVisible ? <EyeOffIcon /> : <EyeIcon />)}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="model-config-group" aria-label="默认模型">
                  <h3 className="model-config-group-title">默认使用模型</h3>
                  <div className="model-config-field">
                  <div className="model-config-model-picker" ref={pickerRef}>
                    <button
                      type="button"
                      className="model-config-model-picker-trigger"
                      aria-expanded={pickerOpen}
                      aria-haspopup="listbox"
                      onClick={() => setPickerOpen((current) => !current)}
                    >
                      <span>{selected.model && selected.enabledModels.includes(selected.model) ? selected.model : '请先选择模型'}</span>
                      <span aria-hidden="true">▾</span>
                    </button>
                    {pickerOpen ? (
                      <div className="model-config-model-picker-menu" role="listbox" aria-label="选择默认使用模型">
                        {selected.enabledModels.length === 0 ? <span>请先在下方勾选模型</span> : null}
                        {selected.enabledModels.map((name) => (
                          <button
                            key={name}
                            type="button"
                            role="option"
                            aria-selected={name === selected.model}
                            onClick={() => {
                              patchSelected({ model: name });
                              setPickerOpen(false);
                            }}
                          >
                            {name}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                </section>

                <section className="model-config-group" aria-label="可用模型">
                  <h3 className="model-config-group-title">可用模型</h3>
                  <div className="model-config-model-section">
                  <div className="model-config-model-section-head">
                    <div>
                      <div className="model-config-model-section-title">
                        <strong>已获取模型</strong>
                        <span>{selected.enabledModels.length} / {selected.models.length} 已选择</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="model-config-fetch-button"
                      disabled={fetching || !selected.baseUrl.trim()}
                      onClick={() => void handleFetch()}
                    >
                      {fetching ? '获取中...' : '获取模型'}
                    </button>
                  </div>
                  <div className="model-config-model-manual">
                    <input
                      value={manualModel}
                      placeholder="列表接口不可用？直接填模型名"
                      aria-label="手动添加模型名"
                      onChange={(event) => setManualModel(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleAddManualModel();
                        }
                      }}
                    />
                    <button type="button" onClick={handleAddManualModel} disabled={!manualModel.trim()}>加入</button>
                  </div>
                  <div className="model-config-model-list">
                    {selected.models.length === 0 ? <div className="model-config-empty">还没有模型列表</div> : null}
                    {selected.models.map((name) => (
                      <div key={name} className="model-config-model-row">
                        <label className="model-config-model-choice">
                          <input
                            type="checkbox"
                            checked={selected.enabledModels.includes(name)}
                            onChange={() => toggleModel(name)}
                            aria-label={`${name} 选择`}
                          />
                          <span className="model-config-checkbox" aria-hidden="true"><CheckIcon /></span>
                          <span className="model-config-model-name">{name}</span>
                        </label>
                      </div>
                    ))}
                  </div>
                  </div>
                </section>

                <div className="model-config-foot-hint">
                  Key 由本机 bridge 进程保管，只存在这台机器上。生图配置的「测试」只请求模型列表，不会生成图片；语言模型的「测试」会发送一条短文本请求，可能消耗少量文本额度。
                </div>
              </>
            ) : null}
          </div>
        </div>

        <div className="model-config-modal-foot">
          <div className="model-config-state">
            <span>{selected?.keyConfigured && !selected.apiKey ? 'Key 已配置' : (selected?.apiKey ? 'Key 待保存' : '尚未配置 Key')}</span>
            <div>
              <button type="button" disabled={testing || saving || !canTest} onClick={() => void handleTest()}>
                {testing ? '测试中...' : '测试连接'}
              </button>
              <button
                type="button"
                className="model-config-save"
                disabled={saving}
                onClick={() => void handleSave()}
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
          </>
        ) : (
          <div className="model-config-modal-body model-config-tab-panel">
            {prefsPanel}
          </div>
        )}
      </div>
    </div>
  );
}
