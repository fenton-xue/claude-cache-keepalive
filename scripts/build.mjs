import { build } from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
if (!watch) rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'node24' };

await build({
  ...common,
  entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts' },
  outdir: 'dist/main',
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});

mkdirSync('dist/renderer', { recursive: true });
if (existsSync('src/renderer/renderer.ts')) {
  await build({
    ...common,
    entryPoints: { renderer: 'src/renderer/renderer.ts' },
    outdir: 'dist/renderer',
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
  });
}
for (const f of ['index.html', 'styles.css']) {
  if (existsSync(`src/renderer/${f}`)) copyFileSync(`src/renderer/${f}`, `dist/renderer/${f}`);
}
