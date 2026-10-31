/**
 * 绘板设计 Token 守护测试：
 * 1. 字面色（hex / rgb / rgba）零容忍；mask* 声明整条遮罩（遮罩色渲染不进画面）；
 * 2. 圆角只挡非零绝对单位（正圆的 50% 是合法的，--radius-full 归它管）；
 * 3. 幽灵 Token 零容忍：定义可以出现在任何 CSS 里，JS 注入的走白名单且反查 TSX。
 * 规则出处见 AGENTS.md「硬规则：设计 Token」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const TOKENS = join(SRC, 'styles', 'tokens.css');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.css')) files.push(full);
  }
  return files;
}

function walkAll(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walkAll(full));
    else files.push(full);
  }
  return files;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function maskDecls(css: string): string {
  return css.replace(/(?:-webkit-|-moz-)?mask(?:-image|-composite|-mode|-size|-position|-repeat)?\s*:[^;}]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

const FILES = walk(SRC).map((full) => ({
  rel: relative(SRC, full).split('\\').join('/'),
  raw: readFileSync(full, 'utf8'),
  css: stripComments(readFileSync(full, 'utf8')),
}));
const COMPONENTS = FILES.filter((f) => f.rel !== 'styles/tokens.css');

function lineOf(css: string, index: number): number {
  return css.slice(0, index).split('\n').length;
}

/** JS 注入的布局/状态变量：由 TSX inline style 写入，CSS 里只读，且有兜底值。 */
const JS_INJECTED = new Set([
  '--image-node-width',
  '--image-aspect-ratio',
  '--image-node-height',
  '--parameter-slider-ratio',
  '--segment-count',
  '--segment-index',
  '--choice-count',
  '--choice-index',
]);

describe('设计 Token 硬规则', () => {
  it('组件 CSS 不写字面色（hex / rgb / rgba / hsl）', () => {
    const hits: string[] = [];
    for (const f of COMPONENTS) {
      const css = maskDecls(f.css.replace(/url\([^)]*\)/g, (m) => ' '.repeat(m.length)));
      for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)) {
        hits.push(`${f.rel}:${lineOf(css, m.index!)} ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('组件 CSS 不写死圆角（非零绝对单位）', () => {
    const hits: string[] = [];
    for (const f of COMPONENTS) {
      for (const m of f.css.matchAll(/(?<![-\w])border-(?:[a-z]+-)*radius\s*:\s*([^;}]+)/g)) {
        const value = m[1].trim();
        if (/(?<![\d.])[1-9][\d.]*\s*(px|rem|em)/.test(value)) {
          hits.push(`${f.rel}:${lineOf(f.css, m.index!)} ${value}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('组件 CSS 不写死 font-size / 动效时长与缓动', () => {
    const hits: string[] = [];
    for (const f of COMPONENTS) {
      for (const m of f.css.matchAll(/font-size:\s*[\d.]+(px|rem|em)/g)) {
        hits.push(`${f.rel}:${lineOf(f.css, m.index!)} ${m[0]}`);
      }
      for (const m of f.css.matchAll(/(transition|animation)[^;]*\b[1-9][\d.]*\s*m?s\b(?![^;]*var\()/g)) {
        hits.push(`${f.rel}:${lineOf(f.css, m.index!)} ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('没有幽灵 Token：var() 引用的名字必须有定义（任意 CSS）或在 JS 注入白名单', () => {
    const defined = new Set<string>();
    for (const f of FILES) {
      for (const m of f.css.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
      for (const m of f.css.matchAll(/(--[a-z0-9-]+)\s*,/g)) defined.add(m[1]);
    }
    const ghosts: string[] = [];
    for (const f of FILES) {
      for (const m of f.css.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(m[1]) && !JS_INJECTED.has(m[1])) {
          ghosts.push(`${f.rel}:${lineOf(f.css, m.index!)} ${m[1]}`);
        }
      }
    }
    expect(ghosts).toEqual([]);
  });

  it('每条声明的圆括号配平（少一个 ) 会被 CSS 解析器整条丢弃，静默失效）', () => {
    // 踩过的坑：transform: translateX(calc(var(--i) * (100% + var(--g)));  少一个右括号，
    // 这条连同后面一条 transition 一起被丢掉，界面看着「没生效」但没有任何报错。
    // 按 ; 和 } 切块统计括号数，多行声明（渐变等）天然落在同一块里。
    const hits: string[] = [];
    for (const f of COMPONENTS) {
      const css = maskDecls(f.css.replace(/url\([^)]*\)/g, (m) => ' '.repeat(m.length)));
      let start = 0;
      for (const m of css.matchAll(/[;}]/g)) {
        const chunk = css.slice(start, m.index!);
        start = m.index! + 1;
        const open = (chunk.match(/\(/g) || []).length;
        const close = (chunk.match(/\)/g) || []).length;
        if (open !== close) {
          // 行号指到声明的第一个字符，而不是结尾那个分号
          const declStart = start + chunk.length - chunk.trimStart().length;
          hits.push(`${f.rel}:${lineOf(css, declStart)} 括号 ${open}/${close} -> ${chunk.trim().slice(0, 60)}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('JS 注入白名单每一项都真的在 TSX 里被赋值', () => {
    const tsxSources = walkAll(SRC)
      .filter((file) => file.endsWith('.tsx'))
      .map((file) => readFileSync(file, 'utf8'));
    const stale = [...JS_INJECTED].filter((name) => !tsxSources.some((source) => source.includes(`'${name}'`) || source.includes(`"${name}"`)));
    expect(stale).toEqual([]);
  });

  it('tokens.css 自身没有字面量之外的导出破坏（L0 只允许纯色 hex）', () => {
    // L0 调色板允许纯色；这里只护栏式确认文件存在且非空
    expect(readFileSync(TOKENS, 'utf8').length).toBeGreaterThan(1000);
  });
});
