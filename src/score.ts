import { compareText, type AnalysisCategory, type CategoryCoverage, type Configuration, type Finding, type Score } from './model.js';

const confidenceFactors: Score['confidenceFactors'] = { CONFIRMED: 1, LIKELY: 0.75, SUSPICIOUS: 0.25, UNKNOWN: 0 };
export function rawFindingPenalty(finding: Finding, configuration: Configuration): number {
  return Math.round(configuration.score.weights[finding.ruleId] * confidenceFactors[finding.confidence] * (finding.context?.factor ?? 1) * 1_000_000) / 1_000_000;
}
export function findingCategory(finding: Finding): AnalysisCategory {
  return finding.ruleId === 'runtime-cycle' ? 'cycles' : finding.category === 'unused' ? 'unusedFiles' : finding.category;
}

/** Pure scoring: one identity per defect; size is one conservative signal per
 * file. Category caps and the global 100-point cap are allocated in key order. */
export function calculateScore(findings: Finding[], configuration: Configuration, coverage: Record<AnalysisCategory, CategoryCoverage>, analyzedFiles: number): Score {
  const penalties: Score['penalties'] = { cycles: 0, unusedFiles: 0, packages: 0, size: 0, duplication: 0 };
  const identities = new Map<string, Score['contributions'][number]>();
  const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
  for (const finding of findings) {
    const category = findingCategory(finding);
    const identity = category === 'size' ? [category, finding.file] : finding.ruleId === 'runtime-cycle' ?
      [category, [...finding.relatedFiles].sort(compareText)] : [category, finding.file, finding.subject];
    const key = JSON.stringify(identity);
    const weight = configuration.score.weights[finding.ruleId];
    const contextFactor = finding.context?.factor ?? 1;
    const rawPenalty = rawFindingPenalty(finding, configuration);
    const contribution = { key, ruleId: finding.ruleId, category, file: finding.file, confidence: finding.confidence, weight, contextFactor, rawPenalty, appliedPenalty: 0 };
    const previous = identities.get(key);
    if (!previous || rawPenalty > previous.rawPenalty || rawPenalty === previous.rawPenalty && compareText(JSON.stringify(contribution), JSON.stringify(previous)) < 0) identities.set(key, contribution);
  }
  const contributions = [...identities.values()].sort((a, b) => compareText(a.key, b.key));
  let total = 0;
  for (const contribution of contributions) {
    // Quantize the ceiling down before rounding contributions, so precision
    // finer than six decimals cannot increase a configured cap.
    const cap = Math.floor(configuration.score.caps[contribution.category] * 1_000_000) / 1_000_000;
    contribution.appliedPenalty = rounded(Math.max(0, Math.min(contribution.rawPenalty, cap - penalties[contribution.category], 100 - total)));
    penalties[contribution.category] = rounded(penalties[contribution.category] + contribution.appliedPenalty);
    total = rounded(total + contribution.appliedPenalty);
  }
  const evaluated = Object.values(coverage).filter(category => category.status !== 'unavailable').length;
  const status = analyzedFiles === 0 || evaluated === 0 ? 'unavailable' : Object.values(coverage).every(category => category.status === 'complete') ? 'complete' : 'partial';
  const observedValue = status === 'unavailable' ? null : Math.round(Math.max(0, 100 - total) * 100) / 100;
  return { formulaVersion: '1.1', status, value: status === 'complete' ? observedValue : null, observedValue, confidenceFactors: { ...confidenceFactors }, contributions, penalties,
    explanation: `100 − sum of applied penalties; weight × confidence × context, category caps and a global cap of 100. Equivalent identities count once; size uses the highest penalty per file. Context and excess size are explicit heuristics, not proof of a defect. ${status === 'complete' ? 'All categories were assessed.' : status === 'partial' ? 'Provisional score: observedValue covers only the assessed scope and findings; value=null. Partial/unavailable categories do not establish overall health.' : 'No assessable files/categories: score unavailable.'}` };
}
