#!/usr/bin/env node
import { scan } from './scan.js';
import { exitCode, renderHTML, renderJSON, renderTerminal, safeText } from './reports.js';
import { selectView } from './model.js';

const usage = 'Usage: repodoctor <command> [root] [options]\nRun repodoctor --help for commands, options and examples.\n';
const help = `RepoDoctor
Local repository analysis with structural scores and review priorities.

USAGE
  repodoctor <command> [root] [options]
  Without a root, scans the current directory.

COMMANDS
  scan           Full analysis, score and review priorities.
  architecture   Dependency cycles.
  duplicates     Detected duplicates.
  dead-code      Potentially unused files and packages.

OPTIONS
  -h, --help            Show this help without running a scan.
  --details             Show the full report in the terminal.
  --format <format>     terminal (default), json or html.
  --profile <profile>   standard (default) or large, with higher limits.
  --scope <path>        Restrict analysis to a path relative to the root.
                       Repeat to analyze multiple paths.

EXAMPLES
  repodoctor scan
  repodoctor scan "./my project" --details
  repodoctor duplicates --format json
  repodoctor scan --profile large --scope apps/web --scope services/api
  repodoctor scan --help

READING THE RESULTS
  The score covers the selected scope, including in filtered queries.
  A provisional score indicates partial coverage; check the limitations.

EXIT CODES
  0  Scan completed with no selected findings.
  1  Scan completed with findings (including informational ones).
  2  Partial acquisition, failure or invalid arguments.
`;
const args = process.argv.slice(2);
const query = (['scan', 'architecture', 'duplicates', 'dead-code'] as const).find(command => command === args[0]);
const hasRoot = args[1] !== undefined && !args[1].startsWith('-');
const root = hasRoot ? args[1]! : '.';
const tail = args.slice(hasRoot ? 2 : 1);
let format = 'terminal'; let profile: 'standard' | 'large' | undefined; let details = false;
const scope: string[] = []; const seen = new Set<string>(); let valid = true;
for (let i = 0; i < tail.length; i++) {
  const flag = tail[i]!;
  if (!['--format', '--profile', '--scope', '--details'].includes(flag) || flag !== '--scope' && seen.has(flag)) { valid = false; break; }
  seen.add(flag);
  if (flag === '--details') { details = true; continue; }
  const value = tail[++i];
  if (!value || value.startsWith('--')) { valid = false; break; }
  if (flag === '--format') { if (!['json', 'terminal', 'html'].includes(value)) { valid = false; break; } format = value; }
  if (flag === '--profile') { if (value !== 'standard' && value !== 'large') { valid = false; break; } profile = value; }
  if (flag === '--scope') scope.push(value);
}
if (args.length === 1 && ['--help', '-h'].includes(args[0]!) || query && tail.length === 1 && ['--help', '-h'].includes(tail[0]!)) process.stdout.write(help);
else if (!query || root === '' || !valid) {
  process.stderr.write(usage); process.exitCode = 2;
} else {
  const abort = new AbortController();
  const cancel = (): void => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = selectView(await scan(root, { signal: abort.signal, ...(profile ? { profile } : {}), ...(scope.length ? { scope } : {}) }), query);
    process.stdout.write(format === 'json' ? renderJSON(result) : format === 'html' ? renderHTML(result) : renderTerminal(result, details));
    if (result.coverage.status === 'failed') process.stderr.write(`RepoDoctor: could not start the scan (${safeText(result.diagnostics[0]?.code ?? 'ERROR')}).\n`);
    else if (result.diagnostics.some(item => ['CANCELLED', 'SCAN_TIMEOUT'].includes(item.code))) process.stderr.write('RepoDoctor: scan interrupted; partial result.\n');
    process.exitCode = exitCode(result);
  } catch {
    process.stderr.write('RepoDoctor: unexpected operational failure.\n'); process.exitCode = 2;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
