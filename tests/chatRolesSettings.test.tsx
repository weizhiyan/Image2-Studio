import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SETTINGS_SOURCE = readFileSync(new URL('../src/components/SettingsPanel.tsx', import.meta.url), 'utf8');
const ROLE_SOURCE = readFileSync(new URL('../src/components/ChatRolesSettings.tsx', import.meta.url), 'utf8');
const SETTINGS_CSS = readFileSync(new URL('../src/components/model-config.css', import.meta.url), 'utf8');
const ROLE_CSS = readFileSync(new URL('../src/components/ChatRolesSettings.css', import.meta.url), 'utf8');

describe('AI 对话角色设置页', () => {
  it('偏好档案分类只保留角色管理，不渲染偏好维护操作', () => {
    expect(SETTINGS_SOURCE).toContain('偏好档案');
    expect(SETTINGS_SOURCE).toContain('<ChatRolesSettings onDetailChange={setRoleDetailOpen} />');
    expect(ROLE_SOURCE).toContain('aria-label="AI 对话角色"');
    expect(ROLE_SOURCE).toContain('新建角色');
    expect(SETTINGS_SOURCE).not.toMatch(/注入偏好档案|归纳记录|暂无偏好档案|postPreferenceAction/);
    expect(ROLE_SOURCE).not.toMatch(/偏好档案|归纳记录|清空/);
  });

  it('角色编辑进入独立详情页，并固定返回栏、保存与取消操作', () => {
    expect(SETTINGS_SOURCE).toContain('{!editorOpen && !roleDetailOpen ? (');
    expect(ROLE_SOURCE).toContain('onDetailChange?.(true)');
    expect(ROLE_SOURCE).toContain('onDetailChange?.(false)');
    expect(ROLE_SOURCE).toContain('model-config-detail-head chat-role-detail-head');
    expect(ROLE_SOURCE).toContain('保存设置');
    expect(ROLE_CSS).toMatch(/\.chat-role-editor-scroll\s*\{[^}]*overflow-y:\s*auto/s);
    expect(ROLE_CSS).toMatch(/\.chat-role-editor-footer\s*\{[^}]*flex:\s*none[^}]*border-top:/s);
    expect(SETTINGS_CSS).toMatch(/\.model-config-modal-body\.model-config-roles-panel\s*\{[^}]*overflow:\s*hidden/s);
  });

  it('保留头像选项、自定义上传、系统提示词与 Skill 编辑能力', () => {
    expect(ROLE_SOURCE).toContain('{ROLE_AVATARS.map');
    expect(ROLE_SOURCE).toContain('上传自定义头像');
    expect(ROLE_SOURCE).toContain('系统提示词');
    expect(ROLE_SOURCE).toContain('上传 Skill');
    expect(ROLE_SOURCE).toContain('手动添加');
  });

  it('将当前通用对话策略作为内置只读项展示，不把它当作可编辑角色', () => {
    const HTTP_SOURCE = readFileSync(new URL('../bridge/http.ts', import.meta.url), 'utf8');
    expect(ROLE_SOURCE).toContain('getGeneralChatPrompt()');
    expect(ROLE_SOURCE).toContain('通用模式');
    expect(ROLE_SOURCE).toContain('系统内置 · 只读');
    expect(ROLE_SOURCE).toContain('aria-readonly="true"');
    expect(HTTP_SOURCE).toContain("pathname === '/api/chat/general-prompt'");
    expect(HTTP_SOURCE).toContain('content: buildAgentSystemSpec()');
  });
});
