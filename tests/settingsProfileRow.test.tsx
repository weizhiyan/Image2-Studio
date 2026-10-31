/**
 * 配置列表一行里不许出现两个一样的东西。
 * 用户实测反馈"有两个绿色的勾"：启停勾选和"默认/优化模型"标记都渲染成绿色对勾，
 * 一行里并排两个，分不清谁是谁，布局也显得挤。现行设计把两种语义钉死：
 *   启停 = 开关（.model-config-profile-switch，role="switch"）
 *     生图配置和语言模型都可以多路同时启用，开关各自独立
 *   删除 = .model-config-profile-delete
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { ProfileOverviewCard, ProfileRow } = await import('@/components/SettingsPanel');

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

  it('语言配置没有配置级启停开关，只保留删除', () => {
    const html = renderRow({ kind: 'text', name: '公司GPT', model: 'GPT' });
    expect(html).not.toContain('model-config-profile-switch');
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain('model-config-profile-check');
    expect(html).not.toContain('model-config-profile-radio');
    expect(html).toContain('model-config-profile-delete');
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

  it('语言配置即使数据里标记停用也不显示开关（语言配置无配置级启停）', () => {
    const html = renderRow({ kind: 'text', enabled: false });
    expect(html).not.toContain('model-config-profile-switch');
    expect(html).not.toContain('role="switch"');
    expect(html).toContain('model-config-profile-delete');
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

function renderOverviewCard(overrides: Record<string, unknown> = {}): string {
  const draft = {
    id: 'profile_1',
    name: '示例中转站',
    baseUrl: 'https://example.test/v1',
    apiKey: '',
    model: 'model-a',
    defaultSize: '',
    models: ['model-a', 'model-b'],
    enabledModels: ['model-a'],
    kind: 'image',
    textFormat: 'auto',
    imageApiMode: 'images',
    responsesModel: 'gpt-5.5',
    videoApiMode: 'auto',
    videoCustomConfig: {},
    keyConfigured: true,
    enabled: true,
    ...overrides,
  };
  return renderToStaticMarkup(
    <ProfileOverviewCard
      draft={draft as never}
      selected
      canTest
      testing={false}
      saving={false}
      onOpen={noop}
      onToggleModel={noop}
      onTest={noop}
    />,
  );
}

describe('模型配置概览卡片', () => {
  it('显示配置名、已选模型数量、直接测试和模型启停开关', () => {
    const html = renderOverviewCard();
    expect(html).toContain('示例中转站');
    expect(html).toContain('1 个已选模型');
    expect(html).toContain('>测试</button>');
    expect(html).toContain('aria-label="停用模型 model-a"');
    expect(html).not.toContain('model-b');
    expect(html).not.toContain('未启用模型');
    expect(html).toContain('model-config-overview-card is-current');
  });

  it('卡片展示已选模型；停用的模型仍显示，只是开关关闭', () => {
    const html = renderOverviewCard({
      selectedModels: ['model-a', 'model-b'],
      enabledModels: ['model-a'],
    });
    expect(html).toContain('model-a');
    expect(html).toContain('model-b');
    expect(html).toContain('停用模型 model-a');
    expect(html).toContain('启用模型 model-b');
    expect(html).toContain('aria-checked="false"');
  });

  it('卡片显示已停用配置状态，测试中时显示反馈并禁用测试操作', () => {
    const html = renderToStaticMarkup(
      <ProfileOverviewCard
        draft={{
          id: 'profile_1', name: '停用配置', baseUrl: '', apiKey: '', model: 'model-a', defaultSize: '',
          models: ['model-a'], enabledModels: ['model-a'], kind: 'image', textFormat: 'auto', imageApiMode: 'images',
          responsesModel: '', videoApiMode: 'auto', videoCustomConfig: {} as never, keyConfigured: true, enabled: false,
        } as never}
        selected={false}
        canTest
        testing
        saving={false}
        onOpen={noop}
        onToggleModel={noop}
        onTest={noop}
      />,
    );
    expect(html).toContain('配置已停用');
    expect(html).toContain('>测试中...</button>');
    expect(html).toContain('disabled=""');
  });
});
