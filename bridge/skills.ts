import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './paths.js';

const SKILLS_FILE = path.join(DATA_DIR, 'prompt-skills.json');
const MAX_ROLES = 5;
const MAX_ROLE_SKILLS = 9;
const MAX_SKILL_CHARS = 24_000;
const MAX_ROLE_CONTEXT_CHARS = 60_000;

export interface RoleSkill {
  id: string;
  name: string;
  content: string;
}

export interface PromptSkill {
  id: string;
  name: string;
  /** 角色卡片的简要描述。 */
  description: string;
  category: string;
  avatarUrl: string;
  /** 角色的系统提示词。 */
  content: string;
  /** 随角色一起注入的 Skill 文件。 */
  skills: RoleSkill[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRoleSnapshot {
  id: string;
  name: string;
  avatarUrl?: string;
  category?: string;
  systemPrompt: string;
  skills: RoleSkill[];
}

let writeChain: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

async function readFile(): Promise<PromptSkill[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(SKILLS_FILE, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const item = raw as Record<string, unknown>;
      const name = String(item.name || '').trim().slice(0, 100);
      const content = String(item.content || '').trim().slice(0, MAX_SKILL_CHARS);
      const skills = normalizeRoleSkills(item.skills);
      if (!name || (!content && skills.length === 0)) return [];
      const now = new Date().toISOString();
      return [{
        id: String(item.id || `skill_${randomUUID()}`),
        name,
        description: String(item.description || '').trim().slice(0, 400),
        category: String(item.category || '').trim().slice(0, 60),
        avatarUrl: String(item.avatarUrl || '').trim().slice(0, 2048),
        content,
        skills,
        enabled: true,
        createdAt: String(item.createdAt || now),
        updatedAt: String(item.updatedAt || now),
      }];
    }).slice(0, MAX_ROLES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.copyFile(SKILLS_FILE, `${SKILLS_FILE}.corrupt-${stamp}`).catch(() => undefined);
    }
    return [];
  }
}

function normalizeRoleSkills(raw: unknown): RoleSkill[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const name = String(item.name || '').trim().slice(0, 100);
    const content = String(item.content || '').trim().slice(0, MAX_SKILL_CHARS);
    if (!name || !content) return [];
    return [{
      id: String(item.id || `role_skill_${randomUUID()}`),
      name,
      content,
    }];
  }).slice(0, MAX_ROLE_SKILLS);
}

async function writeFile(skills: PromptSkill[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temp = `${SKILLS_FILE}.tmp`;
  await fs.writeFile(temp, JSON.stringify(skills, null, 2), 'utf8');
  await fs.rename(temp, SKILLS_FILE);
}

export async function listPromptSkills(): Promise<PromptSkill[]> {
  return readFile();
}

export async function listEnabledPromptSkills(): Promise<PromptSkill[]> {
  const enabled = (await readFile()).filter((skill) => skill.enabled).slice(0, MAX_ROLES);
  let remaining = MAX_ROLE_CONTEXT_CHARS;
  return enabled.flatMap((skill) => {
    if (remaining <= 0) return [];
    const content = skill.content.slice(0, remaining);
    remaining -= content.length;
    return [{ ...skill, content }];
  });
}

export async function savePromptSkill(input: {
  id?: string;
  name: string;
  description?: string;
  category?: string;
  avatarUrl?: string;
  content?: string;
  skills?: Array<Partial<RoleSkill>>;
  enabled?: boolean;
}): Promise<PromptSkill> {
  const name = String(input.name || '').trim().slice(0, 100);
  const description = String(input.description || '').trim().slice(0, 400);
  const category = String(input.category || '').trim().slice(0, 60);
  const avatarUrl = String(input.avatarUrl || '').trim().slice(0, 2048);
  const content = String(input.content || '').trim();
  if (!name) throw new Error('角色名称不能为空');
  if (content.length > MAX_SKILL_CHARS) throw new Error(`系统提示词不能超过 ${MAX_SKILL_CHARS} 个字符`);
  const roleSkills = normalizeRoleSkills(input.skills || []);
  if (Array.isArray(input.skills) && input.skills.length > MAX_ROLE_SKILLS) {
    throw new Error(`每个角色最多添加 ${MAX_ROLE_SKILLS} 个 Skill`);
  }
  if (!content && roleSkills.length === 0) throw new Error('系统提示词和 Skill 至少填写一项');
  return withWriteLock(async () => {
    const skills = await readFile();
    const existing = skills.find((skill) => skill.id === input.id);
    if (!existing && skills.length >= MAX_ROLES) throw new Error(`最多保存 ${MAX_ROLES} 个角色`);
    if (skills.some((skill) => skill.id !== existing?.id && skill.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error('已存在同名角色');
    }
    const now = new Date().toISOString();
    const skill: PromptSkill = {
      id: existing?.id || `skill_${randomUUID()}`,
      name,
      description,
      category,
      avatarUrl,
      content,
      skills: roleSkills,
      enabled: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const next = existing ? skills.map((item) => item.id === existing.id ? skill : item) : [skill, ...skills];
    await writeFile(next);
    return skill;
  });
}

export async function deletePromptSkill(id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const skills = await readFile();
    const next = skills.filter((skill) => skill.id !== id);
    if (next.length === skills.length) return false;
    await writeFile(next);
    return true;
  });
}

/** 请求里的角色快照不可信：运行时重新限长，避免历史消息或客户端请求无限注入。 */
export function normalizePromptRoleSnapshot(raw: unknown): PromptRoleSnapshot | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || '').trim().slice(0, 160);
  const name = String(item.name || '').trim().slice(0, 100);
  if (!id || !name) return undefined;
  const systemPrompt = String(item.systemPrompt || item.content || '').trim().slice(0, MAX_SKILL_CHARS);
  const skills = normalizeRoleSkills(item.skills);
  if (!systemPrompt && skills.length === 0) return undefined;
  return {
    id,
    name,
    ...(String(item.avatarUrl || '').trim() ? { avatarUrl: String(item.avatarUrl).trim().slice(0, 2048) } : {}),
    ...(String(item.category || '').trim() ? { category: String(item.category).trim().slice(0, 60) } : {}),
    systemPrompt,
    skills,
  };
}

export function promptRoleContext(raw: unknown): string {
  const role = normalizePromptRoleSnapshot(raw);
  if (!role) return '';
  let remaining = MAX_ROLE_CONTEXT_CHARS;
  const systemPrompt = role.systemPrompt.slice(0, remaining);
  remaining -= systemPrompt.length;
  const skills = role.skills.flatMap((skill) => {
    if (remaining <= 0) return [];
    const heading = `## Skill: ${skill.name}\n`;
    const content = skill.content.slice(0, Math.max(0, remaining - heading.length));
    remaining -= heading.length + content.length;
    return content ? [`${heading}${content}`] : [];
  });
  return [
    `\n\n当前对话角色：${role.name}${role.category ? `（${role.category}）` : ''}`,
    '只在本轮应用该角色的系统提示词与随附 Skill；不要假装使用未选择的其他角色。',
    systemPrompt,
    ...skills,
  ].filter(Boolean).join('\n\n');
}
