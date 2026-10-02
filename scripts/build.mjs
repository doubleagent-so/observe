// Builds the publishable package into dist/: ESM per entry point, declarations, and a generated package.json.
// Publish with `npm publish ./dist`. In the monorepo the workspace keeps resolving to src/, so nothing needs a build.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

await build({
  entryPoints: {
    index: resolve(root, 'src/index.ts'),
    a2a: resolve(root, 'src/a2a/index.ts'),
    mcp: resolve(root, 'src/mcp/index.ts'),
  },
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  external: ['@a2a-js/sdk', '@a2a-js/sdk/*', '@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  logLevel: 'warning',
});

// typescript exports only package.json, so locate its bin through that.
const tsc = resolve(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');
const declarations = spawnSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.build.json')], { stdio: 'inherit' });
if (declarations.status !== 0) process.exit(declarations.status ?? 1);
// tsc keeps the sources' `./x.ts` specifiers in .d.ts files (in `from`, `import()` and `declare module`); `.js`
// resolves under every TypeScript version and mode.
for (const file of readdirSync(dist, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.d.ts')) continue;
  const path = resolve(dist, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(['"]\.\.?\/[^'"]*)\.ts(['"])/g, '$1.js$2'));
}

const source = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = {
  name: source.name,
  version: source.version,
  description: source.description,
  license: 'MIT',
  type: 'module',
  sideEffects: false,
  engines: { node: '>=20' },
  // ESM only; `default` serves require(esm) and resolvers that know no `import` condition.
  exports: {
    '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
    './a2a': { types: './a2a/index.d.ts', import: './a2a.js', default: './a2a.js' },
    './mcp': { types: './mcp/index.d.ts', import: './mcp.js', default: './mcp.js' },
    './package.json': './package.json',
  },
  peerDependencies: source.peerDependencies,
  peerDependenciesMeta: source.peerDependenciesMeta,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  keywords: source.keywords,
};
writeFileSync(resolve(dist, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) copyFileSync(resolve(root, file), resolve(dist, file));
console.log(`built ${source.name}@${source.version} → dist/`);
