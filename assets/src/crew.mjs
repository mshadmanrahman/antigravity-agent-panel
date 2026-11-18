// Exports every element x persona x mood sprite to assets/crew as a standalone SVG.
// GitHub renders README SVGs through <img>, which cannot see CSS variables,
// so the dark-mode palette from styles.css is baked into each file.
// Run: node assets/src/crew.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '../../sidecars/agent_panel');
const out = join(here, '../crew');

const css = readFileSync(join(app, 'styles.css'), 'utf8');
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'));
const palette = Object.fromEntries(
  [...dark.matchAll(/--(el-[a-z]+-[a-z]+):\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => [m[1], m[2]]),
);

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(join(app, 'characters.js'), 'utf8'), sandbox);
const { renderCharacterSvg, dotsSvg } = sandbox.window.AgentCharacters;

const models = {
  neon: 'Gemini 4 Neon',
  hydrogen: 'Gemini 4 Hydrogen',
  argon: 'Gemini 4 Argon',
  carbon: 'Gemini 4 Carbon',
  flash: 'Gemini 3.8 Flash',
  guest: 'Claude Sonnet',
};
const personas = ['main', 'architect', 'developer', 'reviewer', 'scout', 'browser', 'shipper'];
const moods = ['working', 'done', 'waiting', 'failed'];

const bake = (svg) =>
  svg
    .replace(/var\(--(el-[a-z]+-[a-z]+)\)/g, (_, k) => palette[k] || '#888')
    .replace(/currentColor/g, '#a6a39b')
    .replace(' class="avatar-svg"', ' width="90" height="72" shape-rendering="crispEdges"');

let n = 0;
for (const [el, model] of Object.entries(models)) {
  for (const persona of personas) {
    for (const mood of moods) {
      writeFileSync(join(out, `${el}-${persona}-${mood}.svg`), bake(renderCharacterSvg(model, persona, mood)));
      n++;
    }
  }
}
writeFileSync(join(out, 'dots.svg'), dotsSvg('#a6a39b'));
console.log(`wrote ${n + 1} files to assets/crew`);
