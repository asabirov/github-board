#!/usr/bin/env node
// Makes colors_and_type.css from the front matter of DESIGN.md and copies it into system.html.
// Usage: node design/build.mjs [--check]
// With --check, it writes nothing and exits 1 when a file is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const START = '/* colors_and_type.css:start */';
const END = '/* colors_and_type.css:end */';

export function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('DESIGN.md has no front matter');
  const groups = { shared: {}, dark: {}, light: {}, accents: {} };
  let section = null;
  let accent = null;
  for (const line of match[1].split('\n')) {
    const top = line.match(/^(\w+):\s*$/);
    if (top) { section = top[1]; accent = null; continue; }
    const sub = line.match(/^ {2}(\w+):\s*$/);
    if (sub && section === 'accents') { accent = sub[1]; groups.accents[accent] = {}; continue; }
    const token = line.match(/^\s+(--[\w-]+): \{ (.*) \}\s*$/);
    if (!token) continue;
    const fields = Object.fromEntries([...token[2].matchAll(/(\w+): "((?:[^"\\]|\\.)*)"/g)].map(([, k, v]) => [k, v]));
    if (!fields.why) throw new Error(`${token[1]} has no reason`);
    const target = section === 'accents' ? groups.accents[accent] : groups[section];
    if (!target) throw new Error(`${token[1]} is outside a known section`);
    target[token[1]] = fields;
  }
  return groups;
}

const block = (selectors, entries) =>
  `${selectors.join(',\n')} {\n${entries.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;

export function toCss({ shared, dark, light, accents }) {
  const pick = (tokens, key) => Object.entries(tokens).map(([name, f]) => [name, f[key]]);
  const { nebula, ...others } = accents;
  const out = [
    '/* Made by design/build.mjs from design/DESIGN.md. Do not edit by hand. */\n',
    block([':root'], pick(shared, 'value')),
    block([':root', ':root[data-theme="dark"]'], [...pick(dark, 'value'), ['color-scheme', 'dark'], ...pick(nebula, 'dark')]),
    block([':root[data-theme="light"]'], [...pick(light, 'value'), ['color-scheme', 'light'], ...pick(nebula, 'light')]),
  ];
  for (const [name, tokens] of Object.entries(others)) {
    out.push(block([`:root[data-accent="${name}"]`, `:root[data-theme="dark"][data-accent="${name}"]`], pick(tokens, 'dark')));
    out.push(block([`:root[data-theme="light"][data-accent="${name}"]`], pick(tokens, 'light')));
  }
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const css = toCss(parseFrontMatter(readFileSync(`${dir}DESIGN.md`, 'utf8')));
  const html = readFileSync(`${dir}system.html`, 'utf8');
  const [head, rest] = html.split(START);
  if (rest === undefined || !rest.includes(END)) throw new Error('system.html has no colors_and_type.css markers');
  const nextHtml = `${head}${START}\n${css}${END}${rest.slice(rest.indexOf(END) + END.length)}`;
  const stale = [
    readFileSync(`${dir}colors_and_type.css`, { encoding: 'utf8', flag: 'a+' }) !== css && 'colors_and_type.css',
    html !== nextHtml && 'system.html',
  ].filter(Boolean);
  if (process.argv.includes('--check')) {
    if (stale.length) { console.error(`out of date: ${stale.join(', ')}. Run node design/build.mjs`); process.exit(1); }
    console.log('design files are up to date');
  } else {
    writeFileSync(`${dir}colors_and_type.css`, css);
    writeFileSync(`${dir}system.html`, nextHtml);
    console.log(`wrote ${stale.join(', ') || 'nothing (up to date)'}`);
  }
}
