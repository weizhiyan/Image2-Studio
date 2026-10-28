import { describe, expect, it } from 'vitest';
import { chatRoleSnapshotOf, enabledChatRoles } from '../src/lib/chatRoles';
import type { PromptSkill } from '../src/lib/bridge';

function role(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 'role-1',
    name: '创意设计',
    description: '旧版简介不应进入快照',
    category: '视觉',
    avatarUrl: '/api/files/avatar.png',
    content: '先拆解目标，再给三个方向。',
    skills: [
      { id: 'skill-1', name: '品牌语气', content: '克制、具体、避免套话。' },
      { id: 'skill-2', name: '输出格式', content: '按方向列出视觉关键词。' },
    ],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('对话角色快照', () => {
  it('固化发送时的头像、分类、系统提示词和 Skill，不携带旧简介', () => {
    const snapshot = chatRoleSnapshotOf(role());
    expect(snapshot).toEqual({
      id: 'role-1',
      name: '创意设计',
      category: '视觉',
      avatarUrl: '/api/files/avatar.png',
      systemPrompt: '先拆解目标，再给三个方向。',
      skills: [
        { id: 'skill-1', name: '品牌语气', content: '克制、具体、避免套话。' },
        { id: 'skill-2', name: '输出格式', content: '按方向列出视觉关键词。' },
      ],
    });
    expect(snapshot).not.toHaveProperty('description');
  });

  it('添加的所有角色都能选择，兼容旧数据中的停用标记', () => {
    const roles = [
      role({ id: 'enabled-a' }),
      role({ id: 'disabled', name: '停用角色', enabled: false }),
      role({ id: 'enabled-b', name: '编剧' }),
    ];
    expect(enabledChatRoles(roles).map((item) => item.id)).toEqual(['enabled-a', 'disabled', 'enabled-b']);
  });
});
