import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { createId } from '@/lib/id';
import {
  deletePromptSkill,
  getGeneralChatPrompt,
  getPromptSkills,
  saveImageDataUrl,
  savePromptSkill,
  type GeneralChatPrompt,
  type PromptSkill,
  type RoleSkill,
} from '@/lib/bridge';
import { notifyChatRolesUpdated } from '@/lib/chatRoles';
import { ROLE_AVATARS } from '@/lib/roleAvatars';
import ParameterSlider from '@/components/ParameterSlider';
import { TrashIcon } from '@/components/canvas/NodeChrome';
import './ChatRolesSettings.css';

const MAX_ROLES = 5;
const MAX_ROLE_SKILLS = 9;
const MAX_ROLE_CONTENT = 24_000;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_AVATAR_FILE_BYTES = 2 * 1024 * 1024;

interface RoleDraft {
  id: string;
  name: string;
  description: string;
  category: string;
  avatarUrl: string;
  avatarDataUrl: string;
  content: string;
  skills: RoleSkill[];
  temperature: number;
  enabled: boolean;
}

const emptyDraft = (): RoleDraft => ({
  id: '',
  name: '',
  description: '',
  category: '',
  avatarUrl: ROLE_AVATARS[0].url,
  avatarDataUrl: '',
  content: '',
  skills: [],
  temperature: 0.6,
  enabled: true,
});

function draftOfRole(role: PromptSkill): RoleDraft {
  return {
    id: role.id,
    name: role.name,
    description: role.description || '',
    category: role.category,
    avatarUrl: role.avatarUrl,
    avatarDataUrl: '',
    content: role.content,
    skills: role.skills.map((skill) => ({ ...skill })),
    temperature: typeof role.temperature === 'number' ? role.temperature : 0.6,
    enabled: true,
  };
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取头像失败'));
    reader.readAsDataURL(file);
  });
}

function skillNameFromFile(name: string): string {
  return name.replace(/\.(?:md|markdown|txt)$/i, '').trim().slice(0, 100) || '未命名 Skill';
}

function RoleAvatar({ role, size = 'small' }: { role: Pick<PromptSkill, 'name' | 'avatarUrl'>; size?: 'small' | 'large' }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [role.avatarUrl]);
  return (
    <span className={`chat-role-avatar is-${size}`} aria-hidden="true">
      {role.avatarUrl && !failed
        ? <img src={role.avatarUrl} alt="" onError={() => setFailed(true)} />
        : <span>{Array.from(role.name.trim())[0] || '角'}</span>}
    </span>
  );
}

/**
 * 角色与角色内 Skill。沿用 /api/skills 的接口名以兼容既有本机数据，
 * 但界面上把旧“提示词 Skill”收敛成最多 5 个可选择角色。
 */
interface ChatRolesSettingsProps {
  onDetailChange?: (open: boolean) => void;
}

export default function ChatRolesSettings({ onDetailChange }: ChatRolesSettingsProps) {
  const [roles, setRoles] = useState<PromptSkill[]>([]);
  const [generalPrompt, setGeneralPrompt] = useState<GeneralChatPrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [generalPromptOpen, setGeneralPromptOpen] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [editingSkillIndex, setEditingSkillIndex] = useState<number | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillContent, setSkillContent] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const avatarMenuRef = useRef<HTMLDivElement>(null);
  const [avatarMenuPosition, setAvatarMenuPosition] = useState({ left: 0, top: 0 });
  const skillInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!avatarPickerOpen) return;
    const positionMenu = () => {
      const button = avatarButtonRef.current;
      const menu = avatarMenuRef.current;
      if (!button || !menu) return;
      const anchor = button.getBoundingClientRect();
      const height = menu.offsetHeight;
      const below = anchor.bottom + 8;
      const top = below + height <= window.innerHeight - 16 ? below : anchor.top - height - 8;
      setAvatarMenuPosition({
        left: Math.max(16, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 16)),
        top: Math.max(16, Math.min(top, window.innerHeight - height - 16)),
      });
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!avatarButtonRef.current?.contains(target) && !avatarMenuRef.current?.contains(target)) {
        setAvatarPickerOpen(false);
      }
    };
    positionMenu();
    const selectedAvatar = avatarMenuRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      || avatarMenuRef.current?.querySelector<HTMLButtonElement>('button');
    selectedAvatar?.focus({ preventScroll: true });
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [avatarPickerOpen]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [nextRoles, nextGeneralPrompt] = await Promise.all([getPromptSkills(), getGeneralChatPrompt()]);
      setRoles(nextRoles);
      setGeneralPrompt(nextGeneralPrompt);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '读取角色失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openNewRole = () => {
    if (roles.length >= MAX_ROLES) {
      setError(`最多可以添加 ${MAX_ROLES} 个角色`);
      return;
    }
    setGeneralPromptOpen(false);
    setDraft(emptyDraft());
    onDetailChange?.(true);
    setAvatarPickerOpen(false);
    setEditingSkillIndex(null);
    setError('');
    setNotice('');
  };

  const openRole = (role: PromptSkill) => {
    setGeneralPromptOpen(false);
    setDraft(draftOfRole(role));
    onDetailChange?.(true);
    setAvatarPickerOpen(false);
    setEditingSkillIndex(null);
    setError('');
    setNotice('');
  };

  const openGeneralPrompt = () => {
    if (!generalPrompt) return;
    setDraft(null);
    setGeneralPromptOpen(true);
    onDetailChange?.(true);
    setAvatarPickerOpen(false);
    setEditingSkillIndex(null);
    setError('');
    setNotice('');
  };

  const closeEditor = () => {
    if (saving) return;
    setDraft(null);
    setGeneralPromptOpen(false);
    onDetailChange?.(false);
    setAvatarPickerOpen(false);
    setEditingSkillIndex(null);
    setError('');
  };

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !draft) return;
    if (!file.type.startsWith('image/')) {
      setError('头像需要是图片文件');
      return;
    }
    if (file.size > MAX_AVATAR_FILE_BYTES) {
      setError('头像不能超过 2 MB');
      return;
    }
    try {
      const avatarDataUrl = await readAsDataUrl(file);
      setDraft((current) => current ? { ...current, avatarDataUrl } : current);
      setAvatarPickerOpen(false);
      setError('');
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : '读取头像失败');
    }
  };

  const addSkillFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!draft || files.length === 0) return;
    const available = MAX_ROLE_SKILLS - draft.skills.length;
    if (available <= 0) {
      setError(`每个角色最多添加 ${MAX_ROLE_SKILLS} 个 Skill`);
      return;
    }
    try {
      const accepted = files.slice(0, available);
      const skills = await Promise.all(accepted.map(async (file): Promise<RoleSkill> => {
        if (!/\.(?:md|markdown|txt)$/i.test(file.name)) throw new Error('Skill 仅支持 .md / .markdown / .txt 文件');
        if (file.size > MAX_SKILL_FILE_BYTES) throw new Error(`${file.name} 超过 512 KB`);
        const content = (await readAsText(file)).trim();
        if (!content) throw new Error(`${file.name} 是空文件`);
        if (content.length > MAX_ROLE_CONTENT) throw new Error(`${file.name} 超过 ${MAX_ROLE_CONTENT.toLocaleString()} 个字符`);
        return { id: createId('role_skill'), name: skillNameFromFile(file.name), content };
      }));
      setDraft({ ...draft, skills: [...draft.skills, ...skills] });
      setError(files.length > available ? `每个角色最多 ${MAX_ROLE_SKILLS} 个 Skill，已保留前 ${available} 个` : '');
    } catch (skillError) {
      setError(skillError instanceof Error ? skillError.message : '读取 Skill 失败');
    }
  };

  const beginEditSkill = (index: number) => {
    if (!draft) return;
    const skill = draft.skills[index];
    if (!skill) return;
    setEditingSkillIndex(index);
    setSkillName(skill.name);
    setSkillContent(skill.content);
    setError('');
  };

  const beginNewSkill = () => {
    if (!draft) return;
    if (draft.skills.length >= MAX_ROLE_SKILLS) {
      setError(`每个角色最多添加 ${MAX_ROLE_SKILLS} 个 Skill`);
      return;
    }
    setEditingSkillIndex(-1);
    setSkillName('');
    setSkillContent('');
    setError('');
  };

  const saveSkillEditor = () => {
    if (!draft || editingSkillIndex === null) return;
    const name = skillName.trim();
    const content = skillContent.trim();
    if (!name || !content) {
      setError('Skill 名称和内容不能为空');
      return;
    }
    const skill: RoleSkill = {
      id: editingSkillIndex >= 0 ? draft.skills[editingSkillIndex]?.id || createId('role_skill') : createId('role_skill'),
      name,
      content,
    };
    const skills = editingSkillIndex >= 0
      ? draft.skills.map((item, index) => index === editingSkillIndex ? skill : item)
      : [...draft.skills, skill];
    setDraft({ ...draft, skills });
    setEditingSkillIndex(null);
    setSkillName('');
    setSkillContent('');
    setError('');
  };

  const removeSkill = (index: number) => {
    if (!draft) return;
    setDraft({ ...draft, skills: draft.skills.filter((_, skillIndex) => skillIndex !== index) });
    if (editingSkillIndex === index) setEditingSkillIndex(null);
  };

  const saveDraft = async () => {
    if (!draft || saving) return;
    const name = draft.name.trim();
    const content = draft.content.trim();
    if (!name) {
      setError('请填写角色名称');
      return;
    }
    if (!content && draft.skills.length === 0) {
      setError('系统提示词和 Skill 至少填写一项');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      let avatarUrl = draft.avatarUrl;
      if (draft.avatarDataUrl) avatarUrl = (await saveImageDataUrl(draft.avatarDataUrl)).url;
      const saved = await savePromptSkill({
        ...(draft.id ? { id: draft.id } : {}),
        name,
        description: draft.description.trim(),
        category: draft.category.trim(),
        avatarUrl,
        content,
        skills: draft.skills,
        temperature: draft.temperature,
        enabled: true,
      });
      setRoles((current) => [saved, ...current.filter((role) => role.id !== saved.id)].slice(0, MAX_ROLES));
      setDraft(null);
      onDetailChange?.(false);
      setEditingSkillIndex(null);
      setNotice(draft.id ? '角色已更新' : '角色已创建');
      notifyChatRolesUpdated();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存角色失败');
    } finally {
      setSaving(false);
    }
  };

  const removeRole = async (role: PromptSkill) => {
    if (!window.confirm(`删除角色“${role.name}”？历史对话中的角色快照会保留。`)) return;
    setError('');
    try {
      await deletePromptSkill(role.id);
      setRoles((current) => current.filter((item) => item.id !== role.id));
      if (draft?.id === role.id) setDraft(null);
      setNotice('角色已删除');
      notifyChatRolesUpdated();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '删除角色失败');
    }
  };

  const roleDraft = draft as RoleDraft;

  return (
    <section className={`chat-roles-settings${draft || generalPromptOpen ? ' is-editing' : ''}`} aria-label="AI 对话角色">
      {!draft && !generalPromptOpen ? (
        <>
      <header className="chat-roles-settings-head">
        <div>
          <strong>AI 对话角色</strong>
        </div>
        <span className="chat-roles-count">{roles.length} / {MAX_ROLES}</span>
        <button type="button" className="chat-roles-button" onClick={openNewRole} disabled={loading || roles.length >= MAX_ROLES}>
          新建角色
        </button>
      </header>

      {error ? <p className="chat-roles-message is-error" role="alert">{error}</p> : null}
      {notice ? <p className="chat-roles-message" role="status">{notice}</p> : null}

        <div className="chat-roles-list">
          {loading ? <p className="chat-roles-empty">正在读取角色...</p> : null}
          {!loading && roles.length === 0 ? <p className="chat-roles-empty">暂无自定义角色</p> : null}
          <article className="chat-role-row chat-role-row-general">
            <button type="button" className="chat-role-row-main" aria-label="查看通用模式提示词" onClick={openGeneralPrompt} disabled={!generalPrompt}>
              <RoleAvatar role={{ name: '通用', avatarUrl: '' }} />
              <span className="chat-role-card-copy">
                <strong>{generalPrompt?.name || '通用模式'}</strong>
                <span>{generalPrompt?.description || '系统内置基础提示词'}</span>
              </span>
            </button>
            <span className="chat-role-readonly-badge">只读</span>
          </article>
          {roles.map((role) => (
            <article className="chat-role-row" key={role.id}>
              <button type="button" className="chat-role-row-main" aria-label={`编辑角色 ${role.name}`} onClick={() => openRole(role)}>
                <RoleAvatar role={role} />
                <span className="chat-role-card-copy">
                  <strong>{role.name}</strong>
                  <span>{role.description || role.content.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 120) || role.skills[0]?.name}</span>
                </span>
              </button>
              <button type="button" className="chat-roles-icon-button" aria-label={`删除角色 ${role.name}`} title="删除角色" onClick={() => void removeRole(role)}>
                <TrashIcon />
              </button>
            </article>
          ))}
        </div>
        </>
      ) : generalPromptOpen ? (
        <div className="chat-role-editor">
          <div className="model-config-detail-head chat-role-detail-head">
            <button type="button" className="model-config-back" onClick={closeEditor} aria-label="返回 AI 对话角色列表">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 3.5 5.5 8l4.5 4.5M6 8h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>返回</span>
            </button>
            <div className="model-config-detail-actions">
              <strong>{generalPrompt?.name || '通用模式'}</strong>
              <span className="chat-role-readonly-badge">系统内置 · 只读</span>
            </div>
          </div>
          <div className="chat-role-editor-scroll">
            <pre className="chat-role-general-prompt" role="textbox" aria-readonly="true" tabIndex={0} aria-label="通用模式系统提示词">
              {generalPrompt?.content || '通用提示词暂不可用'}
            </pre>
          </div>
        </div>
      ) : (
        <div className="chat-role-editor">
          <div className="model-config-detail-head chat-role-detail-head">
            <button type="button" className="model-config-back" onClick={closeEditor} disabled={saving} aria-label="返回 AI 对话角色列表">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 3.5 5.5 8l4.5 4.5M6 8h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>返回</span>
            </button>
            <div className="model-config-detail-actions">
              <strong>{roleDraft.name.trim() || (roleDraft.id ? '编辑角色' : '新建角色')}</strong>
            </div>
          </div>

          <div className="chat-role-editor-scroll">
            {error ? <p className="chat-roles-message is-error" role="alert">{error}</p> : null}
            {notice ? <p className="chat-roles-message" role="status">{notice}</p> : null}

          <div className="chat-role-identity">
            <div
              className="chat-role-avatar-control"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget) && !avatarMenuRef.current?.contains(event.relatedTarget)) setAvatarPickerOpen(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape' || !avatarPickerOpen) return;
                event.preventDefault();
                event.stopPropagation();
                setAvatarPickerOpen(false);
                avatarButtonRef.current?.focus();
              }}
            >
              <button ref={avatarButtonRef} type="button" className="chat-role-avatar-picker" aria-expanded={avatarPickerOpen} onClick={() => setAvatarPickerOpen((open) => !open)} aria-label="选择角色头像" disabled={saving}>
                <RoleAvatar role={{ name: roleDraft.name || '角', avatarUrl: roleDraft.avatarDataUrl || roleDraft.avatarUrl }} size="large" />
                <span>选择头像</span>
              </button>
              <input ref={avatarInputRef} className="chat-roles-file-input" type="file" accept="image/*" onChange={(event) => void chooseAvatar(event)} />
              {avatarPickerOpen ? createPortal(
                <div ref={avatarMenuRef} className="chat-role-avatar-menu" style={avatarMenuPosition} role="group" aria-label="角色头像选项">
                  <div className="chat-role-avatar-grid">
                    {ROLE_AVATARS.map((avatar) => (
                      <button
                        key={avatar.url}
                        type="button"
                        className="chat-role-avatar-option"
                        aria-label={avatar.name}
                        aria-pressed={!roleDraft.avatarDataUrl && roleDraft.avatarUrl === avatar.url}
                        onClick={() => {
                          setDraft({ ...roleDraft, avatarUrl: avatar.url, avatarDataUrl: '' });
                          setAvatarPickerOpen(false);
                          avatarButtonRef.current?.focus();
                        }}
                      >
                        <img src={avatar.url} alt="" />
                      </button>
                    ))}
                  </div>
                  <button type="button" className="chat-roles-button is-quiet chat-role-avatar-upload" onClick={() => avatarInputRef.current?.click()}>上传自定义头像</button>
                </div>, document.body
              ) : null}
            </div>
            <div className="chat-role-identity-fields">
              <label className="model-config-field chat-role-name-field">
                <span className="model-config-field-label">角色名称</span>
                <input className="model-config-input" value={roleDraft.name} maxLength={100} placeholder="例如：创意设计" onChange={(event) => setDraft({ ...roleDraft, name: event.target.value })} />
              </label>
              <div className="model-config-field chat-role-temperature">
                <span className="model-config-field-label">角色温度</span>
                <ParameterSlider
                  ariaLabel="角色温度"
                  value={Math.round(roleDraft.temperature * 10)}
                  min={0}
                  max={10}
                  valueLabel={roleDraft.temperature.toFixed(1)}
                  minLabel="稳定"
                  maxLabel="发散"
                  scaleInside
                  onChange={(value) => setDraft({ ...roleDraft, temperature: value / 10 })}
                />
              </div>
            </div>
            <label className="model-config-field">
              <span className="model-config-field-label">简介（可选）</span>
              <input className="model-config-input" value={roleDraft.description} maxLength={400} placeholder="简短介绍这个角色" onChange={(event) => setDraft({ ...roleDraft, description: event.target.value })} />
            </label>
          </div>

          <label className="model-config-field">
            <span className="model-config-field-label">系统提示词</span>
            <textarea
              className="chat-role-prompt"
              value={roleDraft.content}
              maxLength={MAX_ROLE_CONTENT}
              placeholder="描述这个角色的工作方式、判断标准和输出要求。"
              onChange={(event) => setDraft({ ...roleDraft, content: event.target.value })}
            />
            <small>{roleDraft.content.length.toLocaleString()} / {MAX_ROLE_CONTENT.toLocaleString()}</small>
          </label>

          <section className="chat-role-skills" aria-label="角色 Skill">
            <header>
              <div>
                <strong>Skill</strong>
                <span>{roleDraft.skills.length} / {MAX_ROLE_SKILLS}</span>
              </div>
              <div className="chat-role-skill-actions">
                <button type="button" className="chat-roles-button is-quiet" onClick={() => skillInputRef.current?.click()} disabled={roleDraft.skills.length >= MAX_ROLE_SKILLS}>
                  上传 Skill
                </button>
                <button type="button" className="chat-roles-button is-quiet" onClick={beginNewSkill} disabled={roleDraft.skills.length >= MAX_ROLE_SKILLS}>
                  手动添加
                </button>
              </div>
              <input ref={skillInputRef} className="chat-roles-file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple onChange={(event) => void addSkillFiles(event)} />
            </header>

            {roleDraft.skills.length === 0 ? <p className="chat-roles-empty">可上传 .md / .txt，或直接手动填写。</p> : (
              <div className="chat-role-skill-list">
                {roleDraft.skills.map((skill, index) => (
                  <article className="chat-role-skill-row" key={skill.id}>
                    <div>
                      <strong>{skill.name}</strong>
                      <span>{skill.content.length.toLocaleString()} 字符</span>
                    </div>
                    <button type="button" className="chat-roles-text-button" onClick={() => beginEditSkill(index)}>查看/编辑</button>
                    <button type="button" className="chat-roles-icon-button" aria-label={`删除 Skill ${skill.name}`} onClick={() => removeSkill(index)}>
                      <TrashIcon />
                    </button>
                  </article>
                ))}
              </div>
            )}

            {editingSkillIndex !== null ? (
              <div className="chat-role-skill-editor">
                <label className="model-config-field">
                  <span className="model-config-field-label">Skill 名称</span>
                  <input className="model-config-input" value={skillName} maxLength={100} onChange={(event) => setSkillName(event.target.value)} />
                </label>
                <label className="model-config-field">
                  <span className="model-config-field-label">Skill 内容</span>
                  <textarea className="chat-role-skill-content" value={skillContent} maxLength={MAX_ROLE_CONTENT} onChange={(event) => setSkillContent(event.target.value)} />
                  <small>{skillContent.length.toLocaleString()} / {MAX_ROLE_CONTENT.toLocaleString()}</small>
                </label>
                <div className="chat-role-editor-actions">
                  <button type="button" className="chat-roles-button" onClick={saveSkillEditor}>保存 Skill</button>
                  <button type="button" className="chat-roles-button is-quiet" onClick={() => setEditingSkillIndex(null)}>取消</button>
                </div>
              </div>
            ) : null}
          </section>
          </div>

          <footer className="chat-role-editor-footer">
            <button type="button" className="chat-roles-button" onClick={() => void saveDraft()} disabled={saving}>
              {saving ? '保存中...' : '保存设置'}
            </button>
            <button type="button" className="chat-roles-button is-quiet" onClick={closeEditor} disabled={saving}>取消</button>
          </footer>
        </div>
      )}
    </section>
  );
}
