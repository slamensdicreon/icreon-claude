#!/usr/bin/env node
/**
 * Compiles src/theme/tokens.json (the Cypher Design System's tokens.json, with the type scale's
 * phone sizes and the boards' card sizes added) into
 * src/theme/tokens.css. The design system's page compiles the same file in the browser but
 * doesn't publish the result, so this script is how the app regenerates it. With one theme it
 * writes exactly the file the handoff shipped; with several it follows the design system's
 * theme contract: `:root, [data-theme="<first>"]` carries the first theme's colors and shadows,
 * and each further theme gets a `[data-theme="<id>"]` block.
 *
 *   node scripts/tokens.mjs [in.json] [out.css]   regenerate (defaults: src/theme/tokens.*)
 *   node scripts/tokens.mjs --check               fail if tokens.css is out of date
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const input = args[0] ?? join(here, '../src/theme/tokens.json');
const output = args[1] ?? join(here, '../src/theme/tokens.css');

const t = JSON.parse(readFileSync(input, 'utf8'));
const themes = (t.color?.themes ?? [{ id: 'light' }]).map((x) => x.id);
const first = themes[0];

/** A token's value in a theme: per-theme objects fall back to the first theme; aliases become var(). */
function valueIn(tok, theme) {
  const v = typeof tok.value === 'string' ? tok.value : (tok.value[theme] ?? tok.value[first]);
  const alias = /^\{(.+)\}$/.exec(v);
  return alias ? `var(--${alias[1]})` : v;
}
const line = (name, value, usage) => `  --${name}: ${value};${usage ? ` /* ${usage} */` : ''}`;
const css = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const colors = t.color?.tokens ?? [];
const shadows = t.shadow?.tokens ?? [];
const fonts = Object.entries(t.type?.families ?? {}).map(([k, v]) => `  --font-${k}: ${v};`);
const spacing = (t.spacing?.tokens ?? []).map((x) => line(x.name, x.value, x.usage));
const radius = (t.radius?.tokens ?? []).map((x) => line(x.name, x.value, x.usage));

const blocks = [];
if (themes.length === 1) {
  blocks.push(
    [
      ':root {',
      ...colors.map((x) => line(x.name, valueIn(x, first), x.usage)),
      ...fonts,
      ...spacing,
      ...radius,
      ...shadows.map((x) => line(x.name, valueIn(x, first), x.usage)),
      '}',
    ].join('\n'),
  );
} else {
  blocks.push(
    [
      `:root, [data-theme="${first}"] {`,
      `  color-scheme: ${first === 'dark' ? 'dark' : 'light'};`,
      ...colors.map((x) => line(x.name, valueIn(x, first), x.usage)),
      ...shadows.map((x) => line(x.name, valueIn(x, first), x.usage)),
      '}',
    ].join('\n'),
  );
  for (const theme of themes.slice(1)) {
    blocks.push(
      [
        `[data-theme="${theme}"] {`,
        `  color-scheme: ${theme === 'dark' ? 'dark' : 'light'};`,
        ...colors.map((x) => line(x.name, valueIn(x, theme))),
        ...shadows.map((x) => line(x.name, valueIn(x, theme))),
        '}',
      ].join('\n'),
    );
  }
  blocks.push([':root {', ...fonts, ...spacing, ...radius, '}'].join('\n'));
}

/*
 * Type sizes in rem (16px = 1rem), so the reader's text-size setting scales them. A style with
 * `minFontSize` is fluid: that size on a narrow screen (type.fluid.from), growing with the viewport
 * to `fontSize` (at type.fluid.to). Every style's size is also a variable, --type-<name>-size, for
 * a module that needs the size without the rest of the style.
 */
const px = (v) => Number(String(v).replace(/px$/, ''));
const rem = (n) => `${+(n / 16).toFixed(4)}rem`;
const fluid = t.type?.fluid ?? { from: '390px', to: '1280px' };
function sizeOf(s) {
  const max = px(s.fontSize);
  if (s.minFontSize === undefined) return rem(max);
  const min = px(s.minFontSize);
  const [lo, hi] = [px(fluid.from), px(fluid.to)];
  const slope = (max - min) / (hi - lo);
  const base = min - slope * lo;
  return `clamp(${rem(min)}, ${rem(base)} + ${+(slope * 100).toFixed(4)}vw, ${rem(max)})`;
}
const styles = (t.type?.groups ?? []).flatMap((g) => g.styles.map((s) => ({ g, s })));
const sizeVars = styles.map(({ s }) => `  --type-${s.name}-size: ${sizeOf(s)};`);
blocks.push([':root {', ...sizeVars, '}'].join('\n'));

const typeClasses = styles.map(({ g, s }) => {
  const props = [
    `font-family: var(--font-${s.family ?? g.family})`,
    `font-size: var(--type-${s.name}-size)`,
  ];
  for (const k of ['lineHeight', 'fontWeight', 'letterSpacing', 'fontStyle']) {
    if (s[k] !== undefined) props.push(`${css(k)}: ${s[k]}`);
  }
  return `.type-${s.name} { ${props.join('; ')}; }`;
});

const out = `/* Cypher — generated from tokens.json in this package (regenerate from the design system's tokens.json when it changes). */
${blocks.join('\n\n')}

/* Type styles: one class per style in tokens.json › type.groups */
${typeClasses.join('\n')}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== out) {
    console.error(`${output} is out of date: run node scripts/tokens.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(output, out);
  console.log(`Wrote ${output}`);
}
