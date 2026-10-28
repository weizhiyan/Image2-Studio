import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatRoleStack, RoleAvatar } from '../src/components/chat/ChatRoleStack';
import { toggleChatRoleSelection } from '../src/lib/chatRoles';
import type { PromptSkill } from '../src/lib/bridge';

function role(overrides: Partial<PromptSkill> = {}): PromptSkill {
  return {
    id: 'role-1',
    name: '创意设计',
    description: '',
    category: '视觉',
    avatarUrl: '/api/files/avatar.png',
    content: '你是创意设计角色。',
    skills: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('对话角色头像堆叠', () => {
  it('没有角色时不渲染通用入口', () => {
    const html = renderToStaticMarkup(
      <ChatRoleStack roles={[]} activeRoleId="" onToggle={() => undefined} />,
    );
    expect(html).toBe('');
  });

  it('渲染头像、名称气泡和选中状态，不出现通用选项', () => {
    const roles = [
      role({ description: '帮助扩展创意' }),
      role({ id: 'role-2', name: '编剧', category: '故事', avatarUrl: '', description: '帮助构建故事' }),
    ];
    const html = renderToStaticMarkup(
      <ChatRoleStack roles={roles} activeRoleId="role-1" onToggle={() => undefined} />,
    );

    expect(html).toContain('aria-label="对话角色"');
    expect(html).toContain('创意设计');
    expect(html).toContain('编剧');
    expect(html).not.toContain('帮助扩展创意');
    expect(html).not.toContain('帮助构建故事');
    expect(html).not.toContain('视觉');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('通用');
  });

  it('超过五个角色时收起其余入口，并保留已选角色的可访问名称', () => {
    const roles = Array.from({ length: 9 }, (_, index) => role({ id: `role-${index + 1}`, name: `角色${index + 1}` }));
    const html = renderToStaticMarkup(
      <ChatRoleStack roles={roles} activeRoleId="role-9" onToggle={() => undefined} />,
    );
    expect(html.match(/<button\b/g)).toHaveLength(5);
    expect(html).toContain('更多角色，另有 5 个，当前角色 角色9');
    expect(html).toContain('aria-expanded="false"');
  });

  it('五个角色以内全部提供直接入口，不额外添加更多按钮', () => {
    const roles = Array.from({ length: 5 }, (_, index) => role({ id: `role-${index + 1}`, name: `角色${index + 1}` }));
    const html = renderToStaticMarkup(
      <ChatRoleStack roles={roles} activeRoleId="role-5" onToggle={() => undefined} />,
    );
    expect(html.match(/<button\b/g)).toHaveLength(5);
    expect(html).toContain('角色5，已选，点击取消');
    expect(html).not.toContain('更多角色');
  });

  it('没有图片时使用完整的首个 Unicode 字符作为头像', () => {
    const html = renderToStaticMarkup(<RoleAvatar role={role({ name: '  🎬导演', avatarUrl: '' })} />);
    expect(html).toContain('<span>🎬</span>');
    expect(html).not.toContain('<img');
  });

  it('角色选择提示与菜单只展示名称，不显示角色简介', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/components/chat/ChatRoleStack.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('tooltipContent?.description');
    expect(source).not.toContain('role.description');
  });

  it('再次点击已选角色时取消选择', () => {
    expect(toggleChatRoleSelection('', 'role-1')).toBe('role-1');
    expect(toggleChatRoleSelection('role-1', 'role-1')).toBe('');
    expect(toggleChatRoleSelection('role-1', 'role-2')).toBe('role-2');
  });

  it('设置页使用卡片与简介，不提供角色启停或分类字段', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/components/ChatRolesSettings.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('role="switch"');
    expect(source).not.toContain('分类（可选）');
    expect(source).toContain('简介（可选）');
    expect(source).toContain('暂无自定义角色');
    expect(source).not.toContain('默认使用通用模式');
  });

  it('悬停展开和气泡都只动画 transform/opacity，并接入减少动态偏好', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../src/components/chat/ChatPanel.css', import.meta.url)),
      'utf8',
    );
    expect(css).toContain('.hb-chat-role-picker:hover .hb-chat-role-stack-button');
    expect(css).toContain('.hb-chat-role-picker:has(:focus-visible)');
    expect(css).toContain('.hb-chat-role-tooltip.is-visible');
    expect(css).toContain('@media (hover: none)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).not.toContain('transition: all');
  });
});
