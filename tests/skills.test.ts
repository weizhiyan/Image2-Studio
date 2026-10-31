import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const originalRoot = process.env.HUIBAN_DATA_ROOT;
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huiban-skills-'));
process.env.HUIBAN_DATA_ROOT = testRoot;
const { deletePromptSkill, listEnabledPromptSkills, listPromptSkills, savePromptSkill } = await import('../bridge/skills');

afterAll(async () => {
  if (originalRoot === undefined) delete process.env.HUIBAN_DATA_ROOT;
  else process.env.HUIBAN_DATA_ROOT = originalRoot;
  await fs.rm(testRoot, { recursive: true, force: true });
});

describe('本机对话角色', () => {
  beforeEach(async () => {
    await fs.mkdir(testRoot, { recursive: true });
    await fs.rm(path.join(testRoot, 'prompt-skills.json'), { force: true });
  });

  it('角色字段和 Skill 都持久化，保存后直接可用，可修改与删除', async () => {
    const created = await savePromptSkill({
      name: '视频脚本',
      category: '编剧',
      avatarUrl: '/api/files/avatar.png',
      content: '# 镜头\n按动作写清运镜',
      skills: [{ id: 'skill-1', name: '分镜模板', content: '先列镜头，再写旁白。' }],
    });
    expect(await listEnabledPromptSkills()).toMatchObject([{
      id: created.id,
      name: '视频脚本',
      category: '编剧',
      avatarUrl: '/api/files/avatar.png',
      skills: [{ id: 'skill-1', name: '分镜模板', content: '先列镜头，再写旁白。' }],
    }]);

    const normalized = await savePromptSkill({ ...created, description: '编写分镜脚本', enabled: false });
    expect(normalized.enabled).toBe(true);
    expect(await listEnabledPromptSkills()).toMatchObject([{ id: created.id, description: '编写分镜脚本' }]);

    const updated = await savePromptSkill({ ...normalized, name: '产品视频', content: '# 产品展示' });
    expect(updated).toMatchObject({
      id: created.id,
      name: '产品视频',
      content: '# 产品展示',
      enabled: true,
    });
    expect((await listPromptSkills()).map((role) => role.id)).toEqual([created.id]);
    expect(await deletePromptSkill(created.id)).toBe(true);
    expect(await listPromptSkills()).toEqual([]);
  });

  it('角色温度持久化并限制在 0-1', async () => {
    const created = await savePromptSkill({ name: '温度角色', content: '提示词', temperature: 0.9 });
    expect(created.temperature).toBe(0.9);
    expect((await listPromptSkills()).find((role) => role.id === created.id)?.temperature).toBe(0.9);

    const clamped = await savePromptSkill({ name: '温度上限', content: '提示词', temperature: 5 });
    expect(clamped.temperature).toBe(1);
  });

  it('允许仅用 Skill 组成角色，并限制每个角色最多 9 个 Skill', async () => {
    const skills = Array.from({ length: 9 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index + 1}`,
      content: `规则 ${index + 1}`,
    }));
    const role = await savePromptSkill({ name: '插画助手', content: '', skills });
    expect(role.content).toBe('');
    expect(role.skills).toHaveLength(9);
    await expect(savePromptSkill({
      name: '超限角色',
      content: '系统提示词',
      skills: [...skills, { id: 'skill-10', name: 'Skill 10', content: '规则 10' }],
    })).rejects.toThrow(/最多添加 9 个 Skill/);
  });

  it('最多保存 5 个角色，并拒绝空角色与重名角色', async () => {
    await expect(savePromptSkill({ name: '空角色', content: '', skills: [] }))
      .rejects.toThrow('系统提示词和 Skill 至少填写一项');
    await savePromptSkill({ name: '角色 1', content: '提示词 1' });
    await expect(savePromptSkill({ name: '角色 1', content: '重复名称' }))
      .rejects.toThrow(/同名角色/);
    await fs.rm(path.join(testRoot, 'prompt-skills.json'), { force: true });
    for (let index = 1; index <= 5; index += 1) {
      await savePromptSkill({ name: `角色 ${index}`, content: `提示词 ${index}` });
    }
    await expect(savePromptSkill({ name: '角色 6', content: '第六个' }))
      .rejects.toThrow(/最多保存 5 个角色/);
  });

  it('兼容读取旧角色简介并忽略旧停用标记', async () => {
    await fs.writeFile(path.join(testRoot, 'prompt-skills.json'), JSON.stringify([{
      id: 'legacy-role',
      name: '旧角色',
      description: '旧版简介',
      content: '保留系统提示词',
      enabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]), 'utf8');

    expect(await listPromptSkills()).toMatchObject([{
      id: 'legacy-role',
      name: '旧角色',
      description: '旧版简介',
      category: '',
      avatarUrl: '',
      content: '保留系统提示词',
      skills: [],
      enabled: true,
    }]);
  });
});
