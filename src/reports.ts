import { createHash } from 'node:crypto';
import type { ScanResult } from './model.js';

function redact(value: string): string {
  return /^\[redacted:[a-f0-9]{12}\]$/.test(value) ? value : `[redacted:${createHash('sha256').update(value).digest('hex').slice(0, 12)}]`;
}

/** Never include source snippets. Redact secret-shaped text in paths/specifiers too. */
export function safeText(text: string): string {
  return text
    .replace(/\b(?:sk-(?:proj-)?[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|AKIA[A-Z0-9]{16})\b/g, redact)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, redact)
    .replace(/(https?:\/\/)([^\s/@]+)@/gi, (_match: string, scheme: string, credentials: string) => `${scheme}${redact(credentials)}@`)
    .replace(/\b(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi, (_match: string, label: string, token: string) => `${label}${redact(token)}`)
    // Quoted labels/values occur in literal method names too. Consume escaped
    // quotes and unterminated values so a secret's remaining words cannot leak.
    .replace(/((?:password|passwd|token|api[_-]?key|secret|authorization|access[_-]?key)["']?\s*[=:]\s*)("(?:\\[\s\S]|[^"\\])*\\?(?:"|$)|'(?:\\[\s\S]|[^'\\])*\\?(?:'|$)|\[redacted:[a-f0-9]{12}\]|[^\s&/]+)/gi, (_match: string, label: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : '';
      const secret = quote ? value.slice(1, value.endsWith(quote) ? -1 : undefined) : value;
      return `${label}${quote}${redact(secret)}${quote}`;
    })
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, character => `[U+${character.charCodeAt(0).toString(16).padStart(4, '0')}]`);
}

export function renderJSON(result: ScanResult): string {
  return JSON.stringify(result, (_key: string, value: unknown) => typeof value === 'string' ? safeText(value) : value, 2) + '\n';
}
function scoreText(result: ScanResult): string {
  return result.score.status === 'complete' ? `${result.score.value}/100` : result.score.status === 'partial' ? `${result.score.observedValue}/100 · provisional (partial coverage)` : 'unavailable (no assessable analysis)';
}
const roleLabels = { application: 'application', test: 'test', migration: 'migration', tooling: 'tooling', unknown: 'unknown' };
export function renderTerminal(result: ScanResult, details = false): string {
  if (details) return renderTerminalDetails(result);
  const lines = [`RepoDoctor · schema ${result.schemaVersion}`, `Root: ${safeText(result.root)}`,
    `Scope: ${result.configuration.scope.map(safeText).join(', ') || 'repository'} · profile ${result.configuration.profile}`,
    `Coverage: ${result.coverage.status} · ${result.coverage.analyzedFiles}/${result.coverage.discoveredFiles} files · ${result.coverage.skippedEntries} entries skipped`,
    `Structural score: ${scoreText(result)}`,
    `Query: ${result.view.query} · ${result.findings.length}/${result.view.totalFindings} findings · ${result.dependencies.length} dependencies`,
    `Languages: ${result.languages.map(language => `${safeText(language.name)} ${language.analyzedFiles}/${language.discoveredFiles} [${language.mode}]`).join(', ') || 'no recognized sources'}`,
    `Ignore files: ${result.ignoreFiles.map(safeText).join(', ') || 'default/configured exclusions only'}`, '', 'Review priorities (up to 20):'];
  const priorities = result.findings.filter(finding => finding.severity !== 'info');
  const informational = result.findings.filter(finding => finding.severity === 'info');
  for (const finding of priorities.slice(0, 20)) {
    lines.push(`  [${finding.severity}/${finding.confidence}] ${finding.ruleId} · ${safeText(finding.file)}${finding.line === undefined ? '' : `:${finding.line}`} · ${safeText(finding.title)}`,
      `    ${safeText(finding.description)}`, `    ${safeText(finding.recommendation)}`);
    if (finding.context) lines.push(`    Context: ${roleLabels[finding.context.role]} · factor ${finding.context.factor} (explanation in --details)`);
    for (const evidence of finding.evidence.slice(0, 2)) lines.push('from' in evidence ? `    ${safeText(evidence.from)}:${evidence.line} → ${safeText(evidence.to)}` : `    ${safeText(evidence.file)}${evidence.line === undefined ? '' : `:${evidence.line}`} · ${safeText(evidence.detail)}`);
  }
  if (!priorities.length) lines.push('  No priorities found in the assessed scope. Check coverage before concluding that there are no issues.');
  if (priorities.length > 20) lines.push(`  ${priorities.length - 20} more findings in the full report.`);
  lines.push('', `Context notices: ${informational.length} · retained in the full report`);
  for (const finding of informational.slice(0, 5)) lines.push(`  [info/${finding.confidence}] ${finding.ruleId} · ${safeText(finding.file)}${finding.line === undefined ? '' : `:${finding.line}`} · ${roleLabels[finding.context?.role ?? 'unknown']} · factor ${finding.context?.factor ?? 1}`);
  if (informational.length > 5) lines.push(`  ${informational.length - 5} more notices in --details or --format json|html.`);
  if (result.score.status === 'partial') lines.push('', 'Provisional score calculated only from assessed findings; partial categories may contain undetected issues.');
  lines.push('', 'Coverage by category:');
  for (const [category, coverage] of Object.entries(result.analysisCoverage)) lines.push(`  ${category}: ${coverage.status}${coverage.reason ? ` · ${safeText(coverage.reason)}` : ''}`);
  const diagnostics = new Map<string, typeof result.diagnostics>();
  for (const item of result.diagnostics) { const group = diagnostics.get(item.code) ?? []; group.push(item); diagnostics.set(item.code, group); }
  lines.push('', `Diagnostics: ${result.diagnostics.length}`);
  for (const [code, group] of [...diagnostics].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    lines.push(`  ${safeText(code)} × ${group.length} · ${safeText(group[0]!.message)}`);
    for (const item of group.slice(0, 3)) if (item.file) lines.push(`    ${safeText(item.file)}${item.line === undefined ? '' : `:${item.line}`}`);
  }
  lines.push('', 'For the full graph, metrics, evidence and calculation: --details or --format json|html.');
  return lines.join('\n') + '\n';
}

function renderTerminalDetails(result: ScanResult): string {
  const location = (file: string, line?: number): string => `${safeText(file)}${line === undefined ? '' : `:${line}`}`;
  const lines = [
    `RepoDoctor · schema ${result.schemaVersion}`, `Root: ${safeText(result.root)}`,
    `Coverage: ${result.coverage.status} · ${result.coverage.analyzedFiles}/${result.coverage.discoveredFiles} files analyzed · ${result.coverage.bytesRead} bytes · ${result.coverage.skippedEntries} entries skipped`,
    `Query: ${result.view.query} · ${result.findings.length}/${result.view.totalFindings} findings · Overall score: ${scoreText(result)}`,
    `Dependencies: ${result.dependencies.length} · Cycles: ${result.findings.filter(finding => finding.ruleId === 'runtime-cycle').length} · Diagnostics: ${result.diagnostics.length}`,
    `Exclusions: ${result.configuration.exclude.map(safeText).join(', ')}`,
    `Limits: ${Object.entries(result.configuration.limits).map(([key, value]) => `${key}=${value}`).join(', ')}`,
    `V1 configuration: ${JSON.stringify({ entryPoints: result.configuration.entryPoints, thresholds: result.configuration.thresholds, duplication: result.configuration.duplication, score: result.configuration.score }, (_key: string, value: unknown) => typeof value === 'string' ? safeText(value) : value)}`,
    `Profile: ${result.configuration.profile} · Scopes: ${result.configuration.scope.map(safeText).join(', ') || 'repository'}`,
    `Languages: ${result.languages.map(language => `${safeText(language.name)} [${language.mode}] ${language.analyzedFiles}/${language.discoveredFiles}`).join(', ')}`,
    `Ignore files: ${result.ignoreFiles.map(safeText).join(', ')}`,
    '', 'Files:', ...result.files.map(file => `  ${safeText(file)}`), '', 'Dependencies:'
  ];
  for (const edge of result.dependencies) lines.push(`  ${location(edge.from, edge.line)}:${edge.column} [${edge.kind}/${edge.syntax}/${edge.resolution}] ${safeText(edge.specifier ?? '(indeterminate)')} → ${safeText(edge.to ?? edge.reason ?? '(external)')}`);
  lines.push('', 'Findings:');
  for (const finding of result.findings) {
    lines.push(`  [${finding.severity}/${finding.confidence}] ${finding.ruleId} · ${location(finding.file, finding.line)} · ${safeText(finding.title)}`, `    ${safeText(finding.description)}`);
    if (finding.ruleId === 'runtime-cycle') for (const evidence of finding.evidence) lines.push(`    ${location(evidence.from, evidence.line)}:${evidence.column} → ${safeText(evidence.to)}`);
    else for (const evidence of finding.evidence) lines.push(`    ${location(evidence.file, evidence.line)}${evidence.column === undefined ? '' : `:${evidence.column}`}${evidence.endLine === undefined ? '' : `–${evidence.endLine}`} · ${safeText(evidence.detail)}`);
    lines.push(`    Related files: ${finding.relatedFiles.map(safeText).join(', ')}`, `    Recommendation: ${safeText(finding.recommendation)}`);
    if (finding.context) lines.push(`    Context: ${roleLabels[finding.context.role]} · factor ${finding.context.factor} · ${safeText(finding.context.reason)}`);
  }
  lines.push('', 'Entry points:');
  for (const entry of result.entryPoints) lines.push(`  ${safeText(entry.file)} [${entry.origin}] · ${safeText(entry.reason)}`);
  lines.push('', 'File usage:');
  for (const file of result.unusedFiles) lines.push(`  ${safeText(file.file)} [${file.state}/${file.confidence}] · ${safeText(file.reason)}`);
  lines.push('', 'Declared packages:');
  for (const pkg of result.packages) {
    lines.push(`  ${safeText(pkg.name)} · ${safeText(pkg.manifest)} [${pkg.state}/${pkg.confidence}] · ${pkg.sections.join(', ')}`);
    for (const evidence of pkg.evidence) lines.push(`    ${location(evidence.file, evidence.line)} [${evidence.kind}] · ${safeText(evidence.detail)}`);
  }
  lines.push('', 'Metrics (physical lines):');
  for (const metric of result.metrics) {
    lines.push(`  ${safeText(metric.file)}: ${metric.lines} lines`);
    for (const fn of metric.functions) lines.push(`    ${safeText(fn.name)} · ${fn.line}:${fn.column}–${fn.endLine}: ${fn.lines} lines`);
  }
  lines.push('', 'Duplication groups:');
  for (const group of result.duplicates) lines.push(`  ${safeText(group.id)} · ${group.method === 'exact-text' ? `${group.bytes} bytes of full text` : `${group.tokens} tokens`}`, ...group.blocks.map(block => `    ${location(block.file, block.line)}:${block.column}–${block.endLine}`));
  lines.push('', 'Coverage by category:');
  for (const [category, coverage] of Object.entries(result.analysisCoverage)) lines.push(`  ${category}: ${coverage.status}${coverage.reason === null ? '' : ` · ${safeText(coverage.reason)}`}`);
  lines.push('', `Overall score · formula ${result.score.formulaVersion}: ${scoreText(result)}`, `  ${safeText(result.score.explanation)}`, `  Factors: ${JSON.stringify(result.score.confidenceFactors)}`, `  Penalties: ${JSON.stringify(result.score.penalties)}`);
  for (const contribution of result.score.contributions) lines.push(`  ${safeText(contribution.key)} · ${contribution.ruleId} [${contribution.confidence}] · weight ${contribution.weight} · context ${contribution.contextFactor} · raw ${contribution.rawPenalty} · applied ${contribution.appliedPenalty}`);
  lines.push('', 'Diagnostics:');
  for (const diagnostic of result.diagnostics) lines.push(`  [${diagnostic.severity}] ${safeText(diagnostic.code)}${diagnostic.file === undefined ? '' : ` · ${location(diagnostic.file, diagnostic.line)}`} · ${safeText(diagnostic.message)}`);
  lines.push('', 'Limitations:', ...result.limitations.map(item => `  ${safeText(item)}`));
  return lines.join('\n') + '\n';
}

/** Escaping applies after redaction, including the complete canonical report.
 * No target text appears in attributes, URLs, scripts or styles. */
export function renderHTML(result: ScanResult): string {
  const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const text = (value: string): string => escape(safeText(value));
  const findingCard = (finding: ScanResult['findings'][number]): string => `<article><p class="tag">${text(finding.ruleId)} · ${text(finding.confidence)} · ${text(finding.severity)}</p><h3>${text(finding.title)}</h3><p class="location">${text(finding.file)}${finding.line === undefined ? '' : `:${finding.line}`}</p><p>${text(finding.description)}</p>${finding.context ? `<p>Context: ${text(roleLabels[finding.context.role])} · factor ${finding.context.factor}. ${text(finding.context.reason)}</p>` : ''}<ul>${finding.evidence.map(evidence => 'from' in evidence ? `<li>${text(evidence.from)}:${evidence.line}:${evidence.column} → ${text(evidence.to)}</li>` : `<li>${text(evidence.file)}${evidence.line === undefined ? '' : `:${evidence.line}`}${evidence.endLine === undefined ? '' : `–${evidence.endLine}`} · ${text(evidence.detail)}</li>`).join('')}</ul><p>${text(finding.recommendation)}</p></article>`;
  const findings = result.findings.filter(finding => finding.severity !== 'info').map(findingCard).join('\n');
  const informational = result.findings.filter(finding => finding.severity === 'info').map(findingCard).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>RepoDoctor · report</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#101827;color:#edf2f7}body{max-width:1050px;margin:auto;padding:32px 20px;line-height:1.55}h1{font-size:2.4rem;margin:0}h2{margin-top:32px}h3{margin:.4em 0}.muted,.location{color:#b4c4d6;overflow-wrap:anywhere}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin:24px 0}.card,article,details{background:#1b293c;border:1px solid #36506a;border-radius:12px;padding:20px}article{margin:16px 0}.card strong{font-size:1.35rem;display:block}.tag{color:#8fe0ce;font-size:.9rem;margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem}summary{cursor:pointer;font-weight:600}li{overflow-wrap:anywhere}@media print{:root{color-scheme:light;background:white;color:#162435}.card,article,details{background:white;border-color:#aaa}.muted,.location{color:#455468}body{max-width:none;padding:0}}</style></head>
<body><header><p class="tag">RepoDoctor · schema ${result.schemaVersion}</p><h1>Repository structural health</h1><p class="muted">${text(result.root)}</p></header>
<div class="cards"><div class="card">Structural score<strong>${text(scoreText(result))}</strong><span>Formula ${result.score.formulaVersion}</span></div><div class="card">Files processed<strong>${result.coverage.status}</strong>${result.coverage.analyzedFiles}/${result.coverage.discoveredFiles} files analyzed</div><div class="card">Query ${result.view.query}<strong>${result.findings.filter(finding => finding.severity !== 'info').length} priorities · ${result.findings.filter(finding => finding.severity === 'info').length} informational</strong>${result.view.totalFindings} in the overall result · ${result.diagnostics.length} diagnostics</div></div>
<p>Scope: ${text(result.configuration.scope.join(', ') || 'repository')} · profile ${result.configuration.profile}</p><p>Languages: ${result.languages.map(language => `${text(language.name)} [${language.mode}] ${language.analyzedFiles}/${language.discoveredFiles}`).join(', ')}</p><p>${text(result.score.explanation)}</p><h2>Review priorities</h2>${findings || '<p>No priorities selected. Check coverage before concluding that there are no issues.</p>'}
${informational ? `<details><summary>Context notices (${result.findings.filter(finding => finding.severity === 'info').length})</summary>${informational}</details>` : ''}
<h2>Coverage and limitations</h2><ul>${Object.entries(result.analysisCoverage).map(([category, coverage]) => `<li>${text(category)}: ${coverage.status}${coverage.reason === null ? '' : ` · ${text(coverage.reason)}`}</li>`).join('')}${result.limitations.map(limitation => `<li>${text(limitation)}</li>`).join('')}</ul>
<h2>Data and evidence</h2><details><summary>Full report: graph, entry points, packages, metrics, duplicates, diagnostics and calculation</summary><pre>${escape(renderJSON(result))}</pre></details>
<p class="muted">Local static analysis. Findings guide review; no target files are modified.</p></body></html>\n`;
}
export function exitCode(result: ScanResult): number { return result.coverage.status !== 'complete' ? 2 : result.findings.length ? 1 : 0; }
