/**
 * 配置列表一行里不许出现两个一样的东西。
 * 用户实测反馈"有两个绿色的勾"：启停勾选和"默认/优化模型"标记都渲染成绿色对勾，
 * 一行里并排两个，分不清谁是谁，布局也显得挤。现行设计把两种语义钉死：
 *   启停 = 开关（.model-config-profile-switch，role="switch"）
 *     生图多路各自独立开关；语言模型互斥（开新的让位旧的，逻辑在 toggleDraftEnabled）
 *   删除 = .model-config-profile-delete
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { ProfileRow } = await import('@/components/SettingsPanel');

const noop = () => {};

function renderRow(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ProfileRow
      id="profile_1"
      name="默认模型"
      kind="image"
      model="gpt-image-2.5"
      enabled
      selected={false}
      onSelect={noop}
      onToggleEnabled={noop}
      onDelete={noop}
      {...overrides}
    />,
  );
}

describe('配置列表一行', () => {
  it('生图配置只保留启停开关和删除，不显示默认入口', () => {
    const html = renderRow();
    expect(html).toContain('model-config-profile-switch on');
    expect(html).not.toContain('model-config-profile-set-default');
    expect(html).not.toContain('设为默认');
    expect(html).not.toContain('model-config-profile-default-badge');
    expect(html).toContain('model-config-profile-delete');
    expect(html).toContain('role="switch"');
  });

  it('语言模型行同样用开关：同时只启用一路，不再出现单选圆点或绿色勾', () => {
    const html = renderRow({ kind: 'text', name: '公司GPT', model: 'GPT' });
    expect(html).not.toContain('model-config-profile-check');
    expect(html).not.toContain('model-config-profile-radio');
    expect(html).not.toContain('model-config-profile-set-default');
    expect(html).not.toContain('model-config-profile-default');
    expect(html).toContain('model-config-profile-switch on');
    expect(html).toContain('role="switch"');
  });

  it('停用：整行置灰 + 开关不亮', () => {
    const html = renderRow({ enabled: false });
    expect(html).toContain('model-config-profile-row is-disabled');
    expect(html).not.toContain('model-config-profile-switch on');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('已停用');
  });

  it('删除按钮任何状态都在，不会因为停用就消失', () => {
    expect(renderRow({ enabled: false })).toContain('model-config-profile-delete');
    expect(renderRow({ enabled: true })).toContain('model-config-profile-delete');
  });

  it('停用的语言模型仍显示开关，可启用为当前使用', () => {
    const html = renderRow({ kind: 'text', enabled: false });
    expect(html).toContain('model-config-profile-switch');
    expect(html).not.toContain('model-config-profile-switch on');
    expect(html).not.toContain('model-config-profile-check');
    expect(html).not.toContain('model-config-profile-radio');
  });

  it('选中行带 selected，方便和右侧编辑器对应', () => {
    expect(renderRow({ selected: true })).toContain('model-config-profile-row selected');
    expect(renderRow({ selected: false })).not.toContain('model-config-profile-row selected');
  });

  it('class 里不留空段（拼空串会变成难看的双空格）', () => {
    expect(renderRow({ selected: false, enabled: true })).toContain('<div class="model-config-profile-row">');
    expect(renderRow({ selected: true, enabled: true })).toContain('<div class="model-config-profile-row selected">');
    expect(renderRow({ selected: false, enabled: false })).toContain('<div class="model-config-profile-row is-disabled">');
  });
});
