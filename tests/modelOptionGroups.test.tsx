import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ModelOptionGroups from '../src/components/ModelOptionGroups';

describe('共享模型分组菜单', () => {
  it('标题只显示一次，相同模型保留各自的配置来源和分组名称', () => {
    const options = [
      { key: 'a:one', profileId: 'a', profileName: '公司', model: 'one' },
      { key: 'a:two', profileId: 'a', profileName: '公司', model: 'two' },
      { key: 'b:one', profileId: 'b', profileName: '漫小白', model: 'one' },
    ];
    const html = renderToStaticMarkup(<ModelOptionGroups options={options}>{option => (
      <button key={option.key} role="menuitemradio" aria-checked={option.key === 'b:one'}>{option.model}</button>
    )}</ModelOptionGroups>);
    expect(html.match(/role="group"/g)).toHaveLength(2);
    expect(html.match(/>公司<\/p>/g)).toHaveLength(1);
    expect(html.match(/>漫小白<\/p>/g)).toHaveLength(1);
    expect(html.indexOf('>two</button>')).toBeLessThan(html.indexOf('>漫小白</p>'));
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });
});
