import { useEffect, useMemo, useRef, useState } from 'react';
import { SIZE_PRESETS } from '@/lib/aspect';
import { pickSingleLanguageProfileId, withSingleLanguageProfile } from '@/lib/profileEnable';
import { useSettingsStore } from '@/stores/settingsStore';
import { fetchModels, fetchVideoModels, revealSavedApiKey, testConnection } from '@/lib/bridge';
import { describeRequestError } from '@/lib/errors';
import { TrashIcon } from '@/components/canvas/NodeChrome';
import ChatRolesSettings from '@/components/ChatRolesSettings';
import type { CustomVideoApiConfig, ImageApiMode, ProfileKind, TextApiFormat, VideoApiMode } from '@/types';
import { renderVideoHeadersTemplate, renderVideoRequestTemplate } from '../../bridge/videoRequestTemplate';
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
  videoApiMode: VideoApiMode;
  videoCustomConfig: CustomVideoApiConfig;
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

interface ProfileOverviewCardProps {
  draft: ProfileDraft;
  selected: boolean;
  canTest: boolean;
  testing: boolean;
  saving: boolean;
  onOpen: (id: string) => void;
  onToggleModel: (profileId: string, model: string) => void;
  onTest: (profileId: string) => void;
}

export function ProfileOverviewCard({
  draft,
  selected,
  canTest,
  testing,
  saving,
  onOpen,
  onToggleModel,
  onTest,
}: ProfileOverviewCardProps) {
  const modelNames = Array.from(new Set([...draft.models, ...draft.enabledModels, draft.model].map((name) => name.trim()).filter(Boolean)));
  const isModelEnabled = (name: string) => draft.enabledModels.includes(name)
    || (draft.enabledModels.length === 0 && draft.model === name);
  const enabledModels = modelNames.filter(isModelEnabled);
  const enabledCount = draft.enabledModels.length || (draft.model ? 1 : 0);

  return (
    <article
      className={`model-config-overview-card${selected ? ' is-current' : ''}${draft.enabled ? '' : ' is-disabled'}`}
      role="group"
      aria-label={`编辑 ${draft.name || '未命名配置'} 配置`}
      tabIndex={0}
      onClick={() => onOpen(draft.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onOpen(draft.id);
      }}
    >
      <header className="model-config-overview-card-head">
        <div className="model-config-overview-title">
          <strong>{draft.name || '未命名配置'}</strong>
          {!draft.enabled ? <span>配置已停用</span> : null}
        </div>
        <div className="model-config-overview-actions">
          <span>{enabledCount} 个已选模型</span>
          <button
            type="button"
            className="model-config-overview-test"
            disabled={!canTest || testing || saving}
            onClick={(event) => {
              event.stopPropagation();
              onTest(draft.id);
            }}
          >
            {testing ? '测试中...' : '测试'}
          </button>
        </div>
      </header>
      <div className="model-config-overview-models">
        {enabledModels.map((name) => (
          <div className="model-config-overview-model is-enabled" key={name}>
            <span title={name}>{name}</span>
            <button
              type="button"
              role="switch"
              aria-checked="true"
              aria-label={`停用模型 ${name}`}
              title="停用模型"
              className="model-config-profile-switch on"
              disabled={saving}
              onClick={(event) => {
                event.stopPropagation();
                onToggleModel(draft.id, name);
              }}
            >
              <span className="model-config-profile-switch-track" aria-hidden="true"><i /></span>
            </button>
          </div>
        ))}
        {enabledModels.length === 0 ? (
          <span className="model-config-overview-empty">还没有模型</span>
        ) : null}
      </div>
    </article>
  );
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
const DEFAULT_CUSTOM_VIDEO_CONFIG: CustomVideoApiConfig = {
  createPath: '/videos',
  pollPath: '/videos/{{taskId}}',
  imageTransport: 'public-url',
  headersTemplate: '{}',
  requestBodyTemplate: JSON.stringify({
    model: '{{model}}',
    prompt: '{{prompt}}',
    seconds: '{{seconds}}',
    ratio: '{{ratio}}',
  }, null, 2),
  taskIdPath: 'id',
  statusPath: 'status',
  progressPath: 'progress',
  outputUrlPath: 'video_url',
  errorPath: 'error.message',
  statusMap: '{}',
};

function customVideoPreviewValues(model: string): Record<string, unknown> {
  const images = ['https://example.invalid/first-frame.png', 'https://example.invalid/last-frame.png'];
  return {
    model: model || 'your-video-model',
    prompt: 'Sample video prompt',
    seconds: 5,
    secondsString: '5',
    ratio: '16:9',
    resolution: '720p',
    imageUrls: images,
    firstImageUrl: images[0],
    lastImageUrl: images[1],
    generateAudio: false,
    watermark: false,
    referenceMode: 'first_frame',
    params: {},
    apiKey: '[redacted]',
  };
}

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
  /** 设置弹窗分类；偏好档案页只承载 AI 对话角色。 */
  const [tab, setTab] = useState<'image' | 'text' | 'video' | 'preferences'>('image');
  const [selectedId, setSelectedId] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [roleDetailOpen, setRoleDetailOpen] = useState(false);
  const [videoAdvancedOpen, setVideoAdvancedOpen] = useState(false);
  const [videoTemplatePreview, setVideoTemplatePreview] = useState('');
  const [videoTemplatePreviewError, setVideoTemplatePreviewError] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [revealingApiKey, setRevealingApiKey] = useState(false);
  const [manualModel, setManualModel] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingProfileId, setTestingProfileId] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorText, setErrorText] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  /** 配置草稿只做首次水合，后续 store 刷新不覆盖本地编辑。 */
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!settings) return;
    const firstHydration = !hydratedRef.current;
    // 首次水合才定"当前看哪一路"：保存成功后 settings 也会刷新，
    // 那时若再 setSelectedId 会把用户正在编辑的那一路弹回默认配置（旧行为，顺手修掉）
    if (firstHydration) {
      const firstImage = settings.profiles.find((profile) => (profile.kind || 'image') === 'image')?.id;
      const fallbackId = settings.activeProfileId || firstImage || settings.profiles[0]?.id || '';
      setActiveId(fallbackId);
      setSelectedId(fallbackId);
      setTextProfileId(settings.textProfileId || settings.profiles.find((profile) => profile.kind === 'text')?.id || '');
    }
    setDirect(settings.direct !== false);
    if (firstHydration) {
      // 只首次把服务端配置灌入草稿。打开面板时可能已有一次刷新在途；若每次 settings
      // 更新都重建草稿，会覆盖用户刚输入的 URL / Key / 模型。首次读取期间新增的临时草稿要保留。
      const languageKeepId = pickSingleLanguageProfileId(settings.profiles, settings.textProfileId);
      setDrafts((current) => {
        const serverDrafts = settings.profiles.map((profile) => {
          const local = current.find((draft) => draft.id === profile.id);
          if (local) return { ...local, keyConfigured: profile.keyConfigured };
          return {
            id: profile.id,
            name: profile.name,
            baseUrl: profile.baseUrl,
            apiKey: '',
            model: profile.model,
            defaultSize: profile.defaultSize,
            models: profile.models || [],
            enabledModels: profile.enabledModels || [],
            kind: profile.kind || 'image',
            textFormat: profile.textFormat || 'auto',
            imageApiMode: profile.imageApiMode || 'images',
            responsesModel: profile.responsesModel || DEFAULT_RESPONSES_MODEL,
            videoApiMode: profile.videoApiMode || 'auto',
            videoCustomConfig: profile.videoCustomConfig || DEFAULT_CUSTOM_VIDEO_CONFIG,
            keyConfigured: profile.keyConfigured,
            enabled: profile.kind === 'text' ? profile.id === languageKeepId : profile.enabled !== false,
          };
        });
        const serverIds = new Set(settings.profiles.map((profile) => profile.id));
        return [...serverDrafts, ...current.filter((draft) => draft.id.startsWith('new_') && !serverIds.has(draft.id))];
      });
      hydratedRef.current = true;
    }
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

  const selected = tab === 'preferences'
    ? null
    : drafts.find((draft) => draft.id === selectedId && draft.kind === tab)
      || drafts.find((draft) => draft.kind === tab)
      || null;
  const error = errorText || storeError;
  const canTest = Boolean(selected && (selected.apiKey.trim() || selected.keyConfigured)
    && (selected.kind === 'image' || selected.model.trim()));

  useEffect(() => {
    setApiKeyVisible(false);
    setRevealingApiKey(false);
    setManualModel('');
    setVideoTemplatePreview('');
    setVideoTemplatePreviewError('');
  }, [selectedId]);

  /** 切 tab 时把选中项指到该类型的第一路：否则右栏还显示着另一类型的配置 */
  useEffect(() => {
    if (tab === 'preferences') return;
    const wanted = tab === 'image' ? 'image' : tab === 'video' ? 'video' : 'text';
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

  const patchSelectedVideoConfig = (patch: Partial<CustomVideoApiConfig>) => {
    if (!selected || selected.kind !== 'video') return;
    patchSelected({ videoCustomConfig: { ...selected.videoCustomConfig, ...patch } });
    setVideoTemplatePreview('');
    setVideoTemplatePreviewError('');
  };

  const previewCustomVideoConfig = () => {
    if (!selected || selected.kind !== 'video') return;
    setVideoTemplatePreviewError('');
    try {
      const values = customVideoPreviewValues(selected.model);
      const configuredHeaders = renderVideoHeadersTemplate(selected.videoCustomConfig.headersTemplate, values);
      const hasCustomAuth = Object.keys(configuredHeaders).some((name) => /^(authorization|x-api-key|api-key)$/i.test(name));
      const headers = {
        ...(!hasCustomAuth ? { Authorization: 'Bearer [redacted]' } : {}),
        ...configuredHeaders,
        'Content-Type': 'application/json',
      };
      for (const name of Object.keys(headers)) {
        if (/authorization|api[-_]?key|token/i.test(name)) headers[name as keyof typeof headers] = '[redacted]';
      }
      const requestBody = renderVideoRequestTemplate(selected.videoCustomConfig.requestBodyTemplate, values);
      setVideoTemplatePreview(JSON.stringify({
        method: 'POST',
        endpoint: selected.videoCustomConfig.createPath,
        imageTransport: selected.videoCustomConfig.imageTransport,
        headers,
        body: requestBody,
      }, null, 2));
    } catch (error) {
      setVideoTemplatePreviewError(error instanceof Error ? error.message : '模板预览失败');
      setVideoTemplatePreview('');
    }
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
    const nameByKind: Record<ProfileKind, string> = {
      image: `生图模型 ${index}`,
      text: `语言模型 ${index}`,
      video: `视频模型 ${index}`,
    };
    const draft: ProfileDraft = {
      id: `new_${Date.now().toString(36)}`,
      name: nameByKind[kind] || `配置 ${index}`,
      baseUrl: kind === 'video' ? '' : 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      defaultSize: kind === 'video' ? '' : SIZE_PRESETS[0],
      models: [],
      enabledModels: [],
      kind,
      textFormat: 'auto',
      imageApiMode: 'images',
      responsesModel: DEFAULT_RESPONSES_MODEL,
      videoApiMode: 'auto',
      videoCustomConfig: DEFAULT_CUSTOM_VIDEO_CONFIG,
      keyConfigured: false,
      enabled: true,
    };
    setDrafts((current) => (
      // 语言模型同时只跑一路：新建的一路直接顶上，其余同时停用
      kind === 'text' ? [...withSingleLanguageProfile(current, draft.id), draft] : [...current, draft]
    ));
    setSelectedId(draft.id);
    setEditorOpen(true);
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
    const usesGrsaiVideoProtocol = selected.kind === 'video' && (
      selected.videoApiMode === 'grsai-generate'
      || (selected.videoApiMode === 'auto' && (/grsai|dakka/i.test(selected.baseUrl) || selected.model.toLowerCase() === 'minimax-h3'))
    );
    if (usesGrsaiVideoProtocol) {
      setNotice('GrsAI 生成协议没有兼容的模型列表接口；请按服务商提供的模型名手动添加，现有配置会保留。');
      setErrorText('');
      return;
    }
    // 视频模型走 /skills/models?type=video：只列视频模型，并过滤掉当前 Key 调不了的
    // （available_for_this_key=false 硬调必 403，放进列表只会误导）。
    if (selected.kind === 'video') {
      setFetching(true);
      setNotice('');
      setErrorText('');
      try {
        const result = await fetchVideoModels({
          profileId: selected.id,
          baseUrl: selected.baseUrl.trim(),
          apiKey: selected.apiKey.trim(),
          videoApiMode: selected.videoApiMode,
        });
        const infos = result.models;
        const protocolNote = result.protocol
          ? `协议：${result.protocol}${result.confidence ? `（${result.confidence === 'high' ? '高' : result.confidence === 'medium' ? '中' : '低'}置信度）` : ''}`
          : '';
        const normalized = Array.from(new Set(infos.map((item) => String(item.name || '').trim()).filter(Boolean)));
        if (normalized.length === 0) {
          setNotice([protocolNote, '这个 Key 没有可用的视频模型——请检查渠道分组权限，或手动填写模型名'].filter(Boolean).join('；'));
          return;
        }
        const kept = selected.enabledModels.filter((item) => normalized.includes(item));
        // 没勾选过时自动启用第一个：用户「加了模型」就该能用，不该再被默认模型卡住
        const nextEnabled = kept.length > 0 ? kept : [normalized[0]];
        const nextModels = Array.from(new Set([...normalized, ...nextEnabled]));
        const nextModel = nextEnabled.includes(selected.model)
          ? selected.model
          : nextEnabled[0] || '';
        patchSelected({ models: nextModels, enabledModels: nextEnabled, model: nextModel });
        setNotice([`已获取 ${normalized.length} 个视频模型`, protocolNote, result.evidence].filter(Boolean).join('；'));
      } catch (err) {
        setErrorText(err instanceof Error ? err.message : '拉取视频模型失败');
      } finally {
        setFetching(false);
      }
      return;
    }
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
      setErrorText(describeRequestError(err, selected.baseUrl));
      setNotice('获取模型失败；已保留当前模型配置，可修正地址后重试或继续手动维护模型名');
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

  const handleTest = async (profileId = selected?.id || '') => {
    const target = drafts.find((draft) => draft.id === profileId);
    if (!target) return;
    setTesting(true);
    setTestingProfileId(target.id);
    setNotice('');
    setErrorText('');
    try {
      const message = await testConnection({
        baseUrl: target.baseUrl.trim(),
        apiKey: target.apiKey.trim(),
        model: target.model.trim(),
        profileId: target.id,
        kind: target.kind,
        videoApiMode: target.kind === 'video' ? target.videoApiMode : undefined,
        videoCustomConfig: target.kind === 'video' ? target.videoCustomConfig : undefined,
      });
      setNotice(message);
    } catch (err) {
      setErrorText(describeRequestError(err, target.baseUrl));
    } finally {
      setTesting(false);
      setTestingProfileId('');
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
    if (!settings || loading || storeError) {
      setSaving(false);
      setErrorText('模型配置尚未成功读取，当前内容不会保存或覆盖原配置。请先重新读取。');
      return;
    }
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
      for (const customVideo of draftsToSave.filter((draft) => draft.kind === 'video' && draft.videoApiMode === 'custom')) {
        const parseObject = (value: string, label: string) => {
          const parsed: unknown = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象`);
        };
        if (!customVideo.videoCustomConfig.createPath.trim()) throw new Error('自定义视频协议缺少提交路径');
        if (!customVideo.videoCustomConfig.pollPath.trim()) throw new Error('自定义异步视频协议缺少查询任务路径');
        if (!customVideo.videoCustomConfig.outputUrlPath.trim()) throw new Error('自定义视频协议缺少视频地址字段路径');
        parseObject(customVideo.videoCustomConfig.requestBodyTemplate, '请求体模板');
        parseObject(customVideo.videoCustomConfig.headersTemplate || '{}', '请求头模板');
        parseObject(customVideo.videoCustomConfig.statusMap || '{}', '状态映射');
        const sampleValues = customVideoPreviewValues(customVideo.model);
        renderVideoRequestTemplate(customVideo.videoCustomConfig.requestBodyTemplate, sampleValues);
        renderVideoHeadersTemplate(customVideo.videoCustomConfig.headersTemplate, sampleValues);
        if (!customVideo.videoCustomConfig.pollPath.includes('{{taskId}}')) {
          throw new Error('轮询路径需要包含 {{taskId}}，例如 /videos/{{taskId}}');
        }
      }
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
          videoApiMode: draft.videoApiMode,
          videoCustomConfig: draft.kind === 'video' ? draft.videoCustomConfig : undefined,
          // 生图配置不能把语言模型名写成 Responses 主模型；运行时会按该路生图模型校验。
          responsesModel: draft.kind === 'text' ? draft.model : draft.responsesModel,
          enabled: draft.enabled,
        })),
        activeProfileId: activeIdToSave,
        textProfileId: textProfileIdToSave,
        direct,
      });
      const persistedIds = new Map(normalizedDrafts.map((draft, index) => [
        draft.id,
        savedSettings.profiles[index]?.id || draft.id,
      ]));
      const persistedProfiles = new Map(savedSettings.profiles.map((profile) => [profile.id, profile]));
      // 保存期间输入框仍可编辑；用最新本地字段，只把 Bridge 分配的稳定 ID / Key 状态同步回来。
      setDrafts((current) => current.map((draft) => {
        const id = persistedIds.get(draft.id) || draft.id;
        const persisted = persistedProfiles.get(id);
        return { ...draft, id, keyConfigured: persisted?.keyConfigured ?? draft.keyConfigured };
      }));
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

  const toggleOverviewModel = (profileId: string, modelName: string) => {
    const target = drafts.find((draft) => draft.id === profileId);
    if (!target) return;
    const wasEnabled = target.enabledModels.includes(modelName)
      || (target.enabledModels.length === 0 && target.model === modelName);
    const enabledModels = wasEnabled
      ? target.enabledModels.filter((name) => name !== modelName)
      : Array.from(new Set([...target.enabledModels, modelName]));
    const nextModel = enabledModels.includes(target.model) ? target.model : enabledModels[0] || '';
    const nextDrafts = drafts.map((draft) => (
      draft.id === profileId ? { ...draft, enabledModels, model: nextModel } : draft
    ));
    setDrafts(nextDrafts);
    window.setTimeout(() => void handleSave(nextDrafts, activeId, textProfileId), 0);
  };

  const currentKind: ProfileKind | null = tab === 'image' || tab === 'text' || tab === 'video' ? tab : null;
  const overviewProfiles = currentKind ? drafts.filter((draft) => draft.kind === currentKind) : [];
  const canTestProfile = (draft: ProfileDraft) => Boolean(
    (draft.apiKey.trim() || draft.keyConfigured)
    && (draft.kind === 'image' || draft.model.trim()),
  );
  const deleteSelectedProfile = () => {
    if (!selected) return;
    handleDeleteProfile(selected.id);
    setEditorOpen(false);
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
    && (selected.kind === 'text' || selected.enabledModels.length === 0 || selected.enabledModels.includes(selected.model)),
  );
  const imageProfiles = profileSummary.filter((profile) => profile.kind === 'image');
  const textProfiles = profileSummary.filter((profile) => profile.kind === 'text');
  const videoProfiles = profileSummary.filter((profile) => profile.kind === 'video');
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

        {!editorOpen && !roleDetailOpen ? (
        <div className="model-config-tabs" role="tablist" aria-label="设置分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'image'}
            className={`model-config-tab ${tab === 'image' ? 'active' : ''}`}
            onClick={() => { setTab('image'); setEditorOpen(false); }}
          >
            生图模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            className={`model-config-tab ${tab === 'text' ? 'active' : ''}`}
            onClick={() => { setTab('text'); setEditorOpen(false); }}
          >
            语言模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'video'}
            className={`model-config-tab ${tab === 'video' ? 'active' : ''}`}
            onClick={() => { setTab('video'); setEditorOpen(false); }}
          >
            视频模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'preferences'}
            className={`model-config-tab ${tab === 'preferences' ? 'active' : ''}`}
            onClick={() => { setTab('preferences'); setEditorOpen(false); }}
          >
            偏好档案
          </button>
        </div>
        ) : null}

        {tab === 'preferences' ? (
          <div className="model-config-modal-body model-config-roles-panel">
            <ChatRolesSettings onDetailChange={setRoleDetailOpen} />
          </div>
        ) : editorOpen ? (
          <>
        <div className="model-config-detail-head">
          <button type="button" className="model-config-back" onClick={() => setEditorOpen(false)}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 3.5 5.5 8l4.5 4.5M6 8h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>返回</span>
          </button>
          <div className="model-config-detail-actions">
            <strong>{selected?.name || '模型配置'}</strong>
            {selected ? (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-checked={selected.enabled}
                  aria-label={`${selected.enabled ? '停用' : '启用'} ${selected.name}`}
                  title={selected.enabled ? '停用这路配置' : '启用这路配置'}
                  className={`model-config-profile-switch ${selected.enabled ? 'on' : ''}`}
                  disabled={saving}
                  onClick={() => toggleDraftEnabled(selected)}
                >
                  <span className="model-config-profile-switch-track" aria-hidden="true"><i /></span>
                </button>
                <button type="button" className="model-config-delete-action" aria-label={`删除 ${selected.name}`} title="删除配置" onClick={deleteSelectedProfile}>
                  <TrashIcon />
                  <span>删除</span>
                </button>
              </>
            ) : null}
          </div>
        </div>
        <div className="model-config-split is-detail">
          <aside className="model-config-profiles" aria-label={tab === 'image' ? '生图配置列表' : tab === 'video' ? '视频配置列表' : '语言模型配置列表'}>
            <div className="model-config-profile-list">
              <section className="model-config-profile-group" aria-label={tab === 'image' ? '生图配置' : tab === 'video' ? '视频配置' : '语言模型配置'}>
                  {(tab === 'image' ? imageProfiles : tab === 'video' ? videoProfiles : textProfiles).length > 0
                  ? (tab === 'image' ? imageProfiles : tab === 'video' ? videoProfiles : textProfiles).map(renderProfileRow)
                  : (
                    <p className="model-config-profile-empty">
                      {!settings || storeError
                        ? (loading ? '正在读取已保存的模型配置…' : '配置读取失败；本机原配置未被清空')
                        : tab === 'image' ? '还没有生图配置' : tab === 'video' ? '还没有视频配置' : '还没有语言模型配置'}
                    </p>
                  )}
              </section>
            </div>
            <div className="model-config-profile-adds">
              <button type="button" className={`model-config-profile-add ${tab === 'text' ? 'is-text' : ''}`} disabled={!settings || loading || Boolean(storeError)} onClick={() => handleAddProfile(tab === 'image' ? 'image' : tab === 'video' ? 'video' : 'text')}>
                <PlusIcon />
                <span>{tab === 'image' ? '添加生图配置' : tab === 'video' ? '添加视频配置' : '添加语言模型配置'}</span>
              </button>
            </div>
          </aside>

          <div className="model-config-modal-body">
            {!selected ? (
              <div className="model-config-loading" role="status">
                {drafts.length > 0 && !loading && !storeError ? (
                  <>
                    <strong>{tab === 'video' ? '还没有视频配置' : tab === 'text' ? '还没有语言模型配置' : '还没有生图配置'}</strong>
                    <span>从左侧添加配置后，再填写接口和模型信息。</span>
                  </>
                ) : (
                  <>
                    <strong>{storeError ? '配置读取失败' : '配置加载中…'}</strong>
                    <span>
                      {storeError
                        ? `${/fetch failed|failed to fetch|timed out/i.test(storeError) ? '无法读取本机 Bridge（端口 3788）' : storeError}。原配置仍保存在本机，没有被清空。`
                        : '正在从本机 Bridge（端口 3788）读取配置。'}
                    </span>
                    <button type="button" onClick={() => void load()} disabled={loading}>
                      {loading ? '读取中…' : (storeError ? '重试读取' : '重新载入')}
                    </button>
                  </>
                )}
              </div>
            ) : null}
            {selected ? (
              <>
                {/* 没配好就黄字拍在脸上：以前要等画布上生成失败才知道少选了模型 */}
                {!selectedReady ? (
                  <p className="model-config-warn" role="alert">
                    {selected?.kind === 'text' ? '这路语言模型还没配好' : selected?.kind === 'video' ? '这路视频模型还没配好' : '这路生图模型还没配好'}
                    ：填好 API Key，再获取并勾选模型，或在下方手动填写准确模型名{selected?.kind === 'text' ? '' : selected?.kind === 'video' ? '，否则视频节点无法生成' : '，否则画布上无法出图'}。
                  </p>
                ) : null}
                <div className="model-config-provider-module">
                <section className="model-config-group" aria-label="基础信息">
                  <div className="model-config-form-grid">
                <div className="model-config-field">
                  <span className="model-config-field-label">配置名称</span>
                  <div className="model-config-name-row">
                    <input
                      className="model-config-input"
                      value={selected.name}
                      placeholder={selected.kind === 'text' ? '例如：提示词优化模型' : selected.kind === 'video' ? '例如：视频中转站' : '例如：主中转站 / 备用 Key'}
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
                  ) : selected.kind === 'image' ? (
                    <div className="model-config-field">
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
                  ) : null}
                  </div>
                </section>

                <section className="model-config-group" aria-label="服务连接">
                  <div className="model-config-form-grid">
                    <div className="model-config-field">
                      <span className="model-config-field-label">API Base URL</span>
                      <input
                        className="model-config-input"
                        value={selected.baseUrl}
                        placeholder={selected.kind === 'video' ? '填写中转站提供的视频 API Base URL' : 'https://api.openai.com/v1'}
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
                  <div className="model-config-field">
                  <span className="model-config-field-label">默认使用模型</span>
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
                </div>

                <section className="model-config-group model-config-model-catalog" aria-label="可用模型">
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

                {selected.kind === 'video' ? (
                  <section className="model-config-advanced-panel" aria-label="视频高级接口设置">
                    <button
                      type="button"
                      className="model-config-advanced-toggle"
                      aria-expanded={videoAdvancedOpen}
                      onClick={() => setVideoAdvancedOpen((open) => !open)}
                    >
                      <span className={`model-config-advanced-chevron${videoAdvancedOpen ? ' is-open' : ''}`} aria-hidden="true">
                        <svg viewBox="0 0 16 16" fill="none"><path d="m3.5 6 4.5 4 4.5-4" /></svg>
                      </span>
                      <span className="model-config-advanced-copy">
                        <strong>高级接口设置</strong>
                        <small>仅在接口类型或字段与默认值不同时修改</small>
                      </span>
                      <span className="model-config-advanced-status">
                        {selected.videoApiMode === 'custom' ? '自定义接口' : selected.videoApiMode === 'auto' ? '自动识别' : '协议预设'}
                      </span>
                    </button>
                    {videoAdvancedOpen ? (
                      <div className="model-config-advanced-content">
                        <label className="model-config-field">
                          <span className="model-config-field-label">接口类型</span>
                          <select
                            className="model-config-select"
                            value={selected.videoApiMode}
                            onChange={(event) => {
                              const videoApiMode = event.target.value as VideoApiMode;
                              patchSelected({ videoApiMode });
                            }}
                          >
                            <option value="auto">自动识别</option>
                            <option value="openai-videos">OpenAI 兼容</option>
                            <option value="xai-videos">Grok Imagine（xAI 格式）</option>
                            <option value="grsai-generate">GrsAI Generate</option>
                            <option value="media-v1">Media API</option>
                            <option value="custom">自定义接口</option>
                          </select>
                        </label>
                        {selected.videoApiMode === 'custom' ? (
                          <>
                            <p className="model-config-custom-hint">
                              根据服务商文档填写。请求体使用 JSON 和变量，不执行 JavaScript；常用变量：model、prompt、seconds、ratio、resolution、imageUrls。
                            </p>
                            <div className="model-config-form-grid">
                              <label className="model-config-field">
                                <span className="model-config-field-label">创建任务路径</span>
                                <input
                                  className="model-config-input"
                                  value={selected.videoCustomConfig.createPath}
                                  placeholder="/videos/generations"
                                  onChange={(event) => patchSelectedVideoConfig({ createPath: event.target.value })}
                                />
                              </label>
                              <label className="model-config-field">
                                <span className="model-config-field-label">查询任务路径</span>
                                <input
                                  className="model-config-input"
                                  value={selected.videoCustomConfig.pollPath}
                                  placeholder="/videos/{{taskId}}"
                                  onChange={(event) => patchSelectedVideoConfig({ pollPath: event.target.value })}
                                />
                              </label>
                              <label className="model-config-field">
                                <span className="model-config-field-label">本机图片发送方式</span>
                                <select
                                  className="model-config-select"
                                  value={selected.videoCustomConfig.imageTransport}
                                  onChange={(event) => patchSelectedVideoConfig({ imageTransport: event.target.value as CustomVideoApiConfig['imageTransport'] })}
                                >
                                  <option value="public-url">公网 HTTPS 图片链接</option>
                                  <option value="data-url">内联 Data URL</option>
                                </select>
                              </label>
                            </div>
                            <label className="model-config-field">
                              <span className="model-config-field-label">请求体 JSON</span>
                              <textarea
                                className="model-config-template model-config-template-tall"
                                value={selected.videoCustomConfig.requestBodyTemplate}
                                spellCheck={false}
                                onChange={(event) => patchSelectedVideoConfig({ requestBodyTemplate: event.target.value })}
                              />
                            </label>
                            <div className="model-config-template-preview-actions">
                              <button type="button" className="model-config-prefs-action" onClick={previewCustomVideoConfig}>
                                预览请求
                              </button>
                              <span>仅本机预览，不会调用服务商</span>
                            </div>
                            {videoTemplatePreviewError ? <p className="model-config-error" role="alert">{videoTemplatePreviewError}</p> : null}
                            {videoTemplatePreview ? <pre className="model-config-template-preview">{videoTemplatePreview}</pre> : null}
                            <details className="model-config-optional-settings">
                              <summary>
                                <span>附加请求头（JSON，可选）</span>
                                {selected.videoCustomConfig.headersTemplate.trim() !== '{}' ? <small>已配置</small> : null}
                              </summary>
                              <p className="model-config-custom-hint">
                                这是 JSON，不是 JS。通常留空即可，系统会自动发送 API Key；只有服务商要求额外请求头时才填写。
                              </p>
                              <textarea
                                className="model-config-template"
                                value={selected.videoCustomConfig.headersTemplate}
                                spellCheck={false}
                                placeholder={'{\n  "X-API-Key": "{{apiKey}}"\n}'}
                                onChange={(event) => patchSelectedVideoConfig({ headersTemplate: event.target.value })}
                              />
                            </details>
                            <details className="model-config-optional-settings">
                              <summary>
                                <span>响应字段映射（仅字段不同时修改）</span>
                              </summary>
                              <div className="model-config-custom-mappings">
                                <label className="model-config-field">
                                  <span className="model-config-field-label">任务 ID 路径</span>
                                  <input className="model-config-input" value={selected.videoCustomConfig.taskIdPath} onChange={(event) => patchSelectedVideoConfig({ taskIdPath: event.target.value })} />
                                </label>
                                <label className="model-config-field">
                                  <span className="model-config-field-label">状态路径</span>
                                  <input className="model-config-input" value={selected.videoCustomConfig.statusPath} onChange={(event) => patchSelectedVideoConfig({ statusPath: event.target.value })} />
                                </label>
                                <label className="model-config-field">
                                  <span className="model-config-field-label">进度路径</span>
                                  <input className="model-config-input" value={selected.videoCustomConfig.progressPath} onChange={(event) => patchSelectedVideoConfig({ progressPath: event.target.value })} />
                                </label>
                                <label className="model-config-field">
                                  <span className="model-config-field-label">视频地址路径</span>
                                  <input className="model-config-input" value={selected.videoCustomConfig.outputUrlPath} onChange={(event) => patchSelectedVideoConfig({ outputUrlPath: event.target.value })} />
                                </label>
                                <label className="model-config-field">
                                  <span className="model-config-field-label">错误信息路径</span>
                                  <input className="model-config-input" value={selected.videoCustomConfig.errorPath} onChange={(event) => patchSelectedVideoConfig({ errorPath: event.target.value })} />
                                </label>
                                <label className="model-config-field model-config-field-wide">
                                  <span className="model-config-field-label">状态值映射 JSON</span>
                                  <textarea
                                    className="model-config-template"
                                    value={selected.videoCustomConfig.statusMap}
                                    spellCheck={false}
                                    placeholder={'{\n  "success": "completed",\n  "error": "failed"\n}'}
                                    onChange={(event) => patchSelectedVideoConfig({ statusMap: event.target.value })}
                                  />
                                </label>
                              </div>
                            </details>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </section>
                ) : null}

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
                disabled={saving || loading || Boolean(storeError) || !settings}
                onClick={() => void handleSave()}
              >
                {saving ? '保存中...' : '保存配置'}
              </button>
            </div>
          </div>
        </div>
          </>
        ) : (
          <section className="model-config-overview" aria-label="模型配置列表">
            <div className="model-config-overview-toolbar">
              <button
                type="button"
                className="model-config-profile-add"
                disabled={!settings || loading || Boolean(storeError) || !currentKind}
                onClick={() => { if (currentKind) handleAddProfile(currentKind); }}
              >
                <PlusIcon />
                <span>添加模型</span>
              </button>
            </div>
            {!settings || loading ? (
              <div className="model-config-loading" role="status">
                <strong>配置加载中…</strong>
                <span>正在读取本机模型配置。</span>
              </div>
            ) : storeError ? (
              <div className="model-config-loading" role="status">
                <strong>配置读取失败</strong>
                <button type="button" onClick={() => void load()} disabled={loading}>重试读取</button>
              </div>
            ) : overviewProfiles.length > 0 ? (
              <div className="model-config-overview-list">
                {overviewProfiles.map((draft) => (
                  <ProfileOverviewCard
                    key={draft.id}
                    draft={draft}
                    selected={draft.id === selectedId}
                    canTest={canTestProfile(draft)}
                    testing={testingProfileId === draft.id}
                    saving={saving}
                    onOpen={(id) => { setSelectedId(id); setEditorOpen(true); }}
                    onToggleModel={toggleOverviewModel}
                    onTest={(id) => void handleTest(id)}
                  />
                ))}
              </div>
            ) : (
              <div className="model-config-overview-empty">
                <strong>{tab === 'image' ? '还没有生图模型' : tab === 'text' ? '还没有语言模型' : '还没有视频模型'}</strong>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
