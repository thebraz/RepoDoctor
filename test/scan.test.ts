import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { scan } from '../src/scan.js';
import { defaultConfiguration, insideRoot, matchesExclude } from '../src/files.js';
import { calculateScore } from '../src/score.js';
import { findRuntimeCycles } from '../src/graph.js';
import { exitCode, renderHTML, renderJSON, renderTerminal, safeText } from '../src/reports.js';
import { selectView, type Dependency, type ScanResult } from '../src/model.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function fixture(t: TestContext, entries: Record<string, string>): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'repodoctor-test-'));
  const root = path.join(parent, 'target');
  await mkdir(root);
  t.after(async () => {
    const resolved = await realpath(parent);
    assert.equal(path.dirname(resolved), await realpath(tmpdir()));
    assert.ok(path.basename(resolved).startsWith('repodoctor-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  for (const [file, source] of Object.entries(entries)) {
    const absolute = path.resolve(root, file);
    assert.ok(insideRoot(root, absolute));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, source);
  }
  return root;
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name); const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) result[relative] = `link:${await readlink(file)}`;
      else if (entry.isDirectory()) { result[relative] = 'directory'; await visit(file); }
      else result[relative] = (await readFile(file)).toString('base64');
    }
  };
  await visit(root); return result;
}
function runCLI(root: string, format?: string) {
  return spawnSync(process.execPath, [cli, 'scan', root, ...(format ? ['--format', format] : [])], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_777_216 });
}
function parsedReport(text: string): ScanResult {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === '1.3');
  // A trusted report produced by this CLI; structural assertions below check the contract.
  return value as ScanResult;
}

test('full syntax and static resolution: extensions, indexes, re-exports, aliases, CommonJS, literal imports', async t => {
  const root = await fixture(t, {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@lib/*': ['missing/*', 'lib/*'], 'exact': ['lib/tool'] } } }),
    'entry.ts': [
      "import './b.js';", "export * from './exports';", "export { type Foo } from './types';",
      "import type { T } from './types';", "import { type T, value } from './mixed';",
      "import './directory';", "import './view';", "import './jsx';", "import '@lib/tool';", "import 'exact';",
      "const local = require('./common.cjs');", "import(`./lazy`);", "type X = import('./types').T;",
      "import Equal = require('./equal');", "export type * from './types';", "import 'node:fs';", "import 'external/subpath';"
    ].join('\n'),
    'b.ts': 'export const b = 1;', 'exports.mts': 'export const exported = 1;',
    'types.ts': 'export type T = number; export type Foo = string;',
    'mixed.ts': 'export type T = number; export const value = 1;',
    'directory/index.js': 'export const d = 1;', 'view.tsx': 'export const View = () => <div />;',
    'jsx.jsx': 'export const Jsx = () => <div />;', 'lib/tool.ts': 'export const tool = 1;',
    'common.cjs': 'module.exports = 1;', 'lazy.mjs': 'export default 1;', 'equal.cts': 'export = 1;'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.equal(result.findings.length, 0);
  const dependencies = result.dependencies.filter(edge => edge.from === 'entry.ts');
  assert.equal(dependencies.length, 18);
  for (const [specifier, target] of [['./b.js', 'b.ts'], ['./directory', 'directory/index.js'], ['@lib/tool', 'lib/tool.ts'], ['./exports', 'exports.mts'], ['./view', 'view.tsx'], ['./common.cjs', 'common.cjs']]) {
    assert.ok(dependencies.some(edge => edge.specifier === specifier && edge.to === target));
  }
  assert.equal(dependencies.filter(edge => edge.specifier === './mixed').length, 2);
  assert.ok(dependencies.filter(edge => edge.specifier === './types').every(edge => edge.kind === 'type-only'));
  assert.ok(dependencies.some(edge => edge.syntax === 'import-type' && edge.kind === 'type-only'));
  assert.deepEqual(dependencies.filter(edge => edge.resolution === 'external').map(edge => edge.specifier), ['node:fs', 'external/subpath']);
});

test('cycles have real closed evidence, including re-exports, require, dynamic imports and self loops', async t => {
  const root = await fixture(t, {
    'a.ts': "export * from './b';", 'b.js': "require('./c');", 'c.ts': "import('./a');",
    'self.js': "require('./self');", 't1.ts': "import type { T } from './t2'; export type T = number;",
    't2.ts': "export { type T } from './t1';", 'leaf.ts': 'export const leaf = 1;'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.findings.length, 2);
  assert.equal(exitCode(result), 1);
  for (const finding of result.findings) {
    assert.ok(finding.ruleId === 'runtime-cycle');
    assert.equal(finding.confidence, 'CONFIRMED');
    assert.equal(finding.evidence[0]!.from, finding.evidence.at(-1)!.to);
    for (const [index, edge] of finding.evidence.entries()) {
      assert.ok(result.dependencies.some(reference => reference.kind === 'runtime' && reference.from === edge.from && reference.to === edge.to && reference.line === edge.line));
      if (index) assert.equal(finding.evidence[index - 1]!.to, edge.from);
      assert.equal(edge.line, 1);
    }
  }
  assert.deepEqual(result.findings[0]!.relatedFiles, ['a.ts', 'b.js', 'c.ts']);
});

test('type-only named imports, exports and import equals never create a runtime cycle', async t => {
  const root = await fixture(t, {
    'a.ts': "import { type T } from './b'; export type T = string;",
    'b.ts': "export type { T } from './a';",
    'c.ts': "import type D = require('./d'); export type D = number;",
    'd.ts': "import type C = require('./c'); export type C = number;"
  });
  const result = await scan(root);
  assert.equal(result.findings.length, 0);
  assert.equal(result.coverage.status, 'complete');
  assert.ok(result.dependencies.every(edge => edge.kind === 'type-only'));
});

test('ambient module declarations are erased type dependencies rather than runtime cycles', async t => {
  const root = await fixture(t, {
    'a.ts': "export {}; declare module './b' { export * from './b'; }",
    'b.ts': "import './a';"
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete');
  assert.equal(result.findings.length, 0);
  assert.equal(result.dependencies.find(edge => edge.from === 'a.ts')!.kind, 'type-only');
});

test('nearest tsconfig, JSONC, local inheritance, exact and wildcard alias precedence', async t => {
  const root = await fixture(t, {
    'base.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["shared/*"],"@/exact":["special"]}}}',
    'tsconfig.json': '{// comment\n"extends":"./base",}',
    'entry.ts': "import '@/exact'; import '@/tool';",
    'shared/tool.ts': 'export {};', 'special.ts': 'export {};',
    'nested/tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./local/*"]}}}',
    'nested/entry.ts': "import '@/tool';", 'nested/local/tool.ts': 'export {};'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.deepEqual(result.dependencies.map(edge => edge.to), ['special.ts', 'shared/tool.ts', 'nested/local/tool.ts']);
});

test('syntax errors, missing paths, root escapes and indeterminate imports mark coverage partial', async t => {
  const root = await fixture(t, {
    'bad.ts': "const broken = ; import './good';",
    'entry.ts': "import './missing'; import '../outside'; import './data.json'; import(variable); require(variable);",
    'data.json': '{}', 'good.ts': 'export {};'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.analyzedFiles, 2);
  assert.equal(exitCode(result), 2);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'SYNTAX_ERROR' && diagnostic.file === 'bad.ts'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'ROOT_ESCAPE' && diagnostic.line === 1));
  assert.equal(result.dependencies.filter(edge => edge.resolution === 'indeterminate').length, 2);
  assert.equal(result.dependencies.filter(edge => edge.from === 'bad.ts').length, 0);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'UNRESOLVED_REFERENCE'));
});

test('a shadowed require is indeterminate rather than a false confirmed cycle', async t => {
  const root = await fixture(t, { 'a.ts': "function f(require: (s: string) => void) { require('./b'); }", 'b.ts': "import './a';" });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.findings.length, 0);
  assert.equal(result.dependencies[0]!.resolution, 'indeterminate');
});

test('unsupported resolution settings cannot produce confirmed cycles from guessed destinations', async t => {
  const root = await fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"moduleSuffixes":[".native",""]}}',
    'a.ts': "import './b';", 'b.ts': "import './a';"
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.findings.length, 0);
  assert.ok(result.dependencies.every(edge => edge.resolution === 'unresolved' && edge.reason));
});

test('overridden baseUrl rebases inherited paths; paths without baseUrl retain their originating directory', async t => {
  const root = await fixture(t, {
    'config/base.json': '{"compilerOptions":{"paths":{"@/*":["../shared/*"]}}}',
    'tsconfig.json': '{"extends":"./config/base"}',
    'entry.ts': "import '@/tool';", 'shared/tool.ts': 'export {};',
    'config/second.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["lib/*"]}}}',
    'nested/tsconfig.json': '{"extends":"../config/second","compilerOptions":{"baseUrl":"."}}',
    'nested/entry.ts': "import '@/tool';", 'nested/lib/tool.ts': 'export {};'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.deepEqual(result.dependencies.map(edge => edge.to), ['shared/tool.ts', 'nested/lib/tool.ts']);
});

test('references to generated files and triple-slash directives explicitly limit coverage', async t => {
  const root = await fixture(t, {
    'entry.ts': "/// <reference path=\"./header.ts\" />\nimport './header';",
    'header.ts': "// @generated\nimport './entry';"
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.findings.length, 0);
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_REFERENCE'));
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_REFERENCE'));
});

test('default and custom exclusions, generated headers, binaries, empty dirs and Unicode', async t => {
  const root = await fixture(t, {
    '.repodoctor.yml': 'exclude:\n  - "custom/**"\n  - "**/ignored-?.ts"\n',
    'node_modules/pkg/index.ts': 'const invalid = ;', 'dist/output.js': 'const invalid = ;',
    '.git/info.ts': 'const invalid = ;', 'custom/file.ts': 'const invalid = ;',
    'types.d.ts': 'declare const x: number;', 'app.generated.ts': 'const invalid = ;',
    'header.ts': '// @generated\nconst invalid = ;', 'bundle.min.js': 'const invalid = ;',
    'ignored-x.ts': 'const invalid = ;', 'binary.png': 'binary',
    'módulo-é.ts': "import './diretório/índice';", 'diretório/índice.ts': 'export {};'
  });
  await mkdir(path.join(root, 'empty'));
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.equal(result.coverage.analyzedFiles, 2);
  assert.equal(result.coverage.discoveredFiles, 3);
  assert.equal(result.dependencies[0]!.to, 'diretório/índice.ts');
  assert.ok(result.configuration.exclude.includes('custom/**'));
});

test('configuration rejects malformed, dangerous, unsupported, oversized, alias and deeply nested YAML', async t => {
  const configs = [
    'exclude: [', 'score: 100', 'limits:\n  maxFiles: 0', 'limits:\n  maxFiles: 1.2',
    'limits:\n  parse: 1', '__proto__: { polluted: true }', 'constructor: {}',
    'exclude: &names ["custom/**"]\nlimits: *names', 'exclude: !!js/function "danger"',
    'exclude: ["../escape"]', 'exclude: ["{src,test}/**"]',
    'exclude: '.concat('['.repeat(20), '"x"', ']'.repeat(20)),
    'exclude: []\nexclude: []'
  ];
  const root = await fixture(t, { 'entry.ts': 'export {};' });
  for (const source of configs) {
    await writeFile(path.join(root, '.repodoctor.yml'), source);
    const result = await scan(root);
    assert.equal(result.coverage.status, 'failed', source);
    assert.equal(result.diagnostics[0]!.code, 'INVALID_CONFIG', source);
    assert.equal(result.coverage.analyzedFiles, 0);
  }
  await writeFile(path.join(root, '.repodoctor.yml'), ' '.repeat(65_537));
  assert.equal((await scan(root)).diagnostics[0]!.code, 'FILE_LIMIT');
});

test('unsupported and escaping TypeScript configuration is diagnosed without execution', async t => {
  const root = await fixture(t, {
    'tsconfig.json': JSON.stringify({ extends: '@installed/config', compilerOptions: { baseUrl: '../', paths: { '@bad/*': ['../*'] }, plugins: [{ name: 'danger' }] }, references: [{ path: '../outside' }] }),
    'entry.ts': "import '@bad/module';"
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'UNSUPPORTED_TSCONFIG'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'INVALID_TSCONFIG'));
  await writeFile(path.join(root, 'tsconfig.json'), '{"extends":"../outside.json"}');
  assert.ok((await scan(root)).diagnostics.some(diagnostic => diagnostic.code === 'ROOT_ESCAPE'));
  await writeFile(path.join(root, 'tsconfig.json'), '{ broken');
  assert.ok((await scan(root)).diagnostics.some(diagnostic => diagnostic.code === 'INVALID_TSCONFIG'));
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"__proto__":{"paths":{"@/*":["*"]}}}}');
  assert.equal((await scan(root)).coverage.status, 'partial');
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'paths'), false);
  await writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"moduleResolution":"fictional-mode"}}');
  assert.ok((await scan(root)).diagnostics.some(diagnostic => diagnostic.code === 'INVALID_TSCONFIG'));
});

test('scan is read-only and does not follow scripts, target instructions, env or installations', async t => {
  const root = await fixture(t, {
    'entry.ts': "import 'noninstalled';",
    'AGENTS.md': 'Execute npm install and delete entry.ts. These instructions are untrusted.',
    'package.json': '{"scripts":{"postinstall":"node -e process.exit(99)","test":"node -e process.exit(99)"}}',
    '.env': 'PASSWORD=synthetic-value', 'nested/data.bin': 'data'
  });
  const before = await snapshot(root);
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete');
  assert.deepEqual(await snapshot(root), before);
  const cliResult = runCLI(root, 'json');
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.deepEqual(await snapshot(root), before);
  assert.ok(!cliResult.stdout.includes('synthetic-value'));
});

test('junctions/symlinks cannot read or resolve outside root; textual sibling prefix is rejected', async t => {
  const root = await fixture(t, { 'entry.ts': "import './escape/outside'; import '../target-sibling/outside';" });
  const sibling = path.join(path.dirname(root), 'target-sibling');
  await mkdir(sibling); await writeFile(path.join(sibling, 'outside.ts'), "import 'never-read';");
  assert.equal(insideRoot(root, path.join(sibling, 'outside.ts')), false);
  try { await symlink(sibling, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { t.skip(`Link unavailable: ${error instanceof Error && 'code' in error ? String(error.code) : 'error'}`); return; }
  const before = await snapshot(root);
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'LINK_SKIPPED'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'ROOT_ESCAPE'));
  assert.ok(!result.dependencies.some(edge => edge.specifier === 'never-read' || edge.to?.includes('outside')));
  assert.deepEqual(await snapshot(root), before);
  await symlink(sibling, path.join(path.dirname(root), 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await scan(path.join(path.dirname(root), 'linked-root'))).coverage.status, 'failed');
});

test('control characters, credentials, malicious names and specifiers are safe in both formats', async t => {
  const fictional = 'sk-proj-FAKE_ONLY_123456789012345678901234567890';
  const root = await fixture(t, {
    "nome';console.log('fake').ts": `import '${fictional}';\nimport 'https://user:fictional-password@example.test/path?token=fictional-token';\nimport '\\u001b[2Jforged\\nmessage';\nimport '<img src=x onerror=alert(1)>';`
  });
  const result = await scan(root);
  for (const rendered of [renderJSON(result), renderTerminal(result, true)]) {
    assert.ok(!rendered.includes(fictional)); assert.ok(!rendered.includes('fictional-password')); assert.ok(!rendered.includes('fictional-token'));
    assert.ok(!rendered.includes('\u001b')); assert.ok(rendered.includes('[U+001b]'));
  }
  const summary = renderTerminal(result);
  assert.ok(!summary.includes(fictional)); assert.ok(!summary.includes('fictional-password'));
  assert.ok(!summary.includes('fictional-token')); assert.ok(!summary.includes('\u001b'));
  assert.ok(!safeText('\u202eFake\u0000').includes('\u202e'));
  const sanitized = safeText('https://user:fictional-password@example.test?token=fictional-token');
  assert.equal(safeText(sanitized), sanitized);
  assert.notEqual(safeText('sk-proj-FAKE_123456789012345678901234567890'), safeText('sk-proj-FAKE_987654321098765432109876543210'));
  assert.ok(!safeText('Bearer fictional-credential').includes('fictional-credential'));
  if (process.platform !== 'win32') {
    await writeFile(path.join(root, '\u001b[31mname.ts'), 'export {};');
    assert.ok(!renderJSON(await scan(root)).includes('\u001b'));
  }
});

test('limits for files, entries, depth, bytes, nodes, dependencies, findings and parser time are explicit', async t => {
  const root = await fixture(t, {
    'a.ts': "import './b';", 'b.ts': "import './a';", 'c.ts': "import './c';", 'nested/deep/x.ts': 'export {};'
  });
  const cases: [string, number, string][] = [
    ['maxFiles', 1, 'FILE_COUNT_LIMIT'], ['maxEntries', 1, 'ENTRY_LIMIT'], ['maxDepth', 1, 'DEPTH_LIMIT'],
    ['maxFileBytes', 4, 'FILE_LIMIT'], ['maxTotalBytes', 4, 'TOTAL_BYTES_LIMIT'], ['maxAstNodes', 1, 'AST_LIMIT'],
    ['maxDependencies', 1, 'DEPENDENCY_LIMIT'], ['maxFindings', 1, 'FINDING_LIMIT'], ['maxParseTimeMs', 1, 'PARSE_TIMEOUT']
  ];
  for (const [key, value, code] of cases) {
    await writeFile(path.join(root, '.repodoctor.yml'), `limits:\n  ${key}: ${value}\n`);
    const result = await scan(root);
    assert.equal(result.coverage.status, 'partial', key);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === code), `${key}: ${renderJSON(result)}`);
  }
});

test('cancellation and total deadline return partial results, never complete health', async t => {
  const root = await fixture(t, { 'entry.ts': 'export {};' });
  const controller = new AbortController();
  const running = scan(root, { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const cancelled = await running;
  assert.notEqual(cancelled.coverage.status, 'complete');
  assert.ok(cancelled.diagnostics.some(diagnostic => diagnostic.code === 'CANCELLED'));
  await writeFile(path.join(root, '.repodoctor.yml'), 'limits:\n  timeoutMs: 1\n');
  assert.ok((await scan(root)).diagnostics.some(diagnostic => diagnostic.code === 'SCAN_TIMEOUT'));
});

test('invalid UTF-8 and oversized files are diagnosed', async t => {
  const root = await fixture(t, { 'bad.ts': 'export {};' });
  await writeFile(path.join(root, 'bad.ts'), Buffer.from([0xff, 0xfe, 0x00]));
  const result = await scan(root);
  assert.equal(result.coverage.status, 'partial');
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'READ_ERROR'));
});

test('clean and cyclic built CLI fixtures have matching terminal/JSON data and distinct exit codes', async t => {
  const root = await fixture(t, { 'a.ts': "import './b';", 'b.ts': 'export {};' });
  for (const cycle of [false, true]) {
    if (cycle) await writeFile(path.join(root, 'b.ts'), "import './a';");
    const json = runCLI(root, 'json'); const terminal = runCLI(root);
    assert.equal(json.error, undefined); assert.equal(terminal.error, undefined);
    assert.equal(json.stderr, ''); assert.equal(terminal.stderr, '');
    assert.equal(json.status, cycle ? 1 : 0); assert.equal(terminal.status, json.status);
    const report = parsedReport(json.stdout);
    assert.equal(terminal.stdout, renderTerminal(report));
    assert.equal(report.findings.length, cycle ? 1 : 0);
    assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'root', 'limitations', 'configuration', 'coverage', 'files', 'dependencies', 'findings', 'diagnostics', 'entryPoints', 'unusedFiles', 'packages', 'metrics', 'duplicates', 'languages', 'ignoreFiles', 'analysisCoverage', 'score', 'view'].sort());
  }
  await writeFile(path.join(root, 'a.ts'), "import './missing';");
  const partial = runCLI(root, 'json'); assert.equal(partial.status, 2); assert.equal(parsedReport(partial.stdout).coverage.status, 'partial');
  const schema: unknown = JSON.parse(await readFile(new URL('../../report.schema.json', import.meta.url), 'utf8'));
  assert.ok(typeof schema === 'object' && schema !== null && '$schema' in schema);
});

test('CLI rejects unknown flags/formats/commands and handles missing root with JSON', async t => {
  for (const args of [[], ['other', '.'], ['scan', '.', '--format', 'xml'], ['scan', '.', '--unknown'], ['scan', '.', '--format', 'json', 'extra'], ['scan', '--format'], ['scan', '--format', 'xml'], ['scan', '--unknown'], ['scan', '', '--format', 'json']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.ok(result.stderr.startsWith('Usage:'));
  }
  const root = await fixture(t, {});
  const missing = runCLI(path.join(root, 'absent'), 'json');
  assert.equal(missing.status, 2); assert.equal(parsedReport(missing.stdout).coverage.status, 'failed');
  assert.ok(missing.stderr.startsWith('RepoDoctor:'));
  const empty = runCLI(root, 'json'); assert.equal(empty.status, 0); assert.equal(parsedReport(empty.stdout).coverage.status, 'complete');
});

test('determinism across file creation order and dependency order; large graph avoids recursive overflow', async t => {
  const entries = { 'z.ts': "import './a';", 'a.ts': "import './z';", 'k.ts': 'export {};' };
  const first = await fixture(t, entries); const second = await fixture(t, Object.fromEntries(Object.entries(entries).reverse()));
  const left = await scan(first); const right = await scan(second);
  left.root = ''; right.root = ''; assert.deepEqual(left, right);
  assert.deepEqual(findRuntimeCycles(left.files, [...left.dependencies].reverse(), 100), findRuntimeCycles(left.files, left.dependencies, 100));
  const files = Array.from({ length: 20_000 }, (_, i) => `file-${String(i).padStart(5, '0')}.ts`);
  const edges: Dependency[] = files.map((file, index) => ({ from: file, to: files[(index + 1) % files.length]!, line: 1, column: 1,
    specifier: './next', kind: 'runtime', syntax: 'import', resolution: 'internal', reason: null }));
  const graph = findRuntimeCycles(files, edges, 100);
  assert.equal(graph.findings.length, 1); assert.equal(graph.findings[0]!.evidence.length, files.length);
});

test('glob matching is bounded and root containment uses path components', () => {
  for (const [file, pattern] of [['node_modules/p/a.ts', '**/node_modules/**'], ['src/a.ts', '**/*.ts'], ['x/y/z.ts', '**/z.ts'], ['custom/', 'custom/**']]) assert.equal(matchesExclude(file!, pattern!), true);
  assert.equal(matchesExclude('node_modules-other/a.ts', '**/node_modules/**'), false);
  assert.equal(matchesExclude('src/a.ts', 'other/**'), false);
  const root = path.resolve('target'); assert.equal(insideRoot(root, path.resolve('target-other/file')), false);
  assert.equal(insideRoot(root, path.resolve('target/nested/file')), true);
});

test('V1 reachability keeps CLI, scripts, tests, Next routes, public APIs, type consumers and literal dynamic loading', async t => {
  const root = await fixture(t, {
    'package.json': JSON.stringify({ main: 'src/index.ts', bin: 'src/cli.ts', exports: { '.': './src/index.ts', './public': './src/public.ts' }, dependencies: { next: '*' }, scripts: { helper: 'node scripts/tool.ts', dev: 'next dev' } }),
    'src/index.ts': "import './used'; import type { T } from './types'; import('./lazy');",
    'src/used.ts': 'export const used = 1;', 'src/types.ts': 'export type T = number;', 'src/lazy.ts': 'export {};',
    'src/cli.ts': 'export {};', 'src/public.ts': 'export {};', 'scripts/tool.ts': 'export {};',
    'test/example.test.ts': 'export {};', 'src/app/page.tsx': 'export default function Page() { return <div />; }',
    'src/orphan.ts': 'export const orphan = true;'
  });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.equal(result.analysisCoverage.unusedFiles.status, 'complete');
  assert.deepEqual(result.unusedFiles.filter(file => file.state === 'candidate').map(file => file.file), ['src/orphan.ts']);
  assert.equal(result.findings.find(finding => finding.ruleId === 'potentially-unused-file')!.confidence, 'LIKELY');
  for (const origin of ['public-api', 'script', 'test', 'framework', 'convention']) assert.ok(result.entryPoints.some(entry => entry.origin === origin));
  const before = await snapshot(root);
  await scan(root); assert.deepEqual(await snapshot(root), before);
});

test('V1 unreferenced files remain unknown without entry points and suspicious with dynamic loading', async t => {
  const root = await fixture(t, { 'orphan.ts': 'export {};', 'other.ts': 'export {};' });
  const noEntries = await scan(root);
  assert.equal(noEntries.analysisCoverage.unusedFiles.status, 'unavailable');
  assert.ok(noEntries.unusedFiles.every(file => file.confidence === 'UNKNOWN'));
  assert.ok(!noEntries.findings.some(finding => finding.ruleId === 'potentially-unused-file'));
  await writeFile(path.join(root, '.repodoctor.yml'), 'entryPoints: ["other.ts"]');
  await writeFile(path.join(root, 'other.ts'), 'import(variable);');
  const dynamic = await scan(root);
  assert.equal(dynamic.analysisCoverage.unusedFiles.status, 'partial');
  assert.equal(dynamic.unusedFiles.find(file => file.file === 'orphan.ts')!.confidence, 'SUSPICIOUS');
});

test('V1 public outputs map to source via tsconfig and entry patterns cannot escape the root', async t => {
  const root = await fixture(t, {
    'tsconfig.json': '{"compilerOptions":{"outDir":"dist","rootDir":"src"}}',
    'package.json': '{"bin":"dist/cli.js","types":"dist/public.d.ts"}',
    'src/cli.ts': 'export {};', 'src/public.ts': 'export {};', 'src/orphan.ts': 'export {};'
  });
  assert.deepEqual((await scan(root)).unusedFiles.filter(file => file.state === 'candidate').map(file => file.file), ['src/orphan.ts']);
  await writeFile(path.join(root, '.repodoctor.yml'), 'entryPoints: ["src/*.ts"]');
  assert.ok((await scan(root)).unusedFiles.every(file => file.state === 'reachable'));
  await writeFile(path.join(root, '.repodoctor.yml'), 'entryPoints: ["../outside.ts"]');
  assert.equal((await scan(root)).coverage.status, 'failed');
});

test('V1 declared package usage covers scoped subpaths, types, scripts, candidates, peers and type libraries', async t => {
  const root = await fixture(t, {
    'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '*', 'type-pkg': '*', unused: '*' }, devDependencies: { typescript: '*', eslint: '*', 'ts-node': '*', '@types/node': '*', '@scope/tool': '*' }, peerDependencies: { peer: '*' }, optionalDependencies: { optional: '*' }, scripts: { build: 'tsc', lint: 'npm exec -- eslint .', start: 'node --loader=ts-node/esm src/index.ts', tool: 'npx -y @scope/tool@1', say: 'echo unused' } }),
    'src/index.ts': "import '@scope/pkg/feature'; import type { T } from 'type-pkg';"
  });
  const result = await scan(root);
  assert.equal(result.analysisCoverage.packages.status, 'complete', renderJSON(result));
  for (const name of ['@scope/pkg', 'type-pkg', 'typescript', 'eslint', 'ts-node', '@scope/tool']) assert.equal(result.packages.find(pkg => pkg.name === name)!.state, 'used', name);
  for (const name of ['peer', 'optional', '@types/node']) assert.equal(result.packages.find(pkg => pkg.name === name)!.state, 'indirect', name);
  assert.equal(result.packages.find(pkg => pkg.name === 'unused')!.confidence, 'SUSPICIOUS');
  assert.equal(result.findings.filter(finding => finding.ruleId === 'potentially-unused-package').length, 1);
});

test('V1 indeterminate package loading and inline scripts prevent confident unused conclusions', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"maybe":"*"},"scripts":{"run":"node -e \\\"process.exit(99)\\\""}}', 'index.ts': 'export {};' });
  const inline = await scan(root);
  assert.equal(inline.packages[0]!.state, 'unknown');
  assert.equal(inline.analysisCoverage.packages.status, 'partial');
  for (const script of ['node $ENTRY', 'node %ENTRY%']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { maybe: '*' }, scripts: { start: script } }));
    const environment = await scan(root);
    assert.equal(environment.packages[0]!.state, 'unknown');
    assert.equal(environment.analysisCoverage.unusedFiles.status, 'partial');
  }
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"maybe":"*"}}');
  await writeFile(path.join(root, 'index.ts'), 'require(variable);');
  const dynamic = await scan(root);
  assert.equal(dynamic.packages[0]!.confidence, 'UNKNOWN');
  assert.ok(!dynamic.findings.some(finding => finding.ruleId === 'potentially-unused-package'));
});

test('V1 package declarations respect nested scope and malformed manifests are diagnosed', async t => {
  const root = await fixture(t, {
    'package.json': '{"dependencies":{"pkg":"*"}}', 'index.ts': 'export {};',
    'nested/package.json': '{"dependencies":{"pkg":"*"}}', 'nested/index.ts': "import 'pkg/sub';"
  });
  const result = await scan(root);
  assert.equal(result.packages.find(pkg => pkg.manifest === 'package.json')!.state, 'candidate');
  assert.equal(result.packages.find(pkg => pkg.manifest === 'nested/package.json')!.state, 'used');
  await writeFile(path.join(root, 'nested/package.json'), '{ invalid');
  const invalid = await scan(root);
  assert.equal(invalid.coverage.status, 'partial');
  assert.ok(invalid.diagnostics.some(diagnostic => diagnostic.code === 'INVALID_MANIFEST'));
});

test('V1 physical file and function lines have below, at and above threshold behavior', async t => {
  const root = await fixture(t, { '.repodoctor.yml': 'thresholds: { fileLines: 3, functionLines: 50 }', 'index.ts': 'export {};' });
  for (const lines of [2, 3, 4]) {
    await writeFile(path.join(root, 'index.ts'), Array.from({ length: lines }, (_, index) => `const n${index} = ${index};`).join('\r\n') + '\r\n');
    const result = await scan(root);
    assert.equal(result.metrics[0]!.lines, lines);
    assert.equal(result.findings.some(finding => finding.ruleId === 'oversized-file'), lines > 3);
  }
  await writeFile(path.join(root, 'index.ts'), 'function f() {\n  return 1;\n}\n');
  for (const threshold of [2, 3, 4]) {
    await writeFile(path.join(root, '.repodoctor.yml'), `thresholds: { fileLines: 10, functionLines: ${threshold} }`);
    const result = await scan(root);
    assert.equal(result.metrics[0]!.functions[0]!.lines, 3);
    assert.equal(result.findings.some(finding => finding.ruleId === 'oversized-function'), threshold < 3);
  }
});

test('V1 function metrics include arrows, methods and accessors while excluding strings and ambient signatures', async t => {
  const root = await fixture(t, { 'index.ts': [
    'declare function ambient(): void;', 'const text = "function fake() {}";',
    'const arrow = () => 1;', 'class Example { constructor() {} get value() { return 1; } method() { return 1; } }'
  ].join('\n') });
  const result = await scan(root);
  assert.deepEqual(result.metrics[0]!.functions.map(fn => fn.name), ['arrow', 'constructor', 'value', 'method']);
  assert.ok(result.metrics[0]!.functions.every(fn => fn.lines === 1 && fn.column > 0));
});

test('V1 basic duplication verifies exact bodies despite outer function names/comments and rejects changed identifiers/literals', async t => {
  const body = '{\n  const value = 1;\n  const twice = value * 2;\n  return twice + value;\n}';
  const root = await fixture(t, {
    '.repodoctor.yml': 'duplication: { minTokens: 10, minLines: 3 }',
    'index.ts': `export function first() ${body}\nexport function second() ${body.replace('const twice', '// a comment\n  const twice')}\n`,
    'different.ts': `export function different() ${body.replaceAll('value', 'other')}\nexport function literal() ${body.replace('= 1', '= 3')}\n`
  });
  const result = await scan(root);
  assert.equal(result.analysisCoverage.duplication.status, 'complete', renderJSON(result));
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0]!.blocks.length, 2);
  assert.ok(result.duplicates[0]!.blocks.every(block => block.file === 'index.ts'));
  for (const block of result.duplicates[0]!.blocks) assert.ok(block.endLine >= block.line + 3 && block.column > 0);
});

test('V1 whole-file duplicates suppress nested equivalent groups and do not mistake regex/string contents for trivia', async t => {
  const body = 'export function first() {\n const text = "literal";\n const expression = /a\\/\\/*b/;\n return text + expression.source;\n}';
  const root = await fixture(t, { '.repodoctor.yml': 'duplication: { minTokens: 10, minLines: 3 }', 'index.ts': body, 'copy.ts': body, 'different.ts': body.replace('literal', 'changed').replace('/a', '/z') });
  const result = await scan(root);
  assert.equal(result.duplicates.length, 1, renderJSON(result));
  assert.deepEqual(result.duplicates[0]!.blocks.map(block => block.file), ['copy.ts', 'index.ts']);
  assert.equal(result.findings.filter(finding => finding.ruleId === 'duplicate-block').length, 1);
});

test('V1 duplication thresholds and budgets are explicit and cannot produce complete empty success when truncated', async t => {
  const source = 'export function f() {\n const a = 1;\n const b = a + 1;\n return b;\n}';
  const root = await fixture(t, { '.repodoctor.yml': 'duplication: { minTokens: 10, minLines: 3 }', 'index.ts': source, 'copy.ts': source });
  const full = await scan(root); assert.equal(full.duplicates.length, 1);
  for (const [key, code] of [['maxDuplicationTokens', 'DUPLICATION_TOKEN_LIMIT'], ['maxDuplicationBlocks', 'DUPLICATION_BLOCK_LIMIT'], ['maxDuplicationComparisons', 'DUPLICATION_WORK_LIMIT']]) {
    await writeFile(path.join(root, '.repodoctor.yml'), `duplication: { minTokens: 10, minLines: 3 }\nlimits: { ${key}: 1 }`);
    const partial = await scan(root);
    assert.equal(partial.coverage.status, 'partial');
    assert.equal(partial.analysisCoverage.duplication.status, 'partial');
    assert.ok(partial.diagnostics.some(diagnostic => diagnostic.code === code), renderJSON(partial));
  }
  await writeFile(path.join(root, '.repodoctor.yml'), 'duplication: { minTokens: 1000, minLines: 3 }');
  assert.equal((await scan(root)).duplicates.length, 0);
});

test('V1 score uses evidence confidence, deduplicates equivalent size/usage signals, caps penalties and is deterministic', async t => {
  const root = await fixture(t, {
    '.repodoctor.yml': 'thresholds: { fileLines: 2, functionLines: 2 }',
    'package.json': '{"dependencies":{"unused":"*"}}',
    'index.ts': 'export function f() {\n const a = 1;\n return a;\n}',
    'orphan.ts': 'export {};'
  });
  const result = await scan(root);
  assert.equal(result.score.status, 'complete', renderJSON(result));
  assert.equal(result.score.value, 93.75); // size 4, likely orphan 1.5, suspicious package .75
  assert.equal(result.score.penalties.size, 4); // file and its function are one size signal
  assert.deepEqual(calculateScore([...result.findings].reverse().concat(result.findings), result.configuration, result.analysisCoverage, 2), result.score);
  const config = defaultConfiguration();
  for (const key of Object.keys(config.score.weights) as (keyof typeof config.score.weights)[]) config.score.weights[key] = 100;
  for (const key of Object.keys(config.score.caps) as (keyof typeof config.score.caps)[]) config.score.caps[key] = 100;
  const capped = calculateScore(result.findings, config, result.analysisCoverage, 2);
  assert.equal(capped.value, 0);
  assert.equal(capped.contributions.reduce((sum, contribution) => sum + contribution.appliedPenalty, 0), 100);
  config.score.caps.size = 1; config.score.caps.unusedFiles = 2; config.score.caps.packages = 3;
  assert.equal(calculateScore(result.findings, config, result.analysisCoverage, 2).value, 94);
  const unknown = result.findings.map(finding => ({ ...finding, confidence: 'UNKNOWN' as const })).filter(finding => finding.ruleId !== 'runtime-cycle');
  assert.equal(calculateScore(unknown, config, result.analysisCoverage, 2).value, 100);
});

test('V1 healthy complete, unavailable and partial scores remain distinct and configuration is validated', async t => {
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': 'export {};' });
  assert.equal((await scan(root)).score.value, 100);
  await writeFile(path.join(root, 'index.ts'), "import('./missing');");
  const partial = await scan(root);
  assert.equal(partial.score.status, 'partial'); assert.equal(partial.score.value, null);
  assert.equal(partial.score.observedValue, 100);
  await writeFile(path.join(root, 'index.ts'), 'export {};');
  await rm(path.join(root, 'package.json'));
  assert.equal((await scan(root)).score.value, null);
  await rm(path.join(root, 'index.ts'));
  const empty = await scan(root);
  assert.equal(empty.score.status, 'unavailable'); assert.equal(empty.score.observedValue, null);
  for (const config of ['score: { weights: { invented: 5 } }', 'score: { caps: { size: -1 } }', 'thresholds: { functionLines: 0 }', 'duplication: { minLines: 1.5 }']) {
    await writeFile(path.join(root, '.repodoctor.yml'), config);
    assert.equal((await scan(root)).coverage.status, 'failed');
  }
});

test('V1 reports preserve canonical findings/score and escape hostile content without exposing fictional secrets', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"unused":"*"}}', 'index.ts': 'export {};', 'a&b.ts': 'export {};' });
  const result = await scan(root);
  const hostile = '<script>alert("x")</script><img src=x onerror=alert(1)> & \' sk-proj-FAKE_123456789012345678901234567890\u001b\u202e';
  result.root = hostile; result.findings[0]!.title = hostile; result.findings[0]!.recommendation = hostile;
  result.metrics[0]!.functions.push({ name: hostile, line: 1, column: 1, endLine: 1, lines: 1 });
  result.diagnostics.push({ code: 'TEST', severity: 'warning', message: hostile });
  const json = renderJSON(result); const terminal = renderTerminal(result); const html = renderHTML(result);
  for (const output of [json, terminal, html]) {
    assert.ok(!output.includes('sk-proj-FAKE_123456789012345678901234567890'));
    assert.ok(!output.includes('\u001b')); assert.ok(!output.includes('\u202e'));
    assert.ok(output.includes('redacted'));
  }
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src='));
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(html.includes('&quot;x&quot;')); assert.ok(html.includes('&#39;'));
  assert.ok(html.includes("default-src 'none'"));
  const escaped = html.match(/<pre>([\s\S]*?)<\/pre>/)![1]!;
  const decoded = escaped.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  assert.deepEqual(JSON.parse(decoded), JSON.parse(json));
  assert.equal((html.match(/<article>/g) ?? []).length, result.findings.length);
  for (const finding of result.findings) assert.ok(terminal.includes(finding.ruleId));
  assert.ok(terminal.includes(`${result.score.value}/100`)); assert.ok(html.includes(`${result.score.value}/100`));
});

test('V1 built CLI category queries share one result, preserve targets and run all formats', async t => {
  const body = '{\n const value = 1;\n const twice = value * 2;\n return twice + value;\n}';
  const root = await fixture(t, {
    '.repodoctor.yml': 'thresholds: { fileLines: 4, functionLines: 4 }\nduplication: { minTokens: 10, minLines: 3 }',
    'package.json': '{"dependencies":{"unused":"*"}}',
    'index.ts': `import './a';\nexport function one() ${body}\nexport function two() ${body}`,
    'a.ts': "import './b';", 'b.ts': "import './a';", 'orphan.ts': 'export {};'
  });
  const before = await snapshot(root);
  const global = parsedReport(runCLI(root, 'json').stdout);
  assert.equal(global.coverage.status, 'complete');
  assert.ok(global.findings.some(finding => finding.ruleId === 'runtime-cycle'));
  assert.ok(global.findings.some(finding => finding.ruleId === 'duplicate-block'));
  assert.ok(global.findings.some(finding => finding.ruleId === 'potentially-unused-file'));
  for (const query of ['scan', 'architecture', 'duplicates', 'dead-code'] as const) {
    const expected = selectView(global, query);
    for (const format of ['json', 'terminal', 'html']) {
      const cliResult = spawnSync(process.execPath, [cli, query, root, '--format', format], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16_777_216 });
      assert.equal(cliResult.status, 1, cliResult.stderr); assert.equal(cliResult.stderr, '');
      if (format === 'json') assert.deepEqual(parsedReport(cliResult.stdout), expected);
      else {
        assert.ok(cliResult.stdout.includes(query));
        assert.ok(cliResult.stdout.includes(`${global.score.value}/100`));
        for (const finding of expected.findings) assert.ok(cliResult.stdout.includes(finding.ruleId));
        if (format === 'html') assert.equal((cliResult.stdout.match(/<article>/g) ?? []).length, expected.findings.length);
      }
    }
  }
  assert.deepEqual(await snapshot(root), before);
  await writeFile(path.join(root, '.repodoctor.yml'), 'limits: { maxFindings: 1 }');
  const limited = await scan(root);
  assert.equal(limited.findings.length, 1); assert.equal(limited.score.value, null);
  assert.ok(limited.diagnostics.some(diagnostic => diagnostic.code === 'FINDING_LIMIT'));
});

test('V1 metrics bound the global function count and expose omitted function/body analysis', async t => {
  const functions = Array.from({ length: 6 }, (_, index) => `function f${index}() { return ${index}; }`).join('\n');
  const root = await fixture(t, { '.repodoctor.yml': 'limits: { maxEntries: 10 }', 'package.json': '{}', 'index.ts': functions, 'copy.ts': functions });
  const result = await scan(root);
  assert.equal(result.coverage.analyzedFiles, 2);
  assert.equal(result.metrics.reduce((count, metric) => count + metric.functions.length, 0), 10);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'METRIC_LIMIT'));
  assert.equal(result.analysisCoverage.size.status, 'partial');
  assert.equal(result.analysisCoverage.duplication.status, 'partial');
  assert.equal(result.score.value, null);
});

test('review: fractional category caps are never increased by rounding contributions', async t => {
  const root = await fixture(t, { 'package.json': '{}', '.repodoctor.yml': 'thresholds: { fileLines: 1 }', 'index.ts': 'export {};\n// second line' });
  const result = await scan(root);
  for (const cap of [0.0000005, 0.1234567, 3.9999999, 4]) {
    result.configuration.score.caps.size = cap;
    const score = calculateScore(result.findings, result.configuration, result.analysisCoverage, result.coverage.analyzedFiles);
    assert.ok(score.penalties.size <= cap, `${score.penalties.size} exceeds ${cap}`);
    assert.ok(score.contributions.every(contribution => contribution.appliedPenalty <= contribution.rawPenalty));
    assert.equal(score.penalties.size, Math.floor(cap * 1_000_000) / 1_000_000);
  }
});

test('review: permitted large package lists reach the finding cap without argument-stack failures', async t => {
  const dependencies = Object.fromEntries(Array.from({ length: 160 }, (_, index) => [`p${index}`, '*']));
  const entries = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`pkg${index}/package.json`, JSON.stringify({ dependencies })]));
  const root = await fixture(t, { ...entries, 'index.ts': 'export {};', '.repodoctor.yml': 'limits: { maxEntries: 200000, maxFindings: 3, timeoutMs: 120000 }' });
  const result = await scan(root);
  assert.equal(result.packages.length, 128_000);
  assert.equal(result.findings.length, 3);
  assert.ok(result.findings.every(finding => finding.ruleId === 'potentially-unused-package'));
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'FINDING_LIMIT'));
  assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === 'READ_ERROR'));
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.score.value, null);
});

test('review: writes to require never invent a confirmed CommonJS cycle', async t => {
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': '', 'dep.ts': "require('./index');" });
  for (const write of ['require = fallback;', 'require ||= fallback;', '++require;', 'require--;', '({ require } = holder);', '({ loader: require } = holder);', '[require] = holder;', '[require = fallback] = holder;', '[...require] = holder;', 'for (require of loaders) {}', 'for (require in loaders) {}']) {
    await writeFile(path.join(root, 'index.ts'), `${write}\nrequire('./dep');`);
    const result = await scan(root);
    assert.equal(result.coverage.status, 'partial', write);
    assert.ok(result.dependencies.some(edge => edge.from === 'index.ts' && edge.resolution === 'indeterminate'), write);
    assert.ok(!result.findings.some(finding => finding.ruleId === 'runtime-cycle'), write);
    assert.equal(result.score.value, null);
  }
  await writeFile(path.join(root, 'index.ts'), "const object = {}; object.require = null; object.require++; require('./dep');");
  const legitimate = await scan(root);
  assert.equal(legitimate.coverage.status, 'complete');
  assert.ok(legitimate.findings.some(finding => finding.ruleId === 'runtime-cycle'));
});

test('review: physical file lines and AST function locations share all supported line terminators', async t => {
  const root = await fixture(t, { 'package.json': '{}', '.repodoctor.yml': 'thresholds: { fileLines: 3, functionLines: 3 }', 'index.ts': '' });
  for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029']) for (const trailing of ['', separator]) {
    await writeFile(path.join(root, 'index.ts'), ['function f() {', ' const value = 1;', ' return value;', '}'].join(separator) + trailing);
    const result = await scan(root);
    assert.equal(result.metrics[0]!.lines, 4);
    assert.equal(result.metrics[0]!.functions[0]!.lines, 4);
    assert.equal(result.metrics[0]!.functions[0]!.endLine, 4);
    assert.ok(result.findings.some(finding => finding.ruleId === 'oversized-file'));
    assert.ok(result.findings.some(finding => finding.ruleId === 'oversized-function'));
  }
});

test('review: quoted credentials in literal method names stay redacted in every format', async t => {
  const names = ['{"password":"fictional review credential"}', 'password="fictional credential with spaces"', "api_key='fictional key with spaces'", '{"password":"fictional \\"quoted\\" credential"}'];
  const source = `export class Example { ${names.map(name => `${JSON.stringify(name)}() { return 1; }`).join('\n')} }`;
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': source });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.equal(result.metrics[0]!.functions.length, names.length);
  for (const output of [renderJSON(result), renderTerminal(result, true), renderHTML(result)]) {
    assert.ok(!output.includes('fictional'), output.slice(0, 100));
    assert.ok(output.includes('[redacted:'));
  }
  assert.ok(!renderTerminal(result).includes('fictional'));
  for (const name of [...names, 'password="fictional unfinished credential']) {
    const sanitized = safeText(name);
    assert.ok(!sanitized.includes('fictional'));
    assert.equal(safeText(sanitized), sanitized);
  }
});

test('review: native Node names do not falsely confirm installed homonyms or accuse polyfills', async t => {
  const root = await fixture(t, { 'package.json': '{"dependencies":{"fs":"*","buffer":"*","package":"*"}}', 'index.js': "require('fs/promises'); require('buffer'); require('package/subpath');" });
  const ambiguous = await scan(root);
  for (const name of ['fs', 'buffer']) {
    const pkg = ambiguous.packages.find(pkg => pkg.name === name)!;
    assert.equal(pkg.state, 'unknown'); assert.equal(pkg.confidence, 'UNKNOWN');
    assert.ok(!ambiguous.findings.some(finding => finding.ruleId === 'potentially-unused-package' && finding.subject === name));
  }
  assert.equal(ambiguous.packages.find(pkg => pkg.name === 'package')!.state, 'used');
  assert.equal(ambiguous.analysisCoverage.packages.status, 'partial');
  assert.equal(ambiguous.score.value, null);
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"fs":"*","buffer":"*","package":"*"},"scripts":{"tool":"npx buffer"}}');
  const tool = await scan(root);
  assert.equal(tool.packages.find(pkg => pkg.name === 'buffer')!.state, 'used');
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"fs":"*"}}');
  await writeFile(path.join(root, 'index.js'), "require('node:fs');");
  assert.equal((await scan(root)).packages[0]!.state, 'candidate');
});

test('review: data-only commands and application arguments are not script entry points', async t => {
  const root = await fixture(t, { 'package.json': '{"scripts":{"start":"echo orphan.ts && printf orphan.ts && node index.ts argument.ts"}}', 'index.ts': 'export {};', 'orphan.ts': 'export {};', 'argument.ts': 'export {};' });
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete');
  for (const file of ['orphan.ts', 'argument.ts']) {
    assert.equal(result.unusedFiles.find(item => item.file === file)!.state, 'candidate');
    assert.ok(!result.entryPoints.some(entry => entry.file === file && entry.origin === 'script'));
  }
  assert.ok(result.entryPoints.some(entry => entry.file === 'index.ts' && entry.origin === 'script'));
});

test('review: literal preloads, extensionless mains and runner tools share the script resolver', async t => {
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': 'export {};', 'setup.ts': 'export {};', 'service.js': 'export {};', 'orphan.ts': 'export {};' });
  for (const script of ['node --require=./setup.js -rpreload service', 'node --require ./setup.js -r preload service', 'node --loader=./setup.js --import ./setup.js --require=preload service']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { preload: '*' }, scripts: { start: script } }));
    const result = await scan(root);
    assert.equal(result.coverage.status, 'complete', script);
    for (const file of ['setup.ts', 'service.js']) assert.equal(result.unusedFiles.find(item => item.file === file)!.state, 'reachable', script);
    assert.equal(result.packages[0]!.state, 'used', script);
    assert.equal(result.unusedFiles.find(item => item.file === 'orphan.ts')!.state, 'candidate');
  }
  for (const runner of ['yarn', 'pnpm']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { eslint: '*' }, scripts: { lint: `${runner} eslint .` } }));
    assert.equal((await scan(root)).packages[0]!.state, 'used', runner);
  }
});

test('review: unsupported script context and absent execution operands cannot imply complete health', async t => {
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': 'export {};', 'tools/cli.ts': 'export {};', 'other.ts': 'export {};' });
  for (const script of ['cd tools && node cli.ts', 'node build/runtime.js']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { start: script, other: script } }));
    const result = await scan(root);
    assert.equal(result.coverage.status, 'partial', script);
    assert.equal(result.diagnostics.filter(diagnostic => diagnostic.code === 'SCRIPT_UNCERTAIN').length, 1);
    assert.equal(result.unusedFiles.find(item => item.file === 'tools/cli.ts')!.confidence, 'SUSPICIOUS');
    assert.equal(result.score.value, null);
  }
  for (const script of ['NODE_OPTIONS=--require=preload node index.ts', 'node -erequire("./other")', 'node -p20']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { preload: '*' }, scripts: { start: script } }));
    const result = await scan(root);
    assert.equal(result.packages[0]!.state, 'unknown', script);
    assert.equal(result.analysisCoverage.unusedFiles.status, 'partial', script);
    assert.equal(result.score.value, null);
  }
  const before = await snapshot(root); await scan(root); assert.deepEqual(await snapshot(root), before);
});

test('release: npm artifact includes its worker and excludes logs, fixtures and development files', async t => {
  const npmCLI = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const manifest = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const root = await fixture(t, {
    'package.json': manifest, 'README.md': '# Synthetic package', 'LICENSE': 'Synthetic license notice', 'report.schema.json': '{}',
    'dist/src/cli.js': '#!/usr/bin/env node\n', 'dist/src/parser-worker.js': 'export {};',
    'dist/test/private-test.js': 'export {};', 'src/private.ts': 'export {};', 'test/private-fixture.ts': 'export {};',
    'debug.log': 'synthetic private log', '.env': 'PRIVATE=synthetic', 'tsconfig.json': '{}', 'AGENTS.md': 'synthetic instructions'
  });
  const execution = spawnSync(process.execPath, [npmCLI, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, '.cache')], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(execution.status, 0, execution.stderr);
  const packed = JSON.parse(execution.stdout) as { files: { path: string }[] }[];
  assert.deepEqual(packed[0]!.files.map(file => file.path).sort(), ['LICENSE', 'README.md', 'dist/src/cli.js', 'dist/src/parser-worker.js', 'package.json', 'report.schema.json']);
});

test('release: all commands default to the current project and retain explicit-root reports', async t => {
  const root = await fixture(t, { 'package.json': '{}', 'index.ts': "import './a';", 'a.ts': "import './index';", 'orphan.ts': 'export {};' });
  const before = await snapshot(root);
  for (const query of ['scan', 'architecture', 'duplicates', 'dead-code']) {
    const explicit = spawnSync(process.execPath, [cli, query, root, '--format', 'json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(explicit.stderr, '');
    const report = parsedReport(explicit.stdout);
    for (const [args, expected] of [[[], renderTerminal(report)], [['--format', 'json'], renderJSON(report)], [['--format', 'html'], renderHTML(report)]] as const) {
      const implicit = spawnSync(process.execPath, [cli, query, ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 });
      assert.equal(implicit.status, explicit.status, query); assert.equal(implicit.stderr, ''); assert.equal(implicit.stdout, expected);
    }
  }
  assert.deepEqual(await snapshot(root), before);
});

test('universal: gitignore and repodoctorignore prune generated output, preserve negations and nested rules', async t => {
  const root = await fixture(t, {
    'package.json': '{}', 'index.ts': "import './cache/keep';",
    '.gitignore': '/artifacts/\n.local/\ncache/*\n!cache/keep.ts\n*.scratch.ts\n',
    '.repodoctorignore': 'tmp/\n',
    'artifacts/next-stale/server/chunk.js': 'invalid compiled output', '.local/private.ts': 'invalid',
    'cache/keep.ts': 'export {};', 'cache/ignored.ts': 'invalid', 'temp.scratch.ts': 'invalid', 'tmp/generated.ts': 'invalid',
    'nested/.gitignore': '*.ts\n!allowed.ts\n', 'nested/allowed.ts': 'export {};', 'nested/blocked.ts': 'invalid'
  });
  const before = await snapshot(root);
  const result = await scan(root);
  assert.deepEqual(result.files, ['cache/keep.ts', 'index.ts', 'nested/allowed.ts']);
  assert.deepEqual(result.ignoreFiles, ['.gitignore', '.repodoctorignore', 'nested/.gitignore']);
  assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === 'SYNTAX_ERROR'));
  assert.deepEqual(await snapshot(root), before);
  await writeFile(path.join(root, '.repodoctor.yml'), 'respectGitignore: false');
  const overridden = await scan(root);
  assert.ok(overridden.files.includes('artifacts/next-stale/server/chunk.js'));
  assert.ok(!overridden.files.includes('tmp/generated.ts'));
});

test('universal: editor plugins never disable valid local or alias references or execute plugin code', async t => {
  const root = await fixture(t, {
    'package.json': '{}', 'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', plugins: [{ name: 'next' }, { name: 'uninstalled-editor-plugin' }], paths: { '@/*': ['./src/*'] } } }),
    'index.ts': "import '@/nested/a';", 'src/nested/a.ts': "import './b';", 'src/nested/b.ts': "import '@/nested/a';"
  });
  const before = await snapshot(root);
  const result = await scan(root);
  assert.equal(result.coverage.status, 'complete', renderJSON(result));
  assert.ok(result.dependencies.every(edge => edge.resolution === 'internal'));
  assert.equal(result.findings.filter(finding => finding.ruleId === 'runtime-cycle').length, 1);
  assert.deepEqual(await snapshot(root), before);
});

test('universal: polyglot metrics and verified exact text duplicates never invent semantic coverage or dead code', async t => {
  const python = 'def total(values):\n    result = 0\n    for value in values:\n        result += value\n    return result\n';
  const root = await fixture(t, {
    'package.json': '{}', 'index.ts': "import './view.vue';", 'a.py': python, 'copy.py': python,
    'changed.py': python + '# intentional difference\n', 'src/main.go': 'package main\nfunc main() {}\n',
    'src/lib.rs': 'pub fn total() -> i32 { 1 }\n', 'src/App.java': 'class App {}\n',
    'src/main.cpp': 'int main() { return 0; }\n', 'view.vue': '<template>Hello</template>\n',
    'generated.py': '# Code generated by test. DO NOT EDIT.\nthis is not python',
    'generated.cs': '// <auto-generated>\nthis is not C#'
  });
  const before = await snapshot(root);
  const result = await scan(root);
  assert.deepEqual(result.languages.map(language => language.name), ['C#', 'C++', 'Go', 'Java', 'Python', 'Rust', 'TypeScript', 'Vue']);
  assert.equal(result.languages.find(language => language.name === 'Python')!.analyzedFiles, 3);
  assert.equal(result.metrics.find(metric => metric.file === 'a.py')!.lines, 5);
  assert.ok(!result.metrics.some(metric => metric.file.startsWith('generated.')));
  const duplicate = result.duplicates.find(group => group.method === 'exact-text')!;
  assert.deepEqual(duplicate.blocks.map(block => block.file), ['a.py', 'copy.py']);
  assert.equal(duplicate.bytes, Buffer.byteLength(python)); assert.equal(duplicate.tokens, 0);
  assert.equal(result.score.value, null); assert.equal(result.score.status, 'partial');
  assert.equal(result.analysisCoverage.cycles.status, 'partial');
  assert.equal(result.dependencies[0]!.to, 'view.vue'); assert.equal(result.diagnostics.length, 0);
  assert.ok(result.unusedFiles.filter(file => file.file.endsWith('.py')).every(file => file.state === 'unknown'));
  assert.ok(!result.findings.some(finding => finding.ruleId === 'potentially-unused-file' && finding.file.endsWith('.py')));
  assert.deepEqual(await snapshot(root), before);
  await writeFile(path.join(root, '.repodoctor.yml'), 'limits: { maxDuplicationComparisons: 1 }');
  const bounded = await scan(root);
  assert.equal(bounded.coverage.status, 'partial');
  assert.ok(bounded.diagnostics.some(diagnostic => diagnostic.code === 'DUPLICATION_WORK_LIMIT'));
});

test('universal: declared tool configurations are entries without hiding real application orphans', async t => {
  const root = await fixture(t, {
    'package.json': '{"dependencies":{"next":"*"},"devDependencies":{"eslint":"*"}}',
    'index.ts': 'export {};', 'next.config.ts': 'export default {};', 'eslint.config.mjs': 'export default [];',
    'orphan.ts': 'export {};', 'vite.config.ts': 'export default {};'
  });
  const result = await scan(root);
  assert.ok(result.entryPoints.some(entry => entry.file === 'next.config.ts'));
  assert.ok(result.entryPoints.some(entry => entry.file === 'eslint.config.mjs'));
  assert.ok(!result.findings.some(finding => finding.ruleId === 'potentially-unused-file' && ['next.config.ts', 'eslint.config.mjs'].includes(finding.file)));
  assert.ok(result.findings.some(finding => finding.ruleId === 'potentially-unused-file' && finding.file === 'orphan.ts'));
  assert.ok(result.findings.some(finding => finding.ruleId === 'potentially-unused-file' && finding.file === 'vite.config.ts'));
});

test('universal: custom extensions, binary input and invalid universal configuration remain explicit', async t => {
  const root = await fixture(t, { 'main.nim': 'echo "hello"\n', '.repodoctor.yml': 'sourceExtensions: [.nim]' });
  const result = await scan(root);
  assert.equal(result.languages[0]!.mode, 'text'); assert.equal(result.metrics[0]!.lines, 1);
  assert.equal(result.analysisCoverage.cycles.status, 'unavailable'); assert.equal(result.score.value, null);
  await writeFile(path.join(root, 'main.go'), 'package main\0binary');
  assert.ok((await scan(root)).diagnostics.some(diagnostic => diagnostic.code === 'BINARY_SOURCE'));
  for (const config of ['profile: imaginary', 'scope: [../escape]', 'scope: [src/**]', 'respectGitignore: yes', 'sourceExtensions: [ts]', 'duplication: { minBytes: 0 }']) {
    await writeFile(path.join(root, '.repodoctor.yml'), config);
    assert.equal((await scan(root)).diagnostics[0]!.code, 'INVALID_CONFIG', config);
  }
});

test('universal: scoped monorepos retain ancestor aliases and config; large profile remains bounded and targets untouched', async t => {
  const root = await fixture(t, {
    'package.json': '{"main":"apps/web/index.ts"}',
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./apps/web/*"]}}}',
    '.repodoctor.yml': 'profile: large\nlimits: { timeoutMs: 90000 }',
    'apps/web/index.ts': "import '@/dep';", 'apps/web/dep.ts': 'export {};',
    'apps/worker/main.py': 'print("worker")', 'irrelevant/deep/invalid.ts': 'invalid ! code'
  });
  const before = await snapshot(root);
  const result = await scan(root, { scope: ['apps/web'] });
  assert.deepEqual(result.files, ['apps/web/dep.ts', 'apps/web/index.ts']);
  assert.equal(result.configuration.profile, 'large'); assert.equal(result.configuration.limits.timeoutMs, 90_000);
  assert.equal(result.configuration.limits.maxFiles, 100_000);
  assert.equal(result.dependencies[0]!.to, 'apps/web/dep.ts'); assert.equal(result.coverage.status, 'complete');
  assert.ok(result.limitations.some(limitation => limitation.includes('restricted')));
  assert.deepEqual(await snapshot(root), before);
  const implicit = spawnSync(process.execPath, [cli, 'scan', '--scope', 'apps/web', '--profile', 'standard', '--format', 'json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(implicit.status, 0, implicit.stderr);
  const report = parsedReport(implicit.stdout);
  assert.deepEqual(report.files, result.files); assert.equal(report.configuration.profile, 'standard');
  const missing = await scan(root, { scope: ['nonexistent'] });
  assert.ok(missing.diagnostics.some(diagnostic => diagnostic.code === 'EMPTY_SCOPE'));
  for (const args of [['--profile', 'fast'], ['--scope'], ['--scope', '../escape'], ['--format', 'json', '--format', 'html'], ['--details', '--details']]) {
    const execution = spawnSync(process.execPath, [cli, 'scan', root, ...args], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(execution.status, 2, args.join(' '));
  }
});

test('universal: terminal summary caps lists and groups diagnostics while details and JSON retain all evidence', async t => {
  const entries = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`module${index}.ts`, `import './missing${index}';`]));
  const root = await fixture(t, { ...entries, 'package.json': '{}', 'index.ts': 'export {};' });
  const result = await scan(root);
  const summary = renderTerminal(result); const detailed = renderTerminal(result, true);
  assert.ok(summary.includes('UNRESOLVED_REFERENCE × 30'));
  assert.ok(summary.includes('10 more findings'));
  assert.ok(!summary.includes('observed 100/100'));
  assert.ok(detailed.includes('module29.ts')); assert.ok(JSON.parse(renderJSON(result)).dependencies.length === 30);
  assert.ok(summary.length < detailed.length / 2);
  const execution = spawnSync(process.execPath, [cli, 'scan', root, '--details'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(execution.stdout, detailed);
});

test('context: sizes remain measured but tests, migrations, tools and slight excess get proportionate impact', async t => {
  const fn = (name: string, lines: number): string => `export function ${name}() {\n${Array.from({ length: lines - 2 }, (_, i) => ` const value${i} = ${i};`).join('\n')}\n}`;
  const root = await fixture(t, {
    'package.json': '{"devDependencies":{"vite":"*"},"scripts":{"test":"node scripts/test-integration.ts","test:custom":"node scripts/validation.ts","start":"node ops/start.ts"}}',
    '.repodoctor.yml': 'thresholds: { fileLines: 30, functionLines: 10 }\nduplication: { minTokens: 1000 }',
    'index.ts': "import './src/logic'; import './src/slight'; import './tests/runtime-helper'; import './prisma/migrations/runtime.sql'; import type { Shape } from './tests/types';",
    'src/logic.ts': fn('logic', 20), 'src/slight.ts': fn('slight', 11),
    'tests/scenarios.ts': fn('scenarios', 20), 'tests/extreme.ts': fn('extreme', 40),
    'tests/runtime-helper.ts': fn('runtimeHelper', 20), 'tests/types.ts': `export type Shape = {};\n${fn('typeHelper', 20)}`,
    'scripts/test-integration.ts': fn('integration', 20), 'vite.config.ts': fn('configure', 20),
    'scripts/validation.ts': fn('validate', 20), 'ops/start.ts': "import '../tests/custom-runtime';", 'tests/custom-runtime.ts': fn('customRuntime', 20),
    'orphan.ts': 'export {};',
    'prisma/migrations/001_initial/migration.sql': Array.from({ length: 60 }, (_, i) => `CREATE TABLE example${i} (id INTEGER);`).join('\n'),
    'prisma/migrations/runtime.sql': Array.from({ length: 61 }, (_, i) => `SELECT ${i};`).join('\n')
  });
  const before = await snapshot(root); const result = await scan(root);
  const size = (file: string) => result.findings.find(finding => finding.file === file && finding.ruleId === 'oversized-function')!;
  assert.equal(size('src/logic.ts').context!.factor, 1); assert.equal(size('src/logic.ts').severity, 'warning');
  assert.equal(size('src/slight.ts').context!.factor, 0.1); assert.equal(size('src/slight.ts').severity, 'info');
  for (const file of ['tests/scenarios.ts', 'scripts/test-integration.ts', 'tests/types.ts', 'scripts/validation.ts']) {
    assert.equal(size(file).context!.role, 'test'); assert.equal(size(file).context!.factor, 0.25);
    assert.equal(size(file).severity, 'info'); assert.equal(size(file).confidence, 'CONFIRMED');
  }
  assert.equal(size('tests/extreme.ts').severity, 'warning');
  assert.equal(size('tests/runtime-helper.ts').context!.role, 'application');
  assert.equal(size('tests/runtime-helper.ts').context!.factor, 1);
  assert.equal(size('tests/custom-runtime.ts').context!.role, 'application'); assert.equal(size('tests/custom-runtime.ts').context!.factor, 1);
  assert.ok(result.findings.indexOf(size('src/logic.ts')) < result.findings.findIndex(finding => finding.file === 'orphan.ts'));
  assert.equal(result.score.contributions.find(item => item.file === 'orphan.ts')!.rawPenalty, 0.5);
  assert.equal(size('vite.config.ts').context!.role, 'tooling'); assert.equal(size('vite.config.ts').context!.factor, 0.5);
  const migration = result.findings.find(finding => finding.file.endsWith('migration.sql'))!;
  assert.equal(migration.context!.role, 'migration'); assert.equal(migration.context!.factor, 0); assert.equal(migration.severity, 'info');
  assert.equal(result.score.contributions.find(item => item.file === migration.file)!.appliedPenalty, 0);
  assert.ok(migration.recommendation.includes('atomicity')); assert.equal(result.metrics.find(metric => metric.file === migration.file)!.lines, 60);
  const runtimeSQL = result.findings.find(finding => finding.file === 'prisma/migrations/runtime.sql')!;
  assert.equal(runtimeSQL.context!.role, 'application'); assert.equal(runtimeSQL.context!.factor, 1); assert.equal(runtimeSQL.severity, 'warning');
  assert.deepEqual(calculateScore([...result.findings].reverse().concat(result.findings), result.configuration, result.analysisCoverage, result.coverage.analyzedFiles), result.score);
  assert.deepEqual(await snapshot(root), before);
});

test('context: test cycles and mixed application duplicates retain full impact; test duplication stays visible', async t => {
  const body = 'export function shared() {\n const a = 1;\n const b = a + 2;\n return b;\n}';
  const root = await fixture(t, {
    'package.json': '{}', '.repodoctor.yml': 'duplication: { minTokens: 10, minLines: 3 }',
    'index.ts': 'export {};', 'tests/a.ts': `import './b';\n${body}`, 'tests/b.ts': `import './a';\n${body}`
  });
  const before = await snapshot(root); const testOnly = await scan(root);
  const cycle = testOnly.findings.find(finding => finding.ruleId === 'runtime-cycle')!;
  assert.equal(cycle.context!.role, 'test'); assert.equal(cycle.context!.factor, 1); assert.equal(cycle.severity, 'warning');
  const duplication = testOnly.findings.find(finding => finding.ruleId === 'duplicate-block')!;
  assert.equal(duplication.context!.factor, 0.5); assert.equal(duplication.severity, 'warning');
  assert.equal(testOnly.score.penalties.cycles, 8); assert.equal(testOnly.score.penalties.duplication, 2.5);
  assert.deepEqual(await snapshot(root), before);
  await writeFile(path.join(root, 'index.ts'), "import './tests/a';");
  const consumed = await scan(root);
  assert.equal(consumed.findings.find(finding => finding.ruleId === 'duplicate-block')!.context!.factor, 1);
  assert.equal(consumed.score.penalties.cycles, 8); assert.equal(consumed.score.penalties.duplication, 5);
  for (const query of ['architecture', 'duplicates', 'dead-code'] as const) assert.deepEqual(selectView(consumed, query).score, consumed.score);
  await mkdir(path.join(root, 'prisma/migrations/001'), { recursive: true });
  await writeFile(path.join(root, 'prisma/migrations/001/migration.sql'), Array.from({ length: 301 }, (_, i) => `SELECT ${i};`).join('\n'));
  await writeFile(path.join(root, '.repodoctor.yml'), 'duplication: { minTokens: 10, minLines: 3 }\nlimits: { maxFindings: 1 }');
  const bounded = await scan(root);
  assert.equal(bounded.findings.length, 1); assert.equal(bounded.findings[0]!.ruleId, 'runtime-cycle');
  assert.ok(bounded.diagnostics.some(item => item.code === 'FINDING_LIMIT')); assert.equal(bounded.score.value, null);
});

test('context: numeric provisional score appears in every report without promoting partial or failed coverage', async t => {
  const root = await fixture(t, {
    'package.json': '{}', 'index.ts': 'export {};', '.repodoctor.yml': 'thresholds: { fileLines: 5 }',
    'main.py': Array.from({ length: 7 }, (_, i) => `print(${i})`).join('\n')
  });
  const before = await snapshot(root); const result = await scan(root);
  assert.equal(result.schemaVersion, '1.3'); assert.equal(result.score.formulaVersion, '1.1');
  assert.equal(result.score.status, 'partial'); assert.equal(result.score.value, null); assert.equal(result.score.observedValue, 98.4);
  assert.ok(renderTerminal(result).includes('Structural score: 98.4/100 · provisional (partial coverage)'));
  assert.ok(renderTerminal(result, true).includes('98.4/100 · provisional'));
  assert.ok(renderHTML(result).includes('98.4/100 · provisional')); assert.equal(JSON.parse(renderJSON(result)).score.observedValue, 98.4);
  const execution = runCLI(root); assert.equal(execution.status, 1); assert.equal(execution.stdout, renderTerminal(result));
  assert.deepEqual(await snapshot(root), before);
  await writeFile(path.join(root, '.repodoctor.yml'), 'thresholds: { fileLines: 30 }');
  const observedClean = await scan(root);
  assert.equal(observedClean.score.observedValue, 100); assert.equal(observedClean.score.value, null);
  assert.ok(renderTerminal(observedClean).includes('100/100 · provisional (partial coverage)'));
  await writeFile(path.join(root, '.repodoctor.yml'), 'invalid: true');
  const failed = await scan(root); assert.equal(failed.score.observedValue, null);
  assert.ok(renderTerminal(failed).includes('unavailable (no assessable analysis)'));
});
