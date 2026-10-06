import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const npmCLI = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const temporary = await mkdtemp(path.join(tmpdir(), 'repodoctor-package-'));
const run = (args, cwd = checkout) => {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 16_777_216 });
  assert.ok(!result.error, String(result.error)); return result;
};
try {
  const packed = run([npmCLI, 'pack', '--json', '--pack-destination', temporary]);
  assert.equal(packed.status, 0, packed.stderr);
  const metadata = JSON.parse(packed.stdout)[0];
  const expected = ['LICENSE', 'README.md', 'package.json', 'report.schema.json', ...['analysis', 'cli', 'duplication', 'files', 'graph', 'languages', 'model', 'parser-worker', 'project', 'reports', 'scan', 'score', 'typescript'].map(name => `dist/src/${name}.js`)];
  assert.deepEqual(metadata.files.map(file => file.path).sort(), expected.sort());
  const prefix = path.join(temporary, 'installed with spaces');
  const installation = run([npmCLI, 'install', '--prefix', prefix, path.join(temporary, metadata.filename), '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(installation.status, 0, installation.stderr);
  const installed = path.join(prefix, 'node_modules/repodoctor');
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.version, metadata.version); assert.equal(manifest.license, 'MIT');
  const cli = path.join(installed, manifest.bin.repodoctor);
  const help = run([cli, '--help']);
  assert.equal(help.status, 0); assert.equal(help.stderr, ''); assert.ok(help.stdout.includes('COMMANDS'));
  const target = path.join(temporary, 'target'); await mkdir(target);
  const entries = {};
  for (const file of ['package.json', 'index.ts', 'worker.ts']) {
    entries[file] = await readFile(path.join(checkout, 'examples/cycle', file), 'utf8');
    await writeFile(path.join(target, file), entries[file]);
  }
  let commands = 1;
  for (const query of ['scan', 'architecture', 'duplicates', 'dead-code']) {
    const json = run([cli, query, '--format', 'json'], target); commands++;
    const report = JSON.parse(json.stdout); assert.equal(json.stderr, '');
    assert.equal(report.schemaVersion, '1.3'); assert.equal(report.coverage.status, 'complete'); assert.equal(report.score.value, 92);
    assert.equal(report.dependencies.length, 2); assert.equal(report.diagnostics.length, 0);
    const findings = query === 'scan' || query === 'architecture' ? 1 : 0;
    assert.equal(report.findings.length, findings); assert.equal(json.status, findings ? 1 : 0);
    const terminal = run([cli, query], target); commands++;
    assert.equal(terminal.status, json.status); assert.equal(terminal.stderr, ''); assert.ok(terminal.stdout.includes('Structural score: 92/100'));
    const html = run([cli, query, '--format', 'html'], target); commands++;
    assert.equal(html.status, json.status); assert.equal(html.stderr, ''); assert.ok(html.stdout.includes('<html lang="en">'));
    const embedded = html.stdout.match(/<pre>([\s\S]*?)<\/pre>/)[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.deepEqual(JSON.parse(embedded), report);
  }
  for (const [file, source] of Object.entries(entries)) assert.equal(await readFile(path.join(target, file), 'utf8'), source);
  console.log(`Package verified: ${metadata.files.length} files, ${commands} installed CLI commands, target preserved.`);
} finally {
  const resolved = await realpath(temporary);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('repodoctor-package-'));
  await rm(resolved, { recursive: true, force: true });
}
