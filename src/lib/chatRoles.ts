import type { PromptSkill } from '@/lib/bridge';
import type { ChatRoleSnapshot } from '@/types';

export const CHAT_ROLES_UPDATED_EVENT = 'huiban:chat-roles-updated';

export function notifyChatRolesUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHAT_ROLES_UPDATED_EVENT));
  }
}

/** 把可编辑角色固化成发送时快照，避免后续改角色影响历史消息与重试。 */
export function chatRoleSnapshotOf(role: PromptSkill): ChatRoleSnapshot {
  return {
    id: role.id,
    name: role.name,
    ...(role.avatarUrl ? { avatarUrl: role.avatarUrl } : {}),
    ...(role.category ? { category: role.category } : {}),
    systemPrompt: role.content,
    skills: role.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      content: skill.content,
    })),
  };
}

export function enabledChatRoles(roles: PromptSkill[]): PromptSkill[] {
  return roles;
}

/** 点击已选角色时取消选择；点击其他角色时直接切换。 */
export function toggleChatRoleSelection(activeRoleId: string, roleId: string): string {
  return activeRoleId === roleId ? '' : roleId;
}
