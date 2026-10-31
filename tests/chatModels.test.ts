import { describe, expect, it } from 'vitest';
import {
  chatImageModelOptions,
  chatTextModelOptions,
  isChatTextModelLocked,
  resolveChatImageSelection,
  resolveChatTextSelection,
} from '@/lib/chatModels';
import type { ChatThread, MediaSettings, ModelProfileView } from '@/types';

const profile = (id: string, overrides: Partial<ModelProfileView> = {}): ModelProfileView => ({
  id,
  name: id,
  baseUrl: 'https://example.invalid',
  model: `${id}-model`,
  defaultSize: '',
  models: [],
  enabledModels: [],
  kind: 'text',
  keyConfigured: true,
  textFormat: 'auto',
  ...overrides,
});

const settings = (profiles: ModelProfileView[], textProfileId = '', activeProfileId = ''): MediaSettings => ({
  profiles,
  textProfileId,
  activeProfileId,
} as unknown as MediaSettings);

const thread = (fields: Partial<ChatThread> = {}): ChatThread => ({
  id: 'thread',
  title: 't',
  createdAt: '',
  updatedAt: '',
  messages: [],
  ...fields,
} as unknown as ChatThread);

describe('对话模型选项', () => {
  it('语言模型按配置 × 已勾选模型展开，语言配置不再有配置级停用', () => {
    const list = chatTextModelOptions(settings([
      profile('a', { enabledModels: ['a-1', 'a-2'] }),
      profile('b', { enabled: false, enabledModels: ['b-1'] }),
      profile('c', { kind: 'image' }),
      profile('d', { enabledModels: [] }),
    ]));

    expect(list.map((item) => item.key)).toEqual(['a:a-1', 'a:a-2', 'b:b-1', 'd:d-model']);
  });

  it('已选模型全部停用时该配置不再提供对话模型', () => {
    const list = chatTextModelOptions(settings([
      profile('a', { selectedModels: ['a-1', 'a-2'], enabledModels: [] }),
      profile('b', { selectedModels: ['b-1'], enabledModels: ['b-1'] }),
    ]));

    expect(list.map((item) => item.key)).toEqual(['b:b-1']);
  });

  it('生图模型同样按配置 × 已勾选模型展开', () => {
    const list = chatImageModelOptions(settings([
      profile('img', { kind: 'image', enabledModels: ['img-1', 'img-2'] }),
      profile('txt'),
    ]));

    expect(list.map((item) => item.key)).toEqual(['img:img-1', 'img:img-2']);
  });

  it('线程开始对话后锁定语言模型', () => {
    expect(isChatTextModelLocked(thread())).toBe(false);
    expect(isChatTextModelLocked(thread({
      messages: [{ id: 'm1', role: 'user', content: 'x', createdAt: '' }],
    }))).toBe(true);
    expect(isChatTextModelLocked(undefined)).toBe(false);
  });
});

describe('对话模型解析', () => {
  const profiles = [
    profile('a', { enabledModels: ['a-1', 'a-2'] }),
    profile('b', { enabledModels: ['b-1'] }),
    profile('img', { kind: 'image', enabledModels: ['img-1', 'img-2'] }),
  ];

  it('优先使用线程保存的语言模型和具体模型', () => {
    const selected = resolveChatTextSelection(settings(profiles, 'b'), thread({ textProfileId: 'a', textModel: 'a-2' }));
    expect(selected).toMatchObject({ profileId: 'a', model: 'a-2' });
  });

  it('线程没有保存时回落到默认语言模型', () => {
    const selected = resolveChatTextSelection(settings(profiles, 'b'), thread());
    expect(selected).toMatchObject({ profileId: 'b', model: 'b-1' });
  });

  it('线程保存的配置已停用时仍沿用它（锁定线程不悄悄换模型）', () => {
    const disabled = [profile('a', { enabled: false, enabledModels: ['a-1'] }), profile('b')];
    const selected = resolveChatTextSelection(settings(disabled, 'b'), thread({ textProfileId: 'a', textModel: 'a-1' }));
    expect(selected).toMatchObject({ profileId: 'a', model: 'a-1' });
  });

  it('Agent 生图模型优先线程保存，其次默认生图配置', () => {
    expect(resolveChatImageSelection(settings(profiles, '', 'img'), thread({ imageProfileId: 'img', imageModel: 'img-2' })))
      .toMatchObject({ profileId: 'img', model: 'img-2' });
    expect(resolveChatImageSelection(settings(profiles, '', 'img'), thread()))
      .toMatchObject({ profileId: 'img', model: 'img-1' });
  });
});
