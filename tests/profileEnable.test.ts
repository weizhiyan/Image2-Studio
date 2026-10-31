import { describe, expect, it } from 'vitest';
import {
  isProfileEnabled,
  pickDefaultLanguageProfileId,
  type ProfileEnableLike,
} from '../src/lib/profileEnable';

function image(id: string, enabled?: boolean): ProfileEnableLike {
  return { id, kind: 'image', enabled };
}
function text(id: string, enabled?: boolean): ProfileEnableLike {
  return { id, kind: 'text', enabled };
}

describe('语言模型默认选择', () => {
  it('缺省 enabled 视为启用（老配置没有这个字段）', () => {
    const list = [text('txtA'), text('txtB')];
    expect(list.map(isProfileEnabled)).toEqual([true, true]);
    expect(pickDefaultLanguageProfileId(list)).toBe('txtA');
  });

  it('多路语言模型可以同时启用，默认优先显式指定的 textProfileId', () => {
    const list = [image('imgA'), text('txtA'), text('txtB')];
    expect(list.map(isProfileEnabled)).toEqual([true, true, true]);
    expect(pickDefaultLanguageProfileId(list, 'txtB')).toBe('txtB');
    expect(pickDefaultLanguageProfileId(list)).toBe('txtA');
  });

  it('默认那一路被停用后，回落到第一路仍启用的', () => {
    const list = [text('txtA', false), text('txtB'), text('txtC')];
    expect(pickDefaultLanguageProfileId(list, 'txtA')).toBe('txtB');
  });

  it('全部停用是明确选择：不悄悄打开任何一路', () => {
    const list = [text('txtA', false), text('txtB', false)];
    expect(pickDefaultLanguageProfileId(list)).toBe('');
  });

  it('没有语言模型时返回空串，生图配置不受牵连', () => {
    const list = [image('imgA'), image('imgB')];
    expect(pickDefaultLanguageProfileId(list, 'imgA')).toBe('');
  });
});
