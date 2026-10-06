/** Public normalized model. No filesystem, parser or renderer dependencies. */
export type DependencyKind = 'runtime' | 'type-only';
export type DependencySyntax = 'import' | 're-export' | 'require' | 'dynamic-import' | 'import-type';
export type Resolution = 'internal' | 'external' | 'unresolved' | 'indeterminate';

export interface Dependency {
  from: string;
  line: number;
  column: number;
  specifier: string | null;
  kind: DependencyKind;
  syntax: DependencySyntax;
  resolution: Resolution;
  to: string | null;
  reason: string | null;
}

export interface Diagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export type Confidence = 'CONFIRMED' | 'LIKELY' | 'SUSPICIOUS' | 'UNKNOWN';
export type AnalysisCategory = 'cycles' | 'unusedFiles' | 'packages' | 'size' | 'duplication';
export interface CategoryCoverage { status: 'complete' | 'partial' | 'unavailable'; reason: string | null }
export interface FindingContext {
  role: 'application' | 'test' | 'migration' | 'tooling' | 'unknown';
  factor: number;
  reason: string;
}
export interface FindingBase {
  title: string;
  description: string;
  severity: 'warning' | 'info';
  confidence: Confidence;
  context?: FindingContext;
  file: string;
  line?: number;
  relatedFiles: string[];
  recommendation: string;
}
export interface CycleFinding extends FindingBase {
  ruleId: 'runtime-cycle';
  category: 'dependencies';
  confidence: 'CONFIRMED';
  line: number;
  evidence: { from: string; to: string; line: number; column: number }[];
}
export type AnalysisRule = 'potentially-unused-file' | 'potentially-unused-package' | 'oversized-file' | 'oversized-function' | 'duplicate-block';
export interface AnalysisFinding extends FindingBase {
  ruleId: AnalysisRule;
  category: 'unused' | 'packages' | 'size' | 'duplication';
  subject: string;
  evidence: { file: string; line?: number; column?: number; endLine?: number; detail: string }[];
}
export type Finding = CycleFinding | AnalysisFinding;

export interface Limits {
  maxFiles: number;
  maxEntries: number;
  maxDepth: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxParseTimeMs: number;
  maxAstNodes: number;
  maxDependencies: number;
  maxFindings: number;
  timeoutMs: number;
  maxDuplicationTokens: number;
  maxDuplicationBlocks: number;
  maxDuplicationComparisons: number;
}

export interface Configuration {
  profile: 'standard' | 'large';
  scope: string[];
  respectGitignore: boolean;
  sourceExtensions: string[];
  exclude: string[];
  entryPoints: string[];
  limits: Limits;
  thresholds: { fileLines: number; functionLines: number };
  duplication: { minTokens: number; minLines: number; minBytes: number };
  score: { weights: Record<'runtime-cycle' | AnalysisRule, number>; caps: Record<AnalysisCategory, number> };
}

export interface EntryPoint { file: string; reason: string; origin: 'configured' | 'public-api' | 'script' | 'test' | 'convention' | 'framework'; purpose?: 'application' | 'test' | 'tooling' }
export interface FileUsage { file: string; state: 'reachable' | 'candidate' | 'unknown'; confidence: Confidence; reason: string }
export type PackageSection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
export interface DeclaredPackage { name: string; manifest: string; directory: string; sections: PackageSection[] }
export interface PackageUsage {
  name: string; manifest: string; sections: PackageSection[];
  state: 'used' | 'candidate' | 'indirect' | 'unknown'; confidence: Confidence;
  evidence: { kind: 'runtime' | 'type-only' | 'script' | 'indirect' | 'unknown'; file: string; line?: number; detail: string }[];
}
export interface FunctionMetric { name: string; line: number; column: number; endLine: number; lines: number }
export interface FileMetric { file: string; lines: number; functions: FunctionMetric[] }
/** Adapter data consumed by duplication analysis, never serialized in reports. */
export interface NormalizedToken { hash: string; line: number; column: number; endLine: number }
export interface TokenBlock { start: number; end: number }
export interface DuplicationSource { file: string; tokens: NormalizedToken[]; blocks: TokenBlock[] }
export interface TextFingerprint { file: string; hash: string; bytes: number; lines: number }
export interface DuplicateGroup {
  id: string; tokens: number;
  method: 'tokens' | 'exact-text';
  bytes?: number;
  blocks: { file: string; line: number; column: number; endLine: number }[];
}
export interface Score {
  formulaVersion: '1.1'; status: 'complete' | 'partial' | 'unavailable';
  value: number | null; observedValue: number | null; explanation: string;
  confidenceFactors: Record<Confidence, number>;
  contributions: { key: string; ruleId: Finding['ruleId']; category: AnalysisCategory; file: string; confidence: Confidence; weight: number; contextFactor: number; rawPenalty: number; appliedPenalty: number }[];
  penalties: Record<AnalysisCategory, number>;
}

export interface ScanResult {
  schemaVersion: '1.3';
  root: string;
  limitations: string[];
  configuration: Configuration;
  coverage: {
    status: 'complete' | 'partial' | 'failed';
    discoveredFiles: number;
    analyzedFiles: number;
    skippedEntries: number;
    bytesRead: number;
  };
  files: string[];
  dependencies: Dependency[];
  findings: Finding[];
  diagnostics: Diagnostic[];
  entryPoints: EntryPoint[];
  unusedFiles: FileUsage[];
  packages: PackageUsage[];
  metrics: FileMetric[];
  duplicates: DuplicateGroup[];
  languages: { name: string; mode: 'syntax' | 'text'; discoveredFiles: number; analyzedFiles: number }[];
  ignoreFiles: string[];
  analysisCoverage: Record<AnalysisCategory, CategoryCoverage>;
  score: Score;
  view: { query: 'scan' | 'architecture' | 'duplicates' | 'dead-code'; totalFindings: number };
}

/** Codepoint order, independent of locale. */
export function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** A view of one canonical scan. The global score and diagnostic coverage are
 * retained; only findings are selected, so queries cannot alter the analysis. */
export function selectView(result: ScanResult, query: ScanResult['view']['query']): ScanResult {
  const findings = result.findings.filter(finding => query === 'scan' ||
    query === 'architecture' && finding.ruleId === 'runtime-cycle' ||
    query === 'duplicates' && finding.ruleId === 'duplicate-block' ||
    query === 'dead-code' && ['potentially-unused-file', 'potentially-unused-package'].includes(finding.ruleId));
  return { ...result, findings, view: { query, totalFindings: result.view.totalFindings } };
}
