import { describe, expect, it } from 'vitest';
import {
  isProfileEnabled,
  pickSingleLanguageProfileId,
  withSingleLanguageProfile,
  type ProfileEnableLike,
} from '../src/lib/profileEnable';

function image(id: string, enabled?: boolean): ProfileEnableLike {
  return { id, kind: 'image', enabled };
}
function text(id: string, enabled?: boolean): ProfileEnableLike {
  return { id, kind: 'text', enabled };
}

describe('语言模型同时只启用一路', () => {
  it('生图配置多路同时启用不受影响', () => {
    const list = [image('imgA'), image('imgB'), text('txtA')];
    expect(withSingleLanguageProfile(list, 'txtA').map(isProfileEnabled)).toEqual([true, true, true]);
  });

  it('启用新的一路语言模型，其余自动让位', () => {
    const list = [image('imgA'), text('txtA'), text('txtB')];
    // 没被规则碰到的配置保持原样（enabled 缺省即启用），用 isProfileEnabled 读语义
    expect(withSingleLanguageProfile(list, 'txtB').map((item) => [item.id, isProfileEnabled(item)])).toEqual([
      ['imgA', true],
      ['txtA', false],
      ['txtB', true],
    ]);
  });

  it('缺省 enabled 视为启用（老配置没有这个字段）', () => {
    const list = [text('txtA'), text('txtB')];
    expect(withSingleLanguageProfile(list, 'txtA').map(isProfileEnabled)).toEqual([true, false]);
    expect(pickSingleLanguageProfileId(list)).toBe('txtA');
  });

  it('pick 优先显式指定的 textProfileId，其次第一路仍启用的', () => {
    const list = [text('txtA', false), text('txtB'), text('txtC')];
    expect(pickSingleLanguageProfileId(list, 'txtC')).toBe('txtC');
    expect(pickSingleLanguageProfileId(list)).toBe('txtB');
  });

  it('全部停用是明确选择：不悄悄打开任何一路', () => {
    const list = [text('txtA', false), text('txtB', false)];
    expect(pickSingleLanguageProfileId(list)).toBe('');
    expect(withSingleLanguageProfile(list, '').map(isProfileEnabled)).toEqual([false, false]);
  });

  it('没有语言模型时返回空串，生图配置不受牵连', () => {
    const list = [image('imgA'), image('imgB')];
    expect(pickSingleLanguageProfileId(list, 'imgA')).toBe('');
    expect(withSingleLanguageProfile(list, '').map(isProfileEnabled)).toEqual([true, true]);
  });
});
