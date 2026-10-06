import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, parseDocument } from 'yaml';
import ignore, { type Ignore } from 'ignore';
import { compareText, type Configuration, type Diagnostic, type Limits } from './model.js';
import { sourceLanguage } from './languages.js';

export const DEFAULT_EXCLUSIONS = [
  '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/out/**',
  '**/coverage/**', '**/.next/**', '**/.nuxt/**', '**/.cache/**', '**/.tmp/**',
  '**/*.d.ts', '**/*.d.mts', '**/*.d.cts', '**/*.min.js', '**/*.generated.*',
  '**/.npm-cache/**', '**/__pycache__/**', '**/.venv/**', '**/venv/**',
  '**/.gradle/**', '**/.terraform/**', '**/target/**', '**/obj/**', '**/vendor/**'
];
export const DEFAULT_LIMITS: Limits = {
  maxFiles: 10_000, maxEntries: 100_000, maxDepth: 64, maxFileBytes: 2_097_152,
  maxTotalBytes: 67_108_864, maxParseTimeMs: 5_000, maxAstNodes: 200_000,
  maxDependencies: 100_000, maxFindings: 1_000, timeoutMs: 60_000,
  maxDuplicationTokens: 200_000, maxDuplicationBlocks: 10_000, maxDuplicationComparisons: 5_000_000
};
const CEILINGS: Limits = {
  maxFiles: 100_000, maxEntries: 1_000_000, maxDepth: 128, maxFileBytes: 8_388_608,
  maxTotalBytes: 268_435_456, maxParseTimeMs: 30_000, maxAstNodes: 1_000_000,
  maxDependencies: 1_000_000, maxFindings: 10_000, timeoutMs: 300_000,
  maxDuplicationTokens: 2_000_000, maxDuplicationBlocks: 100_000, maxDuplicationComparisons: 20_000_000
};
export function defaultConfiguration(profile: Configuration['profile'] = 'standard'): Configuration {
  return {
    profile, scope: [], respectGitignore: true, sourceExtensions: [],
    exclude: [...DEFAULT_EXCLUSIONS], entryPoints: [], limits: profile === 'large' ? { ...CEILINGS } : { ...DEFAULT_LIMITS },
    thresholds: { fileLines: 300, functionLines: 50 }, duplication: { minTokens: 50, minLines: 5, minBytes: 100 },
    score: {
      weights: { 'runtime-cycle': 8, 'potentially-unused-file': 2, 'potentially-unused-package': 3, 'oversized-file': 4, 'oversized-function': 2, 'duplicate-block': 5 },
      caps: { cycles: 30, unusedFiles: 15, packages: 15, size: 20, duplication: 20 }
    }
  };
}
export const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
export function relativeFile(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }
export function insideRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export class InputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export interface ReadBudget { bytesRead: number; maxBytes: number }

/** Check every component; never intentionally follow target links or junctions. */
export async function safeRead(root: string, file: string, maxBytes: number, signal?: AbortSignal, budget?: ReadBudget): Promise<string> {
  if (!insideRoot(root, file)) throw new InputError('ROOT_ESCAPE', 'Path outside the root was rejected.');
  let cursor = root;
  for (const component of path.relative(root, file).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if ((await lstat(cursor)).isSymbolicLink()) throw new InputError('LINK_SKIPPED', 'Symbolic link or junction was rejected.');
  }
  const before = await lstat(file, { bigint: true });
  if (!before.isFile()) throw new InputError('READ_ERROR', 'The path is not a regular file.');
  if (!insideRoot(root, await realpath(file))) throw new InputError('ROOT_ESCAPE', 'Real destination outside the root was rejected.');
  if (before.size > BigInt(maxBytes)) throw new InputError('FILE_LIMIT', 'File exceeds the byte limit.');
  if (budget && before.size > BigInt(Math.max(0, budget.maxBytes - budget.bytesRead))) throw new InputError('TOTAL_BYTES_LIMIT', 'Total bytes read limit reached.');
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = await handle.stat({ bigint: true });
    // Some Windows path-based stats report dev=0 while handle stats expose the
    // volume ID. Compare exact inode IDs and real paths; retain dev checks when available.
    const sameDevice = (device: bigint): boolean => device === opened.dev || process.platform === 'win32' && device === 0n;
    if (!sameDevice(before.dev) || opened.ino !== before.ino || !opened.isFile()) throw new InputError('READ_ERROR', 'File changed during reading.');
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(65_536, maxBytes - bytes + 1, budget ? budget.maxBytes - budget.bytesRead + 1 : 65_536));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (budget) {
        budget.bytesRead += bytesRead;
        if (budget.bytesRead > budget.maxBytes) throw new InputError('TOTAL_BYTES_LIMIT', 'Total bytes read limit reached.');
      }
      if (bytes > maxBytes) throw new InputError('FILE_LIMIT', 'File exceeds the byte limit.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await lstat(file, { bigint: true });
    if (after.isSymbolicLink() || !sameDevice(after.dev) || after.ino !== opened.ino ||
      after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || !insideRoot(root, await realpath(file))) {
      throw new InputError('READ_ERROR', 'File changed during reading.');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } finally { await handle.close(); }
}

function segmentMatches(pattern: string, text: string): boolean {
  let p = 0; let t = 0; let star = -1; let retry = 0;
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) { p++; t++; }
    else if (pattern[p] === '*') { star = p++; retry = t; }
    else if (star >= 0) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
export function matchesExclude(file: string, pattern: string): boolean {
  const parts = file.split('/');
  const patterns = pattern.split('/');
  let reachable = new Set([0]);
  for (const part of patterns) {
    const next = new Set<number>();
    for (const position of reachable) {
      if (part === '**') for (let i = position; i <= parts.length; i++) next.add(i);
      else if (position < parts.length && segmentMatches(part, parts[position]!)) next.add(position + 1);
    }
    reachable = next;
  }
  return reachable.has(parts.length);
}
export function excluded(file: string, config: Configuration): boolean { return config.exclude.some(pattern => matchesExclude(file, pattern)); }

function validateKeys(value: Map<unknown, unknown>, allowed: string[], prefix: string): void {
  for (const key of value.keys()) {
    // Do not echo untrusted keys/values into configuration errors.
    if (typeof key !== 'string' || !allowed.includes(key)) throw new InputError('INVALID_CONFIG', `${prefix}: unknown or unsupported field.`);
  }
}
export function validateScope(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some(scope => typeof scope !== 'string' || !scope || scope.length > 256 || scope.includes('\\') || scope.startsWith('/') || /^[a-z]:/i.test(scope) || /[\x00-\x1f\x7f*?]/.test(scope) || scope.split('/').some(part => ['.', '..', ''].includes(part)))) {
    throw new InputError('INVALID_CONFIG', 'scope: use up to 128 relative directories within the root, with / separators.');
  }
  return [...new Set(value as string[])].sort(compareText);
}
export async function readConfiguration(root: string, signal?: AbortSignal, budget?: ReadBudget, profile?: Configuration['profile']): Promise<Configuration> {
  let config = defaultConfiguration(profile);
  let source: string;
  try { source = await safeRead(root, path.join(root, '.repodoctor.yml'), 65_536, signal, budget); }
  catch (error) { if (isMissing(error)) return config; throw error; }
  let doc: ReturnType<typeof parseDocument>;
  try { doc = parseDocument(source, { schema: 'core', customTags: [], uniqueKeys: true }); }
  catch { throw new InputError('INVALID_CONFIG', '.repodoctor.yml: YAML is invalid or too complex for the parser.'); }
  if (doc.errors.length || doc.warnings.length) throw new InputError('INVALID_CONFIG', '.repodoctor.yml: invalid YAML or unsupported tag.');
  const nodes: { node: unknown; depth: number }[] = [{ node: doc.contents, depth: 0 }];
  while (nodes.length) {
    const { node, depth } = nodes.pop()!;
    if (depth > 16) throw new InputError('INVALID_CONFIG', '.repodoctor.yml: maximum depth exceeded.');
    if (isMap(node)) for (const pair of node.items) { nodes.push({ node: pair.key, depth: depth + 1 }); nodes.push({ node: pair.value, depth: depth + 1 }); }
    else if (isSeq(node)) for (const item of node.items) nodes.push({ node: item, depth: depth + 1 });
  }
  let value: unknown;
  try { value = doc.toJS({ mapAsMap: true, maxAliasCount: 0 }); }
  catch { throw new InputError('INVALID_CONFIG', '.repodoctor.yml: YAML aliases are not allowed.'); }
  if (!(value instanceof Map)) throw new InputError('INVALID_CONFIG', '.repodoctor.yml must be a configuration map.');
  validateKeys(value, ['profile', 'scope', 'respectGitignore', 'sourceExtensions', 'exclude', 'entryPoints', 'limits', 'thresholds', 'duplication', 'score'], '.repodoctor.yml');
  if (value.has('profile')) {
    const selected = value.get('profile');
    if (selected !== 'standard' && selected !== 'large') throw new InputError('INVALID_CONFIG', 'profile: expected standard or large.');
    config = defaultConfiguration(profile ?? selected);
  }
  if (value.has('scope')) config.scope = validateScope(value.get('scope'));
  if (value.has('respectGitignore')) {
    if (typeof value.get('respectGitignore') !== 'boolean') throw new InputError('INVALID_CONFIG', 'respectGitignore: expected a boolean.');
    config.respectGitignore = value.get('respectGitignore') as boolean;
  }
  if (value.has('sourceExtensions')) {
    const extensions: unknown = value.get('sourceExtensions');
    if (!Array.isArray(extensions) || extensions.length > 128 || extensions.some(extension => typeof extension !== 'string' || !/^\.[a-z0-9]{1,16}$/.test(extension))) throw new InputError('INVALID_CONFIG', 'sourceExtensions: expected a list of extensions such as .nim.');
    config.sourceExtensions = [...new Set(extensions as string[])].sort(compareText);
  }
  if (value.has('exclude')) {
    const patterns: unknown = value.get('exclude');
    if (!Array.isArray(patterns) || patterns.length > 128) throw new InputError('INVALID_CONFIG', 'exclude: use a list of up to 128 patterns.');
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || !pattern || pattern.length > 256 || pattern.includes('\\') ||
        pattern.startsWith('/') || /^[a-z]:/i.test(pattern) || /[\x00-\x1f\x7f{}\[\]!()]/.test(pattern) ||
        pattern.split('/').some(part => part === '..' || part === '.' || !part || (part.includes('**') && part !== '**'))) {
        throw new InputError('INVALID_CONFIG', 'exclude: invalid pattern; use relative paths with *, ? and ** segments.');
      }
      config.exclude.push(pattern);
    }
  }
  if (value.has('limits')) {
    const limits: unknown = value.get('limits');
    if (!(limits instanceof Map)) throw new InputError('INVALID_CONFIG', 'limits must be a map.');
    validateKeys(limits, Object.keys(DEFAULT_LIMITS), 'limits');
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
      if (!limits.has(key)) continue;
      const number: unknown = limits.get(key);
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > CEILINGS[key]) {
        throw new InputError('INVALID_CONFIG', `limits.${key}: expected an integer between 1 and ${CEILINGS[key]}.`);
      }
      config.limits[key] = number;
    }
  }
  if (value.has('entryPoints')) {
    const entries: unknown = value.get('entryPoints');
    if (!Array.isArray(entries) || entries.length > 128) throw new InputError('INVALID_CONFIG', 'entryPoints: expected a list of up to 128 paths or patterns.');
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry || entry.length > 256 || entry.includes('\\') || entry.startsWith('/') || /^[a-z]:/i.test(entry) || /[\x00-\x1f\x7f{}\[\]!()]/.test(entry) || entry.split('/').some(part => ['..', '.', ''].includes(part) || part.includes('**') && part !== '**')) throw new InputError('INVALID_CONFIG', 'entryPoints: invalid relative path.');
      config.entryPoints.push(entry);
    }
    config.entryPoints = [...new Set(config.entryPoints)].sort(compareText);
  }
  const positiveNumbers = (field: 'thresholds' | 'duplication', maximum: number): void => {
    if (!value.has(field)) return;
    const data: unknown = value.get(field);
    if (!(data instanceof Map)) throw new InputError('INVALID_CONFIG', `${field}: expected a map.`);
    const defaults = config[field];
    validateKeys(data, Object.keys(defaults), field);
    for (const key of Object.keys(defaults)) {
      if (!data.has(key)) continue;
      const number: unknown = data.get(key);
      const ceiling = field === 'duplication' && key !== 'minBytes' ? 1_000 : maximum;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > ceiling) throw new InputError('INVALID_CONFIG', `${field}.${key}: expected a positive integer up to ${ceiling}.`);
      Object.assign(defaults, { [key]: number });
    }
  };
  positiveNumbers('thresholds', 100_000);
  positiveNumbers('duplication', 100_000);
  if (value.has('score')) {
    const score: unknown = value.get('score');
    if (!(score instanceof Map)) throw new InputError('INVALID_CONFIG', 'score: expected a map.');
    validateKeys(score, ['weights', 'caps'], 'score');
    for (const field of ['weights', 'caps'] as const) {
      if (!score.has(field)) continue;
      const options: unknown = score.get(field);
      if (!(options instanceof Map)) throw new InputError('INVALID_CONFIG', `score.${field}: expected a map.`);
      validateKeys(options, Object.keys(config.score[field]), `score.${field}`);
      for (const [key, number] of options) {
        if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 100) throw new InputError('INVALID_CONFIG', `score.${field}: expected weights/caps between 0 and 100.`);
        // Keys are constrained by validateKeys above; copying validated numeric entries cannot introduce dangerous keys.
        Object.assign(config.score[field], { [key]: number });
      }
    }
  }
  config.exclude = [...new Set(config.exclude)].sort(compareText);
  return config;
}

export function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
export function inputDiagnostic(error: unknown, file?: string): Diagnostic {
  return { code: error instanceof InputError ? error.code : 'READ_ERROR', severity: 'error',
    message: error instanceof InputError ? error.message : 'Could not read the file safely.',
    ...(file === undefined ? {} : { file }) };
}

export async function discover(root: string, config: Configuration, diagnostics: Diagnostic[], signal: AbortSignal, budget?: ReadBudget):
  Promise<{ files: string[]; configs: string[]; manifests: string[]; ignoreFiles: string[]; skipped: number }> {
  const files: string[] = []; const configs: string[] = []; const manifests: string[] = []; const ignoreFiles: string[] = [];
  let skipped = 0; let count = 0; let ignoreRules = 0;
  type IgnoreLayer = { directory: string; matcher: Ignore };
  const stack: { dir: string; depth: number; layers: IgnoreLayer[] }[] = [{ dir: root, depth: 0, layers: [] }];
  const snapshot = () => ({ files: files.sort(compareText), configs: configs.sort(compareText), manifests: manifests.sort(compareText), ignoreFiles: ignoreFiles.sort(compareText), skipped });
  const inScope = (file: string, directory: boolean): boolean => !config.scope.length || config.scope.some(scope => file === scope || file.startsWith(`${scope}/`) || directory && scope.startsWith(`${file}/`));
  while (stack.length) {
    signal.throwIfAborted();
    const { dir, depth, layers: inherited } = stack.pop()!;
    if (depth > config.limits.maxDepth) { diagnostics.push({ code: 'DEPTH_LIMIT', severity: 'warning', message: 'Depth limit reached.', file: relativeFile(root, dir) }); skipped++; continue; }
    try {
      if ((await lstat(dir)).isSymbolicLink() || !insideRoot(root, await realpath(dir))) throw new InputError('ROOT_ESCAPE', 'Unsafe directory was rejected.');
      const layers = [...inherited];
      for (const name of [...(config.respectGitignore ? ['.gitignore'] : []), '.repodoctorignore']) {
        const file = path.join(dir, name);
        try {
          const source = await safeRead(root, file, 65_536, signal, budget);
          ignoreRules += source.split(/\r?\n/).length;
          if (ignoreRules > 10_000) throw new InputError('IGNORE_LIMIT', 'Ignore rule limit reached; directory not traversed.');
          layers.push({ directory: dir, matcher: ignore({ ignorecase: process.platform === 'win32' }).add(source) });
          ignoreFiles.push(relativeFile(root, file));
        } catch (error) { if (!isMissing(error)) throw error; }
      }
      // Streaming enumeration caps huge single directories before collecting/sorting them.
      const directory = await opendir(dir);
      const entries: string[] = [];
      for await (const entry of directory) {
        signal.throwIfAborted();
        if (++count > config.limits.maxEntries) { diagnostics.push({ code: 'ENTRY_LIMIT', severity: 'warning', message: 'Entry limit reached.' }); skipped++; return snapshot(); }
        entries.push(entry.name);
      }
      entries.sort(compareText);
      for (const name of entries) {
        signal.throwIfAborted();
        const absolute = path.join(dir, name); const relative = relativeFile(root, absolute);
        if (excluded(relative, config) || excluded(`${relative}/`, config)) { skipped++; continue; }
        const stat = await lstat(absolute);
        if (!inScope(relative, stat.isDirectory()) && !['tsconfig.json', 'package.json'].includes(name)) { skipped++; continue; }
        let ignored = false;
        for (const layer of layers) {
          const local = relativeFile(layer.directory, absolute) + (stat.isDirectory() ? '/' : '');
          const match = layer.matcher.test(local);
          if (match.ignored) ignored = true;
          else if (match.unignored) ignored = false;
        }
        if (ignored) { skipped++; continue; }
        if (stat.isSymbolicLink()) { diagnostics.push({ code: 'LINK_SKIPPED', severity: 'warning', message: 'Symbolic link or junction not traversed.', file: relative }); skipped++; continue; }
        if (stat.isDirectory()) { stack.push({ dir: absolute, depth: depth + 1, layers }); continue; }
        if (!stat.isFile()) { skipped++; continue; }
        if (name === 'tsconfig.json') configs.push(relative);
        if (name === 'package.json') manifests.push(relative);
        if (!inScope(relative, false) || !sourceLanguage(name, config)) { skipped++; continue; }
        if (files.length >= config.limits.maxFiles) { diagnostics.push({ code: 'FILE_COUNT_LIMIT', severity: 'warning', message: 'Source file count limit reached.' }); skipped++; return snapshot(); }
        files.push(relative);
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof InputError && error.code === 'TOTAL_BYTES_LIMIT') throw error;
      diagnostics.push(inputDiagnostic(error, relativeFile(root, dir)));
    }
  }
  for (const scope of config.scope) {
    const found = files.some(file => file === scope || file.startsWith(`${scope}/`));
    if (!found) diagnostics.push({ code: 'EMPTY_SCOPE', severity: 'warning', message: 'Scope has no accessible source files; it does not represent the entire repository.', file: scope });
  }
  return snapshot();
}
