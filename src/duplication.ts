import { createHash } from 'node:crypto';
import { compareText, type AnalysisFinding, type Configuration, type DuplicateGroup, type DuplicationSource, type TextFingerprint, type TokenBlock } from './model.js';

/** Fingerprints only select candidates; exact duplication verifies reread text. */
export function textFingerprint(file: string, source: string, lines: number): TextFingerprint {
  return { file, hash: createHash('sha256').update(source).digest('hex'), bytes: Buffer.byteLength(source), lines };
}

interface Candidate { source: DuplicationSource; block: TokenBlock; hash: string }
/** Compare whole files and function bodies by exact token fingerprints. Hash
 * buckets generate candidates; full token equality verifies every occurrence. */
export function analyzeDuplication(sources: DuplicationSource[], config: Configuration, check: () => void = () => {}):
  { groups: DuplicateGroup[]; findings: AnalysisFinding[]; complete: boolean; limit: string | null } {
  const buckets = new Map<string, { representative: Candidate; occurrences: Candidate[] }[]>();
  let candidates = 0; let comparisons = 0; let limit: string | null = null;
  const spend = (): boolean => { check(); if (++comparisons > config.limits.maxDuplicationComparisons) { limit = 'DUPLICATION_WORK_LIMIT'; return false; } return true; };
  generation: for (const source of sources) {
    check();
    const prefix = [0]; const powers = [1];
    for (const token of source.tokens) {
      check();
      prefix.push((Math.imul(prefix.at(-1)!, 16_777_619) + Number.parseInt(token.hash.slice(0, 8), 16)) >>> 0);
      powers.push(Math.imul(powers.at(-1)!, 16_777_619) >>> 0);
    }
    const positions = new Set<string>();
    for (const block of source.blocks) {
      check();
      const length = block.end - block.start;
      const first = source.tokens[block.start]; const last = source.tokens[block.end - 1];
      if (!first || !last || length < config.duplication.minTokens || last.endLine - first.line + 1 < config.duplication.minLines) continue;
      const position = `${block.start}:${block.end}`; if (positions.has(position)) continue; positions.add(position);
      if (++candidates > config.limits.maxDuplicationBlocks) { limit = 'DUPLICATION_BLOCK_LIMIT'; break generation; }
      const hash = ((prefix[block.end]! - Math.imul(prefix[block.start]!, powers[length]!)) >>> 0).toString(16);
      const key = `${length}:${hash}`;
      const bucket = buckets.get(key) ?? [];
      const candidate = { source, block, hash };
      let matched = false;
      for (const group of bucket) {
        let equal = true;
        for (let i = 0; i < length; i++) {
          if (!spend()) break generation;
          if (source.tokens[block.start + i]!.hash !== group.representative.source.tokens[group.representative.block.start + i]!.hash) { equal = false; break; }
        }
        if (equal) { group.occurrences.push(candidate); matched = true; break; }
      }
      if (!matched) bucket.push({ representative: candidate, occurrences: [candidate] });
      buckets.set(key, bucket);
    }
  }
  const matches = [...buckets.values()].flat().filter(group => group.occurrences.length > 1);
  matches.sort((a, b) => (b.representative.block.end - b.representative.block.start) - (a.representative.block.end - a.representative.block.start) || compareText(a.representative.source.file, b.representative.source.file) || a.representative.block.start - b.representative.block.start);
  const selected = new Map<string, TokenBlock[]>();
  const groups: DuplicateGroup[] = [];
  selection: for (const match of matches) {
    const covered: boolean[] = [];
    for (const occurrence of match.occurrences) {
      let found = false;
      // Bounded interval scans suppress nested duplicate penalties;
      // add an interval index only if measured workloads exhaust this budget.
      for (const previous of selected.get(occurrence.source.file) ?? []) {
        if (!spend()) break selection;
        if (previous.start <= occurrence.block.start && previous.end >= occurrence.block.end) { found = true; break; }
      }
      covered.push(found);
    }
    if (covered.every(Boolean)) continue;
    const blocks = match.occurrences.map(({ source, block }) => ({ file: source.file, line: source.tokens[block.start]!.line, column: source.tokens[block.start]!.column, endLine: source.tokens[block.end - 1]!.endLine }))
      .sort((a, b) => compareText(a.file, b.file) || a.line - b.line || a.column - b.column);
    const length = match.representative.block.end - match.representative.block.start;
    groups.push({ id: `duplicate:${length}:${match.representative.hash}:${blocks[0]!.file}:${blocks[0]!.line}:${blocks[0]!.column}`, method: 'tokens', tokens: length, blocks });
    for (const occurrence of match.occurrences) { const intervals = selected.get(occurrence.source.file) ?? []; intervals.push(occurrence.block); selected.set(occurrence.source.file, intervals); }
  }
  groups.sort((a, b) => compareText(a.id, b.id));
  const findings: AnalysisFinding[] = groups.map(group => ({ ruleId: 'duplicate-block', category: 'duplication', subject: group.id,
    title: 'Blocks with identical tokens', description: `${group.blocks.length} occurrences of ${group.tokens} tokens, ignoring comments and whitespace outside literals. Identifiers and literals are preserved.`, severity: 'warning', confidence: 'CONFIRMED',
    file: group.blocks[0]!.file, line: group.blocks[0]!.line, relatedFiles: [...new Set(group.blocks.map(block => block.file))],
    evidence: group.blocks.map(block => ({ ...block, detail: 'Whole file or function body with a verified complete token sequence.' })),
    recommendation: 'Compare responsibilities and context before sharing implementation; no authorship inference or tolerance for internal renaming.' }));
  return { groups, findings, complete: limit === null, limit };
}

/** Linear fingerprint buckets; only duplicate candidates need byte verification. */
export async function analyzeTextDuplication(sources: TextFingerprint[], config: Configuration, read: (file: string) => Promise<string>, check: () => void): Promise<{ groups: DuplicateGroup[]; findings: AnalysisFinding[]; complete: boolean }> {
  const buckets = new Map<string, TextFingerprint[]>();
  for (const source of sources) {
    check();
    if (source.lines < config.duplication.minLines || source.bytes < config.duplication.minBytes) continue;
    const key = `${source.bytes}:${source.hash}`;
    const bucket = buckets.get(key) ?? []; bucket.push(source); buckets.set(key, bucket);
  }
  const groups: DuplicateGroup[] = []; const findings: AnalysisFinding[] = [];
  let comparisons = 0;
  for (const bucket of buckets.values()) {
    check();
    if (bucket.length < 2) continue;
    const first = bucket[0]!;
    const reference = await read(first.file);
    const valid = (source: string, fingerprint: TextFingerprint): boolean => {
      const current = textFingerprint(fingerprint.file, source, fingerprint.lines);
      return current.hash === fingerprint.hash && current.bytes === fingerprint.bytes;
    };
    if (!valid(reference, first)) throw new Error('Source changed during duplication verification');
    const blocks = [{ file: first.file, line: 1, column: 1, endLine: first.lines }];
    for (const candidate of bucket.slice(1)) {
      check();
      comparisons += candidate.bytes;
      if (comparisons > config.limits.maxDuplicationComparisons || groups.length >= config.limits.maxDuplicationBlocks) return { groups, findings, complete: false };
      const source = await read(candidate.file);
      if (!valid(source, candidate)) throw new Error('Source changed during duplication verification');
      if (source === reference) blocks.push({ file: candidate.file, line: 1, column: 1, endLine: candidate.lines });
    }
    if (blocks.length < 2) continue;
    const group: DuplicateGroup = { id: `duplicate-text:${first.hash}:${first.file}`, method: 'exact-text', tokens: 0, bytes: first.bytes, blocks };
    groups.push(group);
    findings.push({ ruleId: 'duplicate-block', category: 'duplication', subject: group.id, title: 'Files with identical full text',
      description: `${blocks.length} files of ${first.bytes} bytes with verified full content; whitespace and comments are preserved.`, severity: 'warning', confidence: 'CONFIRMED',
      file: first.file, line: 1, relatedFiles: blocks.map(block => block.file), evidence: blocks.map(block => ({ ...block, detail: 'Full UTF-8 text compared after safe rereading; does not imply equivalent responsibilities.' })),
      recommendation: 'Review context before sharing implementation; identical files may have legitimate uses.' });
  }
  return { groups, findings, complete: true };
}
