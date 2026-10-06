import path from 'node:path';
import { insideRoot, inputDiagnostic, InputError, matchesExclude, relativeFile, safeRead, SOURCE_EXTENSION, type ReadBudget } from './files.js';
import { candidatePaths, resolveSourcePath, sourceIdentities, type TSConfiguration } from './typescript.js';
import { compareText, type Configuration, type DeclaredPackage, type Diagnostic, type EntryPoint, type PackageSection } from './model.js';
import { packageNameOf } from './analysis.js';

export interface ProjectMetadata {
  entryPoints: EntryPoint[];
  packages: DeclaredPackage[];
  scriptTools: { name: string; manifest: string; script: string }[];
  entryUncertainty: boolean;
  scriptUncertainty: boolean;
  manifests: number;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
}

/** Lex only enough shell syntax to identify executable positions and literal paths.
 * Inline evaluation, substitutions and unmatched quoting remain indeterminate. */
function scriptTokens(source: string): { words: string[]; uncertain: boolean } {
  const words: string[] = []; let word = ''; let quote = ''; let uncertain = /\$\(|`|\$\{|\$[a-z_]|%[^%\s]+%|(?:^|\s)(?:-e|--eval|-p|--print)(?:\s|=)/i.test(source);
  for (let i = 0; i < source.length; i++) {
    const character = source[i]!;
    if (quote) { if (character === quote) quote = ''; else if (character === '\\' && source[i + 1] === quote) word += source[++i]; else word += character; }
    else if (character === '"' || character === "'") quote = character;
    else if (/\s/.test(character) || ';&|'.includes(character)) { if (word) { words.push(word); word = ''; } if (';&|'.includes(character)) words.push(';'); }
    else word += character;
  }
  if (word) words.push(word);
  uncertain ||= quote !== '';
  return { words, uncertain };
}

export async function readProject(root: string, manifests: string[], files: string[], configurations: TSConfiguration[], config: Configuration, diagnostics: Diagnostic[], signal: AbortSignal, budget: ReadBudget, check: () => void = () => {}): Promise<ProjectMetadata> {
  const project: ProjectMetadata = { entryPoints: [], packages: [], scriptTools: [], entryUncertainty: false, scriptUncertainty: false, manifests: 0 };
  const identities = sourceIdentities(root, files);
  const entryKeys = new Set<string>();
  const configsByDirectory = new Map(configurations.map(item => [item.dir, item]));
  const configsForDirectory = new Map<string, TSConfiguration | undefined>();
  const configurationAt = (directory: string): TSConfiguration | undefined => {
    if (configsForDirectory.has(directory)) return configsForDirectory.get(directory);
    let cursor = directory;
    while (insideRoot(root, cursor)) {
      if (configsByDirectory.has(cursor)) { const found = configsByDirectory.get(cursor); configsForDirectory.set(directory, found); return found; }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    configsForDirectory.set(directory, undefined); return undefined;
  };
  const workCheck = (): void => {
    check(); signal.throwIfAborted();
    if (project.entryPoints.length + project.packages.length + project.scriptTools.length >= config.limits.maxEntries) throw new InputError('PROJECT_LIMIT', 'Metadata entry limit reached.');
  };
  const add = (file: string, origin: EntryPoint['origin'], reason: string, purpose?: EntryPoint['purpose']): void => {
    workCheck();
    const key = JSON.stringify([file, origin, reason]);
    if (!entryKeys.has(key)) { entryKeys.add(key); project.entryPoints.push({ file, origin, reason, ...(purpose ? { purpose } : {}) }); }
  };
  const locate = (directory: string, target: string): string[] => {
    const base = path.resolve(directory, target);
    if (!insideRoot(root, base)) return [];
    const bases = [base, base.replace(/\.d\.([cm]?)ts$/i, '.$1ts')];
    const tsconfig = configurationAt(directory);
    if (tsconfig?.supported && tsconfig.output.outDir && tsconfig.output.rootDir && insideRoot(tsconfig.output.outDir, base)) {
      const mapped = path.join(tsconfig.output.rootDir, path.relative(tsconfig.output.outDir, base));
      bases.push(mapped, mapped.replace(/\.d\.([cm]?)ts$/i, '.$1ts'));
    }
    const matches = new Set<string>();
    for (const candidate of new Set(bases)) {
      if (/[?*]/.test(candidate)) for (const variant of candidatePaths(candidate)) {
        const pattern = relativeFile(root, variant);
        for (const file of files) { workCheck(); if (matchesExclude(file, pattern)) matches.add(file); }
      }
      else { const file = resolveSourcePath(root, candidate, identities, config); if (file) matches.add(file); }
    }
    return [...matches].sort(compareText);
  };
  for (const pattern of config.entryPoints) {
    signal.throwIfAborted();
    const matches = locate(root, pattern);
    if (!matches.length) { project.entryUncertainty = true; diagnostics.push({ code: 'ENTRY_NOT_FOUND', severity: 'warning', message: 'A configured entryPoint does not match an analyzed source.', file: '.repodoctor.yml' }); }
    for (const file of matches) add(file, 'configured', 'Explicit entry point in .repodoctor.yml.');
  }
  const packageDirectories = new Set([root]);
  for (const manifest of manifests) {
    workCheck();
    if (++project.manifests > config.limits.maxFiles) { diagnostics.push({ code: 'MANIFEST_LIMIT', severity: 'warning', message: 'Manifest limit reached.' }); project.entryUncertainty = true; break; }
    const directory = path.dirname(path.join(root, manifest)); packageDirectories.add(directory);
    let value: unknown;
    try { value = JSON.parse(await safeRead(root, path.join(root, manifest), 65_536, signal, budget)); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof InputError && error.code === 'TOTAL_BYTES_LIMIT') throw error;
      project.entryUncertainty = true;
      diagnostics.push(error instanceof SyntaxError ? { code: 'INVALID_MANIFEST', severity: 'error', message: 'Invalid package.json.', file: manifest } : inputDiagnostic(error, manifest)); continue;
    }
    if (!object(value)) { project.entryUncertainty = true; diagnostics.push({ code: 'INVALID_MANIFEST', severity: 'error', message: 'package.json must be an object without dangerous keys.', file: manifest }); continue; }
    const invalid = (message: string): void => { project.entryUncertainty = true; diagnostics.push({ code: 'INVALID_MANIFEST', severity: 'error', message, file: manifest }); };
    const declared = new Map<string, PackageSection[]>();
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const data: unknown = value[section]; if (data === undefined) continue;
      if (!object(data)) { invalid('Invalid dependency section in package.json.'); continue; }
      for (const [name, range] of Object.entries(data)) {
        workCheck();
        if (!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || name.length > 214 || typeof range !== 'string' || range.length > 1_024) { invalid('Invalid dependency declaration in package.json.'); continue; }
        const sections = declared.get(name) ?? []; sections.push(section); declared.set(name, sections);
      }
    }
    for (const [name, sections] of declared) { workCheck(); project.packages.push({ name, manifest, directory: relativeFile(root, directory), sections }); }
    const publicTargets: string[] = [];
    for (const field of ['main', 'module', 'types', 'typings', 'bin', 'exports', 'browser']) {
      if (value[field] === undefined) continue;
      const stack: { data: unknown; depth: number }[] = [{ data: value[field], depth: 0 }]; let entries = 0;
      while (stack.length) {
        workCheck();
        const { data, depth } = stack.pop()!;
        if (depth > 16 || ++entries > 1_024) { invalid('Public entry point structure exceeds the limits.'); break; }
        if (typeof data === 'string') publicTargets.push(data);
        else if (Array.isArray(data)) for (const item of data) stack.push({ data: item, depth: depth + 1 });
        else if (object(data)) for (const item of Object.values(data)) stack.push({ data: item, depth: depth + 1 });
        else if (data !== null && data !== false) invalid('Invalid public entry point in package.json.');
      }
    }
    for (const target of publicTargets) {
      if (target.length > 256 || /[\x00-\x1f\x7f\\]/.test(target) || !insideRoot(root, path.resolve(directory, target))) { invalid('Public entry point is invalid or outside the root.'); continue; }
      if (path.extname(target) && !SOURCE_EXTENSION.test(target)) continue;
      const found = locate(directory, target);
      if (!found.length) { project.entryUncertainty = true; diagnostics.push({ code: 'ENTRY_NOT_FOUND', severity: 'warning', message: 'Public entry point has no matching source; unreached files require investigation.', file: manifest }); }
      for (const file of found) add(file, 'public-api', `Public entry point declared in ${manifest}.`);
    }
    const scripts: unknown = value.scripts;
    if (scripts !== undefined && !object(scripts)) invalid('scripts must be an object without dangerous keys.');
    let scriptDiagnostic = false;
    const uncertainScript = (): void => {
      project.scriptUncertainty = true;
      if (!scriptDiagnostic) { scriptDiagnostic = true; diagnostics.push({ code: 'SCRIPT_UNCERTAIN', severity: 'warning', message: 'Script entry point is missing or runtime context is unsupported; scripts were not executed.', file: manifest }); }
    };
    if (object(scripts)) for (const [name, source] of Object.entries(scripts)) {
      if (typeof source !== 'string' || source.length > 16_384) { invalid('Script is invalid or too large; it was not executed.'); continue; }
      const parsed = scriptTokens(source); project.scriptUncertainty ||= parsed.uncertain;
      let command = true; let inline = false; let runner = false; let interpreter = false; let main = false; let test = false; let dataCommand = false; let cwdUnknown = false; let previous = ''; let skipOperand = false;
      const scriptEntry = (target: string, required: boolean): void => {
        if (cwdUnknown || parsed.uncertain) return;
        const found = locate(directory, target);
        if (required && !found.length) uncertainScript();
        const purpose = /^(?:start|dev|serve|server)(?::|$)/.test(name) ? 'application' : /^(?:test|e2e)(?::|$)/.test(name) || test ? 'test' : 'tooling';
        for (const file of found) add(file, 'script', `File referenced by script ${name} in ${manifest}.`, purpose);
      };
      const preload = (target: string): void => {
        const packageName = packageNameOf(target);
        if (packageName && declared.has(packageName)) project.scriptTools.push({ name: packageName, manifest, script: name });
        else if (/^(?:\.|\/|[a-z]:|file:)/i.test(target)) scriptEntry(target, true);
      };
      for (const word of parsed.words) {
        workCheck();
        if (word === ';') { command = true; inline = false; runner = false; interpreter = false; main = false; test = false; dataCommand = false; previous = ''; skipOperand = false; continue; }
        if (/^NODE_OPTIONS=/i.test(word)) { project.scriptUncertainty = true; continue; }
        if (interpreter && /^-[ep].+/.test(word)) { project.scriptUncertainty = true; inline = true; continue; }
        if (/^(?:-e|--eval|-p|--print)(?:=|$)/.test(word)) { inline = true; continue; }
        if (inline || /^[a-z_][a-z0-9_]*=/i.test(word)) continue;
        const basename = path.basename(word).replace(/\.cmd$/i, '');
        if (skipOperand) { skipOperand = false; continue; }
        if (['--cwd', '--prefix'].includes(word) || /^(?:--cwd|--prefix)=/.test(word) || runner && word === '-C') { cwdUnknown = true; uncertainScript(); skipOperand = !word.includes('='); continue; }
        if (runner && ['exec', 'dlx', 'x'].includes(word)) { command = true; runner = false; continue; }
        if (runner && ['run', 'test', 'start', 'install', 'add', 'remove', 'ci', 'build'].includes(word)) { command = false; runner = false; continue; }
        if (interpreter && ['--loader', '--import', '-r', '--require'].includes(previous)) { preload(word); previous = ''; continue; }
        const option = interpreter ? /^(?:--loader|--import|--require|-r)=(.+)$/.exec(word) ?? /^-r(.+)$/.exec(word) : null;
        if (option) { preload(option[1]!); continue; }
        if (interpreter && ['--loader', '--import', '-r', '--require'].includes(word)) { previous = word; continue; }
        if (interpreter && ['--conditions', '-C', '--input-type', '--inspect-port', '--title', '--icu-data-dir', '--openssl-config', '--tsconfig', '--project', '-P', '--compiler-options', '-O', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination'].includes(word)) { skipOperand = true; continue; }
        if (interpreter && word === '--test') { test = true; continue; }
        if (interpreter && word.startsWith('-')) continue;
        if (command && word.startsWith('-')) continue;
        if (command) {
          if (['cd', 'chdir', 'pushd', 'popd'].includes(basename)) { cwdUnknown = true; uncertainScript(); command = false; continue; }
          const tool = basename === 'tsc' || basename === 'tsserver' ? 'typescript' : word.startsWith('@') ? word : basename;
          const packageName = packageNameOf(tool.replace(/(?!^)@[^@/]+$/, ''));
          if (packageName && declared.has(packageName)) project.scriptTools.push({ name: packageName, manifest, script: name });
          interpreter = ['node', 'nodejs', 'tsx', 'ts-node', 'ts-node-esm'].includes(basename);
          main = interpreter;
          dataCommand = ['echo', 'printf', 'cat', 'type'].includes(basename);
          command = ['npx', 'exec', 'cross-env', 'cross-env-shell', 'yarn', 'pnpm'].includes(basename);
          runner = ['npm', 'pnpm', 'yarn', 'bun'].includes(basename);
          if (SOURCE_EXTENSION.test(word)) scriptEntry(word, true);
          continue;
        }
        if (main || test) { scriptEntry(word, true); main = false; }
        else if (!interpreter && !dataCommand && !word.startsWith('-') && SOURCE_EXTENSION.test(word)) scriptEntry(word, false);
      }
    }
    if (declared.has('next')) for (const file of files) {
      const local = relativeFile(directory, path.join(root, file));
      if (insideRoot(directory, path.join(root, file)) && /^(?:src\/)?(?:pages\/.*|app\/(?:.*\/)?(?:page|layout|route|error|loading|template|not-found|default|global-error)\.[jt]sx?|(?:middleware|instrumentation)\.[jt]s)$/.test(local)) add(file, 'framework', `Next.js route/entry point convention in ${manifest}.`);
    }
    const toolConfigs = [['next', 'next'], ['eslint', 'eslint'], ['vite', 'vite'], ['vitest', 'vitest'], ['jest', 'jest'], ['webpack', 'webpack'], ['rollup', 'rollup'], ['astro', 'astro'], ['nuxt', 'nuxt'], ['svelte', 'svelte'], ['tailwindcss', 'tailwind'], ['postcss', 'postcss']].filter(([dependency]) => declared.has(dependency!));
    if (toolConfigs.length) for (const file of files) {
      workCheck();
      const local = relativeFile(directory, path.join(root, file));
      if (toolConfigs.some(([, basename]) => new RegExp(`^${basename}\\.config\\.[cm]?[jt]s$`).test(local))) add(file, 'framework', `Tool configuration declared in ${manifest}; external consumption without an application import.`);
    }
  }
  for (const directory of packageDirectories) for (const basename of ['index', 'main', 'server', 'src/index', 'src/main', 'src/server']) for (const file of locate(directory, basename)) add(file, 'convention', 'TS/JS project entry point convention.');
  for (const file of files) { workCheck(); if (/(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) add(file, 'test', 'Test convention; treated as an entry point.'); }
  project.entryPoints.sort((a, b) => compareText(a.file, b.file) || compareText(a.origin, b.origin) || compareText(a.reason, b.reason));
  project.packages.sort((a, b) => compareText(a.manifest, b.manifest) || compareText(a.name, b.name));
  return project;
}
