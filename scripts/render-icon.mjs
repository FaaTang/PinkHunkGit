import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(root, 'media', 'logo.svg');
const pngPath = join(root, 'media', 'icon.png');

const svg = readFileSync(svgPath, 'utf8');
const resvg = new Resvg(svg, {
  fitTo: { mode: 'width', value: 512 },
  background: 'rgba(0,0,0,0)',
});
writeFileSync(pngPath, resvg.render().asPng());
console.log(`Wrote ${pngPath}`);
