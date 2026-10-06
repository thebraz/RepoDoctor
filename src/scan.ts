import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { defaultConfiguration, discover, inputDiagnostic, InputError, readConfiguration, safeRead, validateScope, type ReadBudget } from './files.js';
import { findRuntimeCycles } from './graph.js';
import { compareText, type AnalysisCategory, type CategoryCoverage, type DuplicationSource, type ScanResult, type TextFingerprint } from './model.js';
import { readTSConfigurations, resolveDependencies, SourceParser } from './typescript.js';
import { readProject } from './project.js';
import { analyzeFileUsage, analyzePackages, analyzeSize, contextualizeFindings } from './analysis.js';
import { analyzeDuplication, analyzeTextDuplication, textFingerprint } from './duplication.js';
import { calculateScore, rawFindingPenalty } from './score.js';
import { isGeneratedSource, sourceLanguage, textMetric } from './languages.js';

export const LIMITATIONS = [
  'Static syntax analysis; does not type-check or prove that branches or functions execute.',
  'Type-only references require explicit import/export type; compiler-inferred import elision is not reproduced.',
  'Resolves relative source files and local aliases; package exports/imports, conditions and loaders are not emulated.',
  'External references are classified without confirming package installation or existence.',
  'One demonstrable cycle per strongly connected component; does not enumerate every cyclic path.',
  'Files/packages without static usage are candidates, never proof of redundancy; recognized conventions are limited.',
  'Exact duplication of whole files/function bodies; comments and whitespace outside literals are ignored, identifiers and literals are preserved.',
  'Exclusions define coverage; links and junctions are not traversed. Concurrent changes to the target may invalidate the result.'
];

export async function scan(rootArgument: string, options: { signal?: AbortSignal; profile?: 'standard' | 'large'; scope?: string[] } = {}): Promise<ScanResult> {
  const configuration = defaultConfiguration(options.profile);
  const analysisCoverage: ScanResult['analysisCoverage'] = {
    cycles: { status: 'unavailable', reason: 'Analysis not performed.' }, unusedFiles: { status: 'unavailable', reason: 'Analysis not performed.' },
    packages: { status: 'unavailable', reason: 'Analysis not performed.' }, size: { status: 'unavailable', reason: 'Analysis not performed.' }, duplication: { status: 'unavailable', reason: 'Analysis not performed.' }
  };
  const result: ScanResult = {
    schemaVersion: '1.3', root: path.resolve(rootArgument), limitations: [...LIMITATIONS], configuration,
    coverage: { status: 'complete', discoveredFiles: 0, analyzedFiles: 0, skippedEntries: 0, bytesRead: 0 },
    files: [], dependencies: [], findings: [], diagnostics: [], entryPoints: [], unusedFiles: [], packages: [], metrics: [], duplicates: [], languages: [], ignoreFiles: [],
    analysisCoverage, score: calculateScore([], configuration, analysisCoverage, 0),
    view: { query: 'scan', totalFindings: 0 }
  };
  const started = performance.now();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let deadline = started + result.configuration.limits.timeoutMs;
  let timer = setTimeout(() => controller.abort(), result.configuration.limits.timeoutMs);
  const budget: ReadBudget = { bytesRead: 0, maxBytes: result.configuration.limits.maxTotalBytes };
  const check = (): void => {
    if (performance.now() >= deadline) { controller.abort(); throw new InputError('SCAN_TIMEOUT', 'Total time limit reached.'); }
    signal.throwIfAborted();
  };
  const parser = new SourceParser();
  const analyzed: string[] = [];
  const textFiles: string[] = [];
  const textSources: TextFingerprint[] = [];
  const languages = new Map<string, ScanResult['languages'][number]>();
  const duplicationSources: DuplicationSource[] = [];
  let duplicationTokens = 0;
  let metricFunctions = 0;
  let duplicationIncomplete = false;
  let initialized = false;
  try {
    check();
    if ((await lstat(result.root)).isSymbolicLink()) throw new InputError('INVALID_ROOT', 'The root cannot be a symbolic link or junction.');
    result.root = await realpath(result.root);
    if (!(await lstat(result.root)).isDirectory()) throw new InputError('INVALID_ROOT', 'The root must be a directory.');
    result.configuration = await readConfiguration(result.root, signal, budget, options.profile);
    if (options.scope !== undefined) result.configuration.scope = validateScope(options.scope);
    if (result.configuration.scope.length) result.limitations.push('Analysis is restricted to configured scopes; the score and absence of findings do not assess the entire repository.');
    clearTimeout(timer);
    deadline = started + result.configuration.limits.timeoutMs;
    timer = setTimeout(() => controller.abort(), Math.max(1, deadline - performance.now()));
    budget.maxBytes = result.configuration.limits.maxTotalBytes;
    initialized = true;
    if (budget.bytesRead > budget.maxBytes) throw new InputError('TOTAL_BYTES_LIMIT', 'Total bytes read limit reached.');
    check();
    const discovery = await discover(result.root, result.configuration, result.diagnostics, signal, budget);
    result.files = discovery.files;
    result.ignoreFiles = discovery.ignoreFiles;
    result.coverage.discoveredFiles = discovery.files.length;
    result.coverage.skippedEntries = discovery.skipped;
    for (const file of discovery.files) {
      const language = sourceLanguage(file, result.configuration)!;
      const summary = languages.get(language.name) ?? { ...language, discoveredFiles: 0, analyzedFiles: 0 };
      summary.discoveredFiles++; languages.set(language.name, summary);
    }
    const configurations = [...languages.values()].some(language => language.mode === 'syntax') ? await readTSConfigurations(result.root, discovery.configs, result.configuration, result.diagnostics, signal, budget) : [];
    for (const file of discovery.files) {
      check();
      if (budget.bytesRead >= budget.maxBytes) throw new InputError('TOTAL_BYTES_LIMIT', 'Total bytes read limit reached.');
      if (result.dependencies.length >= result.configuration.limits.maxDependencies) throw new InputError('DEPENDENCY_LIMIT', 'Total reference limit reached.');
      try {
        const source = await safeRead(result.root, path.join(result.root, file), result.configuration.limits.maxFileBytes, signal, budget);
        if (source.includes('\0')) throw new InputError('BINARY_SOURCE', 'Binary content in a source extension; file not analyzed.');
        if (isGeneratedSource(source)) { result.coverage.skippedEntries++; continue; }
        const language = sourceLanguage(file, result.configuration)!;
        if (language.mode === 'text') {
          const metric = textMetric(file, source);
          result.metrics.push(metric); textFiles.push(file); textSources.push(textFingerprint(file, source, metric.lines));
          result.coverage.analyzedFiles++; languages.get(language.name)!.analyzedFiles++;
          continue;
        }
        const parsed = await parser.parse({ file, source, maxNodes: result.configuration.limits.maxAstNodes,
          maxDependencies: result.configuration.limits.maxDependencies - result.dependencies.length,
          maxDuplicationTokens: result.configuration.limits.maxDuplicationTokens - duplicationTokens,
          maxFunctions: result.configuration.limits.maxEntries - metricFunctions }, result.configuration.limits.maxParseTimeMs, signal);
        result.diagnostics.push(...parsed.diagnostics);
        duplicationTokens += parsed.duplicationTokensRead;
        if (parsed.generated) { result.coverage.skippedEntries++; continue; }
        if (parsed.valid) {
          analyzed.push(file); result.coverage.analyzedFiles++; languages.get(language.name)!.analyzedFiles++; for (const edge of parsed.dependencies) result.dependencies.push(edge);
          if (parsed.metrics) { result.metrics.push(parsed.metrics); metricFunctions += parsed.metrics.functions.length; }
          if (parsed.duplication) duplicationSources.push(parsed.duplication);
          duplicationIncomplete ||= !parsed.duplicationComplete;
        }
      } catch (error) {
        check();
        if (error instanceof InputError && error.code === 'TOTAL_BYTES_LIMIT') throw error;
        result.diagnostics.push(inputDiagnostic(error, file));
      }
    }
    check();
    const acquired = [...analyzed, ...textFiles];
    resolveDependencies(result.root, result.dependencies, acquired, configurations, result.configuration, result.diagnostics, check);
    const cycles = findRuntimeCycles(acquired, result.dependencies, result.configuration.limits.maxFindings, check);
    result.findings = cycles.findings;
    const baseCoverage: CategoryCoverage = result.diagnostics.length ? { status: 'partial', reason: 'Incomplete files, configuration or references.' } : { status: 'complete', reason: null };
    result.analysisCoverage.cycles = baseCoverage;
    if (cycles.truncated) result.diagnostics.push({ code: 'FINDING_LIMIT', severity: 'warning', message: 'Finding limit reached; other cyclic components were omitted.' });
    const project = await readProject(result.root, discovery.manifests, analyzed, configurations, result.configuration, result.diagnostics, signal, budget, check);
    result.entryPoints = project.entryPoints;
    const hasText = textFiles.length > 0;
    const usage = analyzeFileUsage(analyzed, result.dependencies, project.entryPoints, hasText || project.entryUncertainty || project.scriptUncertainty || result.diagnostics.length > 0, check);
    result.unusedFiles = usage.files;
    for (const file of textFiles) result.unusedFiles.push({ file, state: 'unknown', confidence: 'UNKNOWN', reason: 'Text analysis: dependencies and entry points for this language are not interpreted.' });
    for (const finding of usage.findings) result.findings.push(finding);
    result.analysisCoverage.unusedFiles = usage.coverage;
    const packages = analyzePackages(project.packages, result.dependencies, project.scriptTools, project.manifests, hasText || project.scriptUncertainty || project.entryUncertainty || result.diagnostics.length > 0, check);
    result.packages = packages.packages;
    for (const finding of packages.findings) result.findings.push(finding);
    result.analysisCoverage.packages = packages.coverage;
    for (const finding of analyzeSize(result.metrics, result.configuration.thresholds, check)) result.findings.push(finding);
    result.analysisCoverage.size = { ...baseCoverage };
    const duplication = analyzeDuplication(duplicationSources, result.configuration, check);
    result.duplicates = duplication.groups;
    for (const finding of duplication.findings) result.findings.push(finding);
    result.analysisCoverage.duplication = !duplication.complete || duplicationIncomplete || baseCoverage.status === 'partial' ? { status: 'partial', reason: 'Incomplete tokens, comparisons or acquisition; only demonstrated duplicates are reported.' } : { status: 'complete', reason: null };
    if (duplication.limit) result.diagnostics.push({ code: duplication.limit, severity: 'warning', message: 'Duplication work limit reached; partial result.' });
    if (hasText) {
      const textual = await analyzeTextDuplication(textSources, result.configuration, file => safeRead(result.root, path.join(result.root, file), result.configuration.limits.maxFileBytes, signal, budget), check);
      for (const group of textual.groups) result.duplicates.push(group);
      for (const finding of textual.findings) result.findings.push(finding);
      if (!textual.complete) result.diagnostics.push({ code: 'DUPLICATION_WORK_LIMIT', severity: 'warning', message: 'Text duplication verification limit reached.' });
      const reason = 'Dependencies, functions, packages and internal blocks are interpreted only for TS/JS; other languages have file metrics and whole-file text duplication.';
      result.limitations.push(reason);
      for (const category of ['cycles', 'unusedFiles', 'packages'] as const) result.analysisCoverage[category] = { status: analyzed.length ? 'partial' : 'unavailable', reason };
      result.analysisCoverage.size = { status: 'partial', reason: 'File lines measured; functions in other languages are not interpreted.' };
      result.analysisCoverage.duplication = { status: 'partial', reason: 'Other languages: only entirely identical files are compared; internal blocks are not interpreted.' };
    }
  } catch (error) {
    if (signal.aborted || error instanceof InputError && error.code === 'SCAN_TIMEOUT') {
      result.diagnostics.push({ code: options.signal?.aborted ? 'CANCELLED' : 'SCAN_TIMEOUT', severity: 'warning',
        message: options.signal?.aborted ? 'Scan cancelled.' : 'Total time limit reached.' });
    } else result.diagnostics.push(inputDiagnostic(error));
    result.coverage.status = initialized ? 'partial' : 'failed';
  } finally { clearTimeout(timer); await parser.close(); result.coverage.bytesRead = budget.bytesRead; }
  result.findings = contextualizeFindings(result.findings, result.metrics, result.entryPoints, result.dependencies, result.configuration.thresholds);
  // Apply the finding budget after relevance ordering: informational size
  // signals must not displace demonstrated cycles or application warnings.
  result.findings.sort((a, b) => Number(a.severity === 'info') - Number(b.severity === 'info') ||
    Number(b.ruleId === 'runtime-cycle') - Number(a.ruleId === 'runtime-cycle') ||
    rawFindingPenalty(b, result.configuration) - rawFindingPenalty(a, result.configuration) || compareText(a.ruleId, b.ruleId) || compareText(a.file, b.file) ||
    (a.line ?? 0) - (b.line ?? 0) || compareText(a.ruleId === 'runtime-cycle' ? '' : a.subject, b.ruleId === 'runtime-cycle' ? '' : b.subject));
  if (result.findings.length > result.configuration.limits.maxFindings) {
    result.findings.length = result.configuration.limits.maxFindings;
    result.diagnostics.push({ code: 'FINDING_LIMIT', severity: 'warning', message: 'Global finding limit reached; partial score and analyses.' });
  }
  if (result.coverage.status === 'complete' && result.diagnostics.length) result.coverage.status = 'partial';
  if (result.coverage.status !== 'complete') for (const category of Object.keys(result.analysisCoverage) as AnalysisCategory[]) {
    if (result.analysisCoverage[category].status === 'complete') result.analysisCoverage[category] = { status: 'partial', reason: 'Incomplete acquisition coverage.' };
  }
  result.view.totalFindings = result.findings.length;
  result.languages = [...languages.values()].sort((a, b) => compareText(a.name, b.name));
  result.duplicates.sort((a, b) => compareText(a.id, b.id));
  result.unusedFiles.sort((a, b) => compareText(a.file, b.file));
  result.metrics.sort((a, b) => compareText(a.file, b.file));
  result.score = calculateScore(result.findings, result.configuration, result.analysisCoverage, result.coverage.analyzedFiles);
  result.dependencies.sort((a, b) => compareText(a.from, b.from) || a.line - b.line || a.column - b.column || compareText(a.kind, b.kind));
  result.diagnostics.sort((a, b) => compareText(a.file ?? '', b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || compareText(a.code, b.code));
  return result;
}
