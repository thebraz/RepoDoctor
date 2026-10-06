import { isBuiltin } from 'node:module';
import { compareText, type AnalysisFinding, type CategoryCoverage, type Configuration, type DeclaredPackage, type Dependency, type EntryPoint, type FileMetric, type FileUsage, type Finding, type FindingContext, type PackageUsage } from './model.js';

function reachableFiles(files: string[], dependencies: Dependency[], seeds: string[], runtimeOnly: boolean, check: () => void): Set<string> {
  const adjacency = new Map(files.map(file => [file, new Set<string>()]));
  for (const edge of dependencies) if (edge.resolution === 'internal' && edge.to !== null && (!runtimeOnly || edge.kind === 'runtime')) adjacency.get(edge.from)?.add(edge.to);
  const reachable = new Set(seeds);
  const queue = [...reachable];
  for (let i = 0; i < queue.length; i++) {
    check();
    for (const file of adjacency.get(queue[i]!) ?? []) if (!reachable.has(file)) { reachable.add(file); queue.push(file); }
  }
  return reachable;
}

/** Reachability includes type edges: type consumers also make a file relevant. */
export function analyzeFileUsage(files: string[], dependencies: Dependency[], entries: EntryPoint[], uncertain: boolean, check: () => void = () => {}):
  { files: FileUsage[]; findings: AnalysisFinding[]; coverage: CategoryCoverage } {
  const reachable = reachableFiles(files, dependencies, entries.map(entry => entry.file), false, check);
  const noEntries = entries.length === 0;
  const dynamic = uncertain || dependencies.some(edge => ['indeterminate', 'unresolved'].includes(edge.resolution));
  const coverage: CategoryCoverage = noEntries ? { status: 'unavailable', reason: 'No known/configured entry point; absence of references does not prove redundancy.' } :
    dynamic ? { status: 'partial', reason: 'Dynamic loading, failures or unresolved entry points may reach other files.' } : { status: 'complete', reason: null };
  const findings: AnalysisFinding[] = [];
  const usage = files.map((file): FileUsage => {
    check();
    if (reachable.has(file)) return { file, state: 'reachable', confidence: 'CONFIRMED', reason: 'Reached from a known entry point, including type-only references.' };
    if (noEntries) return { file, state: 'unknown', confidence: 'UNKNOWN', reason: coverage.reason! };
    const confidence = dynamic ? 'SUSPICIOUS' : 'LIKELY';
    const reason = dynamic ? 'Not reached statically; indeterminate references prevent a strong conclusion.' : 'No path from known entry points in the analyzed static graph.';
    findings.push({ ruleId: 'potentially-unused-file', category: 'unused', subject: file, title: 'Potentially unused file', description: `${reason} Indirect or external usage remains possible.`, severity: 'warning', confidence,
      file, relatedFiles: [], evidence: [{ file, detail: `Entry points considered: ${entries.length}; absence of a static path, not proof of redundancy.` }], recommendation: 'Check external consumers, conventions and dynamic loading before removing the file.' });
    return { file, state: 'candidate', confidence, reason };
  });
  usage.sort((a, b) => compareText(a.file, b.file));
  return { files: usage, findings, coverage };
}

export function packageNameOf(specifier: string): string | null {
  if (!specifier || /^(?:\.|\/|#|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) ? name : null;
}

export function analyzeSize(metrics: FileMetric[], thresholds: Configuration['thresholds'], check: () => void = () => {}): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  for (const metric of metrics) {
    check();
    if (metric.lines > thresholds.fileLines) findings.push({ ruleId: 'oversized-file', category: 'size', subject: metric.file,
      title: 'File exceeds the line limit', description: `${metric.lines} physical lines; configured limit: ${thresholds.fileLines}.`, severity: 'warning', confidence: 'CONFIRMED', file: metric.file, line: 1, relatedFiles: [],
      evidence: [{ file: metric.file, line: 1, endLine: metric.lines, detail: 'Count includes blank lines and comments; the final empty line after a newline is not counted.' }],
      recommendation: 'Review cohesion and split only genuinely distinct responsibilities; size alone does not justify new files.' });
    for (const fn of metric.functions) {
      check();
      if (fn.lines > thresholds.functionLines) findings.push({ ruleId: 'oversized-function', category: 'size', subject: `${fn.name}:${fn.line}:${fn.column}`,
        title: 'Function exceeds the line limit', description: `${fn.name}: ${fn.lines} lines from signature to end; configured limit: ${thresholds.functionLines}.`, severity: 'warning', confidence: 'CONFIRMED', file: metric.file, line: fn.line, relatedFiles: [],
        evidence: [{ file: metric.file, line: fn.line, column: fn.column, endLine: fn.endLine, detail: 'Inclusive physical range of a function with a body; ambient declarations and signatures without bodies are excluded.' }],
        recommendation: 'Review responsibilities and clarity before extracting functions; do not fragment code just to reduce the count.' });
    }
  }
  return findings;
}

/** Interpret structural signals without suppressing evidence. Path conventions
 * are hints: a runtime path from an application entry overrides test/migration
 * labels. Real cycles retain their full weight regardless of the file role. */
export function contextualizeFindings(findings: Finding[], metrics: FileMetric[], entries: EntryPoint[], dependencies: Dependency[], thresholds: Configuration['thresholds']): Finding[] {
  const tests = new Set(entries.filter(entry => entry.origin === 'test' || entry.purpose === 'test').map(entry => entry.file));
  const tools = new Set(entries.filter(entry => entry.origin === 'script' && entry.purpose !== 'application' || entry.origin === 'framework' && /\.config\.[cm]?[jt]s$/.test(entry.file)).map(entry => entry.file));
  const testPath = (file: string): boolean => tests.has(file) || /(?:^|\/)(?:test|tests|__tests__|e2e)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)scripts\/(?:test|check)[-_][^/]+\.[^/]+$/.test(file);
  const production = entries.filter(entry => entry.origin === 'configured' || entry.origin === 'public-api' || entry.origin === 'convention' || entry.purpose === 'application' ||
    entry.origin !== 'test' && !testPath(entry.file) && !tools.has(entry.file)).map(entry => entry.file);
  const runtime = reachableFiles(metrics.map(metric => metric.file), dependencies, production, true, () => {});
  const roleOf = (file: string): FindingContext['role'] => runtime.has(file) ? 'application' : testPath(file) ? 'test' :
    /(?:^|\/)(?:migrations|db\/migration)\/.*\.sql$/i.test(file) ? 'migration' : tools.has(file) ? 'tooling' :
    /(?:^|\/)(?:src|app|lib|components|services)\//.test(file) ? 'application' : 'unknown';
  const byFile = new Map(metrics.map(metric => [metric.file, metric]));
  const functions = new Map<string, number>();
  for (const metric of metrics) for (const fn of metric.functions) functions.set(JSON.stringify([metric.file, fn.line, fn.column]), fn.lines);
  const roleReasons: Record<FindingContext['role'], string> = {
    application: 'Application code or code reached from a runtime entry point; test conventions do not reduce its impact.',
    test: 'Test convention with no known runtime path from the application; extensive scenarios do not prove excessive responsibility.',
    migration: 'SQL in a migrations directory; history and atomicity may justify a long file. Do not split an applied migration to meet the limit.',
    tooling: 'Script/tool configuration entry point; maintenance review remains relevant, with reduced impact.',
    unknown: 'Role lacks sufficient evidence; no exception was granted for absence of references.'
  };
  return findings.map(finding => {
    let role = roleOf(finding.file);
    // A mixed duplicate/cycle cannot get a discount from whichever path sorts first.
    const roles = [role, ...finding.relatedFiles.map(roleOf)];
    if (roles.includes('application')) role = 'application';
    else if (roles.includes('unknown')) role = 'unknown';
    else if (roles.includes('tooling')) role = 'tooling';
    else if (roles.includes('test')) role = 'test';
    let factor = 1;
    let reason = roleReasons[role];
    let informational = false;
    if (finding.category === 'size') {
      const limit = finding.ruleId === 'oversized-file' ? thresholds.fileLines : thresholds.functionLines;
      const lines = finding.ruleId === 'oversized-file' ? byFile.get(finding.file)?.lines :
        functions.get(JSON.stringify([finding.file, finding.line, finding.ruleId === 'oversized-function' ? finding.evidence[0]?.column : undefined]));
      const excess = lines === undefined ? 1 : Math.min(1, Math.max(0, lines / limit - 1));
      const roleFactor = role === 'migration' ? 0 : role === 'test' ? 0.25 : role === 'tooling' ? 0.5 : 1;
      factor = Math.round(excess * roleFactor * 1_000_000) / 1_000_000;
      informational = role === 'migration' || excess <= 0.2 || roleFactor < 1 && lines !== undefined && lines < limit * 4;
      reason += ` Size: excess factor ${Math.round(excess * 1_000_000) / 1_000_000} × role factor ${roleFactor}; excess up to 20% is informational, and full weight requires at least twice the limit. Tests/tools at four times the limit remain review warnings.`;
    } else if (finding.ruleId === 'duplicate-block' && role === 'test') {
      factor = 0.5; reason += ' Duplication in test scenarios receives half weight; application copies retain full weight.';
    } else if (finding.ruleId === 'potentially-unused-file' && role === 'tooling') {
      factor = 0.5; reason += ' A tool entry point may have consumers outside the graph.';
    } else if (finding.ruleId === 'runtime-cycle') reason += ' A demonstrated cycle retains full weight, including in tests and tools.';
    return { ...finding, severity: informational ? 'info' : 'warning', context: { role, factor, reason },
      recommendation: role === 'migration' && finding.category === 'size' ? 'Preserve historical order and atomicity. Review new migrations by the required operation, without splitting already applied migrations just for size.' : finding.recommendation };
  });
}

export function analyzePackages(declared: DeclaredPackage[], dependencies: Dependency[], tools: { name: string; manifest: string; script: string }[], manifests: number, incomplete: boolean, check: () => void = () => {}):
  { packages: PackageUsage[]; findings: AnalysisFinding[]; coverage: CategoryCoverage } {
  const packages: PackageUsage[] = declared.map(pkg => ({ name: pkg.name, manifest: pkg.manifest, sections: pkg.sections, state: 'unknown', confidence: 'UNKNOWN', evidence: [] }));
  const byName = new Map<string, number[]>();
  for (let i = 0; i < declared.length; i++) { const indexes = byName.get(declared[i]!.name) ?? []; indexes.push(i); byName.set(declared[i]!.name, indexes); }
  for (const indexes of byName.values()) indexes.sort((a, b) => declared[b]!.directory.length - declared[a]!.directory.length || compareText(declared[a]!.manifest, declared[b]!.manifest));
  for (const edge of dependencies) {
    check();
    if (edge.resolution !== 'external' || edge.specifier === null) continue;
    const name = packageNameOf(edge.specifier); if (!name) continue;
    const index = byName.get(name)?.find(i => !declared[i]!.directory || edge.from.startsWith(`${declared[i]!.directory}/`));
    if (index === undefined) continue;
    packages[index]!.evidence.push({ kind: isBuiltin(edge.specifier) ? 'unknown' : edge.kind, file: edge.from, line: edge.line,
      detail: isBuiltin(edge.specifier) ? 'Node.js built-in module name; the reference does not confirm usage of a package with the same name. A bundler/polyfill may alter resolution.' : `Static reference to the package or subpath (${edge.kind}).` });
  }
  const byIdentity = new Map(packages.map((pkg, i) => [JSON.stringify([pkg.manifest, pkg.name]), i]));
  for (const tool of tools) {
    check();
    const index = byIdentity.get(JSON.stringify([tool.manifest, tool.name]));
    if (index !== undefined) packages[index]!.evidence.push({ kind: 'script', file: tool.manifest, detail: `Tool referenced by script ${tool.script}; script not executed.` });
  }
  const uncertain = incomplete || dependencies.some(edge => ['indeterminate', 'unresolved'].includes(edge.resolution));
  const findings: AnalysisFinding[] = [];
  for (const pkg of packages) {
    check();
    if (pkg.evidence.some(evidence => ['runtime', 'type-only', 'script'].includes(evidence.kind))) { pkg.state = 'used'; pkg.confidence = 'CONFIRMED'; }
    else if (pkg.evidence.length) { pkg.state = 'unknown'; pkg.confidence = 'UNKNOWN'; }
    else if (pkg.sections.includes('peerDependencies') || pkg.sections.includes('optionalDependencies') || pkg.name.startsWith('@types/')) {
      pkg.state = 'indirect'; pkg.confidence = pkg.name.startsWith('@types/') ? 'LIKELY' : 'UNKNOWN';
      pkg.evidence.push({ kind: 'indirect', file: pkg.manifest, detail: pkg.name.startsWith('@types/') ? 'A declaration package may be included automatically by TypeScript; absence of an import does not prove redundancy.' : 'A peer/optional contract may be consumed by third parties or conditional loading; absence of an import is insufficient.' });
    } else if (uncertain) {
      pkg.state = 'unknown'; pkg.confidence = 'UNKNOWN';
      pkg.evidence.push({ kind: 'unknown', file: pkg.manifest, detail: 'Indeterminate references or scripts prevent concluding that usage is absent.' });
    } else {
      pkg.state = 'candidate'; pkg.confidence = 'SUSPICIOUS';
      const detail = `No static references or recognized script tools; declared in ${pkg.sections.join(', ')}. Indirect consumption remains possible.`;
      pkg.evidence.push({ kind: 'unknown', file: pkg.manifest, detail });
      findings.push({ ruleId: 'potentially-unused-package', category: 'packages', subject: pkg.name, title: 'Potentially unused dependency', description: `${pkg.name}: ${detail}`, severity: 'warning', confidence: 'SUSPICIOUS', file: pkg.manifest, relatedFiles: [], evidence: [{ file: pkg.manifest, detail }], recommendation: 'Check plugins, configuration, external consumers and tools before removing the dependency.' });
    }
    pkg.evidence = [...new Map(pkg.evidence.map(evidence => [JSON.stringify(evidence), evidence])).values()].sort((a, b) => compareText(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || compareText(a.kind, b.kind) || compareText(a.detail, b.detail));
  }
  return { packages, findings, coverage: manifests === 0 ? { status: 'unavailable', reason: 'No package.json in scope; package declarations are unknown.' } : uncertain || packages.some(pkg => pkg.state === 'unknown') ? { status: 'partial', reason: 'References, manifests, indeterminate scripts or ambiguous built-in names limit usage analysis.' } : { status: 'complete', reason: null } };
}
