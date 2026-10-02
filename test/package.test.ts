import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const dist = join(root, 'dist');
// Found through module resolution, so it works in this repo and when it is checked out inside a workspace.
const tsc = resolve(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin/tsc');

/** Every `.d.ts` file under a directory, as paths relative to it. */
function declarations(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.d.ts'));
}

/** A fresh directory with the packed tarball installed, and no `@a2a-js/sdk`. */
function installPacked(): string {
  const dir = mkdtempSync(join(tmpdir(), 'observe-smoke-'));
  execFileSync('npm', ['pack', dist, '--pack-destination', dir], { stdio: 'pipe' });
  const tarball = readFileSync(join(dir, execFileSync('ls', [dir]).toString().trim()));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  writeFileSync(join(dir, 'pkg.tgz'), tarball);
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--offline', './pkg.tgz'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

/** Runs tsc on a project; returns its diagnostics, empty when the project type-checks. */
function typecheck(cwd: string, config: string): string {
  try {
    execFileSync(process.execPath, [tsc, '-p', config], { cwd, stdio: 'pipe' });
    return '';
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    return `${stdout?.toString() ?? ''}${stderr?.toString() ?? ''}`.trim() || String(error);
  }
}

describe('published package', () => {
  let installed: string;

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
    installed = installPacked();
  }, 120_000);

  afterAll(() => {
    if (installed) rmSync(installed, { recursive: true, force: true });
  });

  it('writes a publishable package.json with both entry points and the optional peer', () => {
    const manifest = JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@doubleagent-so/observe',
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      repository: { type: 'git', url: 'git+https://github.com/doubleagent-so/observe.git' },
      homepage: 'https://doubleagent.so/docs/',
      bugs: 'https://github.com/doubleagent-so/observe/issues',
      exports: {
        '.': { types: './index.d.ts', import: './index.js', default: './index.js' },
        './a2a': { types: './a2a/index.d.ts', import: './a2a.js', default: './a2a.js' },
        './mcp': { types: './mcp/index.d.ts', import: './mcp.js', default: './mcp.js' },
      },
      peerDependencies: { '@a2a-js/sdk': '>=1.3 <2', '@modelcontextprotocol/sdk': '>=1.29 <2' },
      peerDependenciesMeta: { '@a2a-js/sdk': { optional: true }, '@modelcontextprotocol/sdk': { optional: true } },
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    for (const file of [
      'index.js',
      'a2a.js',
      'mcp.js',
      'index.d.ts',
      'a2a/index.d.ts',
      'mcp/index.d.ts',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
    ])
      expect(existsSync(join(dist, file)), file).toBe(true);
  });

  it('imports in plain Node without @a2a-js/sdk or @modelcontextprotocol/sdk installed', () => {
    expect(existsSync(join(installed, 'node_modules/@a2a-js'))).toBe(false);
    expect(existsSync(join(installed, 'node_modules/@modelcontextprotocol'))).toBe(false);
    writeFileSync(
      join(installed, 'smoke.mjs'),
      "import { createRecorder } from '@doubleagent-so/observe'; import { withA2ATelemetry } from '@doubleagent-so/observe/a2a'; import { instrumentMcpTransport, mcpOperation, withMcpTelemetry } from '@doubleagent-so/observe/mcp'; console.log(typeof createRecorder, typeof withA2ATelemetry, typeof instrumentMcpTransport, typeof withMcpTelemetry, typeof mcpOperation);",
    );
    expect(execFileSync('node', ['smoke.mjs'], { cwd: installed }).toString().trim()).toBe('function function function function function');
  });

  it('never imports the MCP SDK at runtime or in declarations', () => {
    for (const file of readdirSync(dist).filter((name) => name.endsWith('.js')))
      expect(readFileSync(join(dist, file), 'utf8'), file).not.toContain('@modelcontextprotocol/sdk');
    for (const file of declarations(dist))
      expect(readFileSync(join(dist, file), 'utf8'), file).not.toMatch(
        /(?:from|import\(|<reference types=)\s*['"]@modelcontextprotocol\/sdk/,
      );
  });

  it('builds entry points with exactly the source exports (pinned in exports.test.ts)', async () => {
    const keys = async (path: string) => Object.keys(await import(path)).sort();
    expect(await keys(join(dist, 'index.js'))).toEqual(await keys('../src/index'));
    expect(await keys(join(dist, 'a2a.js'))).toEqual(await keys('../src/a2a/index'));
    expect(await keys(join(dist, 'mcp.js'))).toEqual(await keys('../src/mcp/index'));
  });

  it('loads through require(esm) via the default export condition', () => {
    writeFileSync(
      join(installed, 'smoke.cjs'),
      "const { createRecorder } = require('@doubleagent-so/observe'); const { withA2ATelemetry } = require('@doubleagent-so/observe/a2a'); const { withMcpTelemetry } = require('@doubleagent-so/observe/mcp'); console.log(typeof createRecorder, typeof withA2ATelemetry, typeof withMcpTelemetry);",
    );
    expect(execFileSync('node', ['smoke.cjs'], { cwd: installed, stdio: 'pipe' }).toString().trim()).toBe('function function function');
  });

  it('ships no private references', () => {
    const files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.(?:js|ts|json|md)$/.test(file) || file === 'LICENSE',
    );
    expect(files.length).toBeGreaterThan(0);
    // `localhost` alone is allowed: the recorder names it as the one plain-http endpoint host. A dev URL is not.
    // The public docs site (doubleagent.so/docs/) is allowed; a repository `docs/` path is not.
    for (const file of files)
      expect(readFileSync(join(dist, file), 'utf8'), file).not.toMatch(
        /(?<!doubleagent\.so\/)docs\/|glood|localhost:\d|doubleagent-so\/doubleagent/,
      );
  });

  it('publishes declarations that never import @a2a-js/sdk', () => {
    const files = declarations(dist);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(dist, file), 'utf8');
      expect(text, file).not.toMatch(/(?:from|import\(|<reference types=)\s*['"]@a2a-js\/sdk/);
      // Relative specifiers end in `.js`, which every TypeScript version and module resolution understands.
      expect(text, file).not.toMatch(/['"]\.\.?\/[^'"]*\.ts['"]/);
    }
  });

  it.each(['nodenext', 'bundler'])('type-checks a consumer without @a2a-js/sdk (moduleResolution %s, skipLibCheck off)', (resolution) => {
    writeFileSync(
      join(installed, 'consumer.ts'),
      [
        "import { createRecorder, type Recorder } from '@doubleagent-so/observe';",
        "import { withA2ATelemetry, a2aTelemetryInterceptor, instrumentTaskStore } from '@doubleagent-so/observe/a2a';",
        "const recorder: Recorder = createRecorder({ key: 'key', flushIntervalMs: 0 });",
        'export const handle = withA2ATelemetry(async (request: Request) => new Response(request.url), { recorder, waitUntil: true });',
        'export const interceptor = a2aTelemetryInterceptor({ recorder });',
        'export const store = instrumentTaskStore({ save: async (task: { id: string }) => void task.id, load: async () => undefined, list: async () => [] }, { recorder });',
        'export const abandoned: Promise<void> = store.abandonOpenTasks();',
        "import { instrumentMcpTransport, mcpOperation, withMcpTelemetry, type McpHandlerExtra } from '@doubleagent-so/observe/mcp';",
        'const transport = { async send(_message: unknown): Promise<void> {}, extra: 1 };',
        "export const wrapped: typeof transport = instrumentMcpTransport(transport, { recorder, role: 'server', binding: 'stdio' });",
        'export const mcpHandle = withMcpTelemetry(async (request: Request) => new Response(request.url), { recorder });',
        'const extra: McpHandlerExtra = { requestId: 1 };',
        'export const found: string | undefined = mcpOperation(recorder, extra)?.operationId;',
      ].join('\n'),
    );
    const module = resolution === 'nodenext' ? 'nodenext' : 'esnext';
    writeFileSync(
      join(installed, `tsconfig.${resolution}.json`),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          target: 'es2022',
          module,
          moduleResolution: resolution,
          lib: ['es2022', 'dom'],
          types: [],
        },
        files: ['consumer.ts'],
      }),
    );
    expect(typecheck(installed, `tsconfig.${resolution}.json`)).toBe('');
  });

  it('dry-run publishes only the built files', () => {
    const output = execFileSync('npm', ['publish', '--dry-run', '--json', dist], { stdio: 'pipe' }).toString();
    const files: string[] = JSON.parse(output.slice(output.indexOf('{'))).files.map((file: { path: string }) => file.path);
    expect(files.every((file) => !file.startsWith('src/') && !file.startsWith('test/'))).toBe(true);
    expect(files).toEqual(expect.arrayContaining(['index.js', 'a2a.js', 'mcp.js', 'mcp/index.d.ts', 'package.json']));
  }, 120_000);
});
