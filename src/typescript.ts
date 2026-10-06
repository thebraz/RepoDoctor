import path from 'node:path';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { excluded, insideRoot, inputDiagnostic, InputError, relativeFile, safeRead, type ReadBudget } from './files.js';
import { compareText, type Configuration, type Dependency, type Diagnostic } from './model.js';
import type { ParseJob, ParsedSource } from './parser-worker.js';

/** One reusable worker bounds parser time; target code is never evaluated. */
export class SourceParser {
  private worker: Worker | undefined;
  async parse(job: ParseJob, timeoutMs: number, signal: AbortSignal): Promise<ParsedSource> {
    signal.throwIfAborted();
    this.worker ??= new Worker(new URL('./parser-worker.js', import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exited); signal.removeEventListener('abort', aborted);
      };
      const failure = (code: string, text: string): void => {
        cleanup(); this.worker = undefined; void worker.terminate();
        resolve({ dependencies: [], diagnostics: [{ code, severity: 'warning', message: text, file: job.file }], valid: false, generated: false, metrics: null, duplication: null, duplicationComplete: false, duplicationTokensRead: 0 });
      };
      const message = (value: ParsedSource): void => { cleanup(); resolve(value); };
      const error = (): void => failure('PARSE_ERROR', 'Analysis process failed; file not analyzed.');
      const exited = (): void => failure('PARSE_ERROR', 'Analysis process interrupted; file not analyzed.');
      const aborted = (): void => { cleanup(); this.worker = undefined; void worker.terminate(); reject(signal.reason); };
      const timer = setTimeout(() => failure('PARSE_TIMEOUT', 'Parser time limit reached; file not analyzed.'), timeoutMs);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exited); signal.addEventListener('abort', aborted, { once: true });
      worker.postMessage(job);
    });
  }
  async close(): Promise<void> { const worker = this.worker; this.worker = undefined; if (worker) await worker.terminate(); }
}

interface Alias { pattern: string; targets: string[]; rawTargets: string[] }
export interface TSConfiguration { dir: string; base: string | null; aliases: Alias[]; supported: boolean; output: { outDir: string | null; rootDir: string | null } }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
}

export async function readTSConfigurations(root: string, files: string[], config: Configuration, diagnostics: Diagnostic[], signal: AbortSignal, budget: ReadBudget): Promise<TSConfiguration[]> {
  const cache = new Map<string, TSConfiguration>();
  let reads = 0;
  const load = async (file: string, chain: string[]): Promise<TSConfiguration> => {
    if (cache.has(file)) return cache.get(file)!;
    const dir = path.dirname(file);
    const empty: TSConfiguration = { dir, base: null, aliases: [], supported: false, output: { outDir: null, rootDir: null } };
    if (chain.includes(file) || chain.length >= 16 || ++reads > config.limits.maxFiles) {
      diagnostics.push({ code: 'TSCONFIG_LIMIT', severity: 'warning', message: 'Circular inheritance or TypeScript configuration limit reached.', file: relativeFile(root, file) }); return empty;
    }
    let source: string;
    try { source = await safeRead(root, file, 65_536, signal, budget); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof InputError && error.code === 'TOTAL_BYTES_LIMIT') throw error;
      diagnostics.push(inputDiagnostic(error, relativeFile(root, file))); return empty;
    }
    // TypeScript expects slash-normalized names, including when reporting malformed JSONC on Windows.
    let parsed: ReturnType<typeof ts.parseConfigFileTextToJson>;
    try { parsed = ts.parseConfigFileTextToJson(relativeFile(root, file), source); }
    catch { diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'TypeScript configuration is invalid or too complex for the parser.', file: relativeFile(root, file) }); return empty; }
    const value: unknown = parsed.config;
    if (parsed.error || !record(value)) { diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'Invalid TypeScript configuration.', file: relativeFile(root, file) }); return empty; }
    let inherited: TSConfiguration = { ...empty, supported: true };
    if (value.extends !== undefined) {
      if (typeof value.extends !== 'string' || !value.extends.startsWith('.') || value.extends.includes('\\')) {
        diagnostics.push({ code: 'UNSUPPORTED_TSCONFIG', severity: 'warning', message: 'extends supports only a relative local JSON file.', file: relativeFile(root, file) });
        inherited.supported = false;
      } else {
        let parent = path.resolve(dir, value.extends);
        if (!path.extname(parent)) parent += '.json';
        if (!insideRoot(root, parent) || excluded(relativeFile(root, parent), config)) {
          inherited.supported = false;
          diagnostics.push({ code: 'ROOT_ESCAPE', severity: 'error', message: 'TypeScript inheritance outside the root or in an excluded path was rejected.', file: relativeFile(root, file) });
        }
        else inherited = await load(parent, [...chain, file]);
      }
    }
    const current: TSConfiguration = { dir, base: inherited.base, aliases: inherited.aliases, supported: inherited.supported, output: { ...inherited.output } };
    const options: unknown = value.compilerOptions;
    if (options !== undefined && !record(options)) { current.supported = false; diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'compilerOptions must be an object.', file: relativeFile(root, file) }); }
    if (record(options)) {
      const converted = ts.convertCompilerOptionsFromJson(options, dir);
      if (converted.errors.length) {
        current.supported = false;
        for (const error of converted.errors.slice(0, 100)) diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: `Invalid or unknown TypeScript option (TS${error.code}).`, file: relativeFile(root, file) });
      }
      for (const key of ['outDir', 'rootDir'] as const) {
        if (typeof options[key] === 'string' && insideRoot(root, path.resolve(dir, options[key]))) current.output[key] = path.resolve(dir, options[key]);
      }
      if (options.baseUrl !== undefined) {
        if (typeof options.baseUrl !== 'string' || !insideRoot(root, path.resolve(dir, options.baseUrl))) { current.supported = false; diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'baseUrl is invalid or outside the root.', file: relativeFile(root, file) }); }
        else {
          current.base = path.resolve(dir, options.baseUrl);
          current.aliases = inherited.aliases.map(alias => ({ ...alias, targets: alias.rawTargets.map(target => path.resolve(current.base!, target)) }));
          if (current.aliases.some(alias => alias.targets.some(target => !insideRoot(root, target)))) {
            current.supported = false;
            diagnostics.push({ code: 'ROOT_ESCAPE', severity: 'error', message: 'Inherited alias escapes the root after a baseUrl change.', file: relativeFile(root, file) });
          }
        }
      }
      if (options.paths !== undefined) {
        current.aliases = [];
        if (!record(options.paths) || Object.keys(options.paths).length > 128) { current.supported = false; diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'paths must be an object with at most 128 aliases.', file: relativeFile(root, file) }); }
        else for (const [pattern, targets] of Object.entries(options.paths)) {
          const valid = pattern.length > 0 && pattern.length <= 256 && pattern.split('*').length <= 2 &&
            !['__proto__', 'constructor', 'prototype'].includes(pattern) && !/[\x00-\x1f\x7f\\]/.test(pattern) &&
            Array.isArray(targets) && targets.length > 0 && targets.length <= 16 && targets.every((target: unknown) => typeof target === 'string' && target.length <= 256 && target.split('*').length <= 2 && !target.includes('\\') && insideRoot(root, path.resolve(current.base ?? dir, target.replace('*', ''))));
          if (!valid) { current.supported = false; diagnostics.push({ code: 'INVALID_TSCONFIG', severity: 'error', message: 'TypeScript alias is invalid or targets a path outside the root.', file: relativeFile(root, file) }); }
          else current.aliases.push({ pattern, targets: targets.map((target: string) => path.resolve(current.base ?? dir, target)), rawTargets: targets });
        }
      }
      // Language-service plugins run in editors, not the compiler resolver.
      // Never load them; their presence does not invalidate local imports.
      if (['rootDirs', 'moduleSuffixes', 'customConditions'].some(key => options[key] !== undefined)) { current.supported = false; diagnostics.push({ code: 'UNSUPPORTED_TSCONFIG', severity: 'warning', message: 'Advanced resolution configuration is not supported.', file: relativeFile(root, file) }); }
    }
    if (value.references !== undefined) diagnostics.push({ code: 'UNSUPPORTED_TSCONFIG', severity: 'warning', message: 'Project references are not resolved; only the nearest tsconfig.json is applied.', file: relativeFile(root, file) });
    cache.set(file, current);
    return current;
  };
  const result: TSConfiguration[] = [];
  for (const relative of files) { signal.throwIfAborted(); result.push(await load(path.join(root, relative), [])); }
  // An excluded root config remains excluded; discovery determines the configuration scope.
  return result.sort((a, b) => b.dir.length - a.dir.length || compareText(a.dir, b.dir));
}

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export function candidatePaths(base: string): string[] {
  const ext = path.extname(base).toLowerCase();
  const replacement = ext === '.js' ? ['.ts', '.tsx', '.js', '.jsx'] : ext === '.mjs' ? ['.mts', '.mjs'] : ext === '.cjs' ? ['.cts', '.cjs'] : ext === '.jsx' ? ['.tsx', '.jsx'] : [];
  return [...replacement.map(suffix => base.slice(0, -ext.length) + suffix), base, ...extensions.map(suffix => base + suffix), ...extensions.map(suffix => path.join(base, `index${suffix}`))];
}

export function sourceIdentities(root: string, files: string[]): Map<string, string> {
  return new Map(files.map(file => [process.platform === 'win32' ? path.resolve(root, file).toLowerCase() : path.resolve(root, file), file]));
}
export function resolveSourcePath(root: string, base: string, identities: Map<string, string>, config: Configuration): string | undefined {
  for (const file of candidatePaths(base)) {
    if (!insideRoot(root, file) || excluded(relativeFile(root, file), config)) continue;
    const canonical = path.normalize(file);
    const found = identities.get(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
    if (found) return found;
  }
  return undefined;
}

export function resolveDependencies(root: string, dependencies: Dependency[], files: string[], configurations: TSConfiguration[], config: Configuration, diagnostics: Diagnostic[], check: () => void = () => {}): void {
  // Filesystem canonicalization uses the platform's actual paths; do not lowercase displays.
  const identities = sourceIdentities(root, files);
  const configsByDir = new Map(configurations.map(item => [item.dir, item]));
  const configForFile = new Map<string, TSConfiguration | undefined>();
  for (const file of files) {
    check();
    let dir = path.dirname(path.join(root, file));
    while (insideRoot(root, dir)) {
      if (configsByDir.has(dir)) { configForFile.set(file, configsByDir.get(dir)); break; }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const match = (candidate: string): string | undefined => resolveSourcePath(root, candidate, identities, config);
  for (const edge of dependencies) {
    check();
    if (edge.resolution === 'indeterminate' || edge.specifier === null) continue;
    const specifier = edge.specifier;
    const source = path.join(root, edge.from);
    const tsconfig = configForFile.get(edge.from);
    if (tsconfig && !tsconfig.supported) {
      edge.reason = 'Invalid or unsupported TypeScript resolution configuration; target not confirmed.';
      edge.resolution = 'unresolved';
      diagnostics.push({ code: 'UNRESOLVED_REFERENCE', severity: 'warning', message: edge.reason, file: edge.from, line: edge.line, column: edge.column });
      continue;
    }
    const aliases = tsconfig?.aliases.map(alias => {
      const star = alias.pattern.indexOf('*');
      const matches = star === -1 ? alias.pattern === specifier : specifier.startsWith(alias.pattern.slice(0, star)) && specifier.endsWith(alias.pattern.slice(star + 1)) && specifier.length >= alias.pattern.length - 1;
      const capture = star === -1 ? '' : specifier.slice(star, specifier.length - (alias.pattern.length - star - 1));
      return { alias, matches, capture, prefix: star === -1 ? Number.MAX_SAFE_INTEGER : star };
    }).filter(item => item.matches).sort((a, b) => b.prefix - a.prefix || compareText(a.alias.pattern, b.alias.pattern));
    let candidates: string[] = [];
    let local = false;
    if (!specifier || /[\x00-\x1f\x7f]/.test(specifier)) edge.reason = 'Empty reference or reference with control characters is not supported.';
    else if (specifier.includes('\\') || specifier.startsWith('/') || /^[a-z]:/i.test(specifier) || specifier.startsWith('file:')) {
      edge.reason = 'Absolute reference, file: reference or unsupported separator.';
    } else if (specifier.startsWith('.')) { candidates = [path.resolve(path.dirname(source), specifier)]; local = true; }
    else if (aliases?.length) { candidates = aliases[0]!.alias.targets.map(target => target.replace('*', aliases[0]!.capture)); local = true; }
    else if (specifier.startsWith('#')) edge.reason = 'package.json imports is not supported.';
    else if (specifier.includes('?') || specifier.includes('!')) edge.reason = 'Loader reference is not supported.';
    else if (tsconfig?.base) { candidates = [path.resolve(tsconfig.base, specifier)]; }
    if (candidates.some(candidate => !insideRoot(root, candidate))) edge.reason = 'Local reference escapes the root.';
    if (!edge.reason) {
      const found = candidates.map(match).find(Boolean);
      if (found) { edge.to = found; edge.resolution = 'internal'; continue; }
      if (!local && !specifier.startsWith('.')) { edge.resolution = 'external'; continue; }
      edge.reason = 'Local file is missing, excluded or has an unsupported format.';
    }
    edge.resolution = 'unresolved';
    diagnostics.push({ code: edge.reason === 'Local reference escapes the root.' ? 'ROOT_ESCAPE' : 'UNRESOLVED_REFERENCE', severity: 'warning', message: edge.reason,
      file: edge.from, line: edge.line, column: edge.column });
  }
}
