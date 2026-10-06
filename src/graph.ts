import { compareText, type Dependency, type CycleFinding } from './model.js';

/** Iterative SCC detection; one reproducible cycle per strongly connected component. */
export function findRuntimeCycles(files: string[], dependencies: Dependency[], maxFindings: number, check: () => void = () => {}):
  { findings: CycleFinding[]; truncated: boolean } {
  const adjacency = new Map(files.map(file => [file, [] as Dependency[]]));
  const reverse = new Map(files.map(file => [file, [] as string[]]));
  for (const edge of dependencies) {
    check();
    if (edge.kind !== 'runtime' || edge.resolution !== 'internal' || edge.to === null) continue;
    adjacency.get(edge.from)?.push(edge);
    reverse.get(edge.to)?.push(edge.from);
  }
  for (const edges of adjacency.values()) edges.sort((a, b) => compareText(a.to ?? '', b.to ?? '') || a.line - b.line || a.column - b.column);
  const visited = new Set<string>();
  const finished: string[] = [];
  for (const start of files) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack = [{ file: start, next: 0 }];
    while (stack.length) {
      check();
      const frame = stack[stack.length - 1]!;
      const edge = adjacency.get(frame.file)?.[frame.next++];
      if (!edge) { finished.push(frame.file); stack.pop(); continue; }
      if (edge.to !== null && !visited.has(edge.to)) { visited.add(edge.to); stack.push({ file: edge.to, next: 0 }); }
    }
  }
  visited.clear();
  const components: string[][] = [];
  for (const start of finished.reverse()) {
    if (visited.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      check();
      const file = stack.pop()!;
      component.push(file);
      for (const from of reverse.get(file) ?? []) {
        if (!visited.has(from)) { visited.add(from); stack.push(from); }
      }
    }
    component.sort(compareText);
    if (component.length > 1 || adjacency.get(start)?.some(edge => edge.to === start)) components.push(component);
  }
  components.sort((a, b) => compareText(a[0]!, b[0]!));
  const findings: CycleFinding[] = [];
  for (const component of components.slice(0, maxFindings)) {
    const start = component[0]!;
    const members = new Set(component);
    const first = adjacency.get(start)!.find(edge => edge.to !== null && members.has(edge.to))!;
    const path = [first];
    if (first.to !== start) {
      // A shortest return path proves the cycle without enumerating exponentially many cycles.
      const queue = [first.to!];
      const parents = new Map<string, Dependency>();
      const seen = new Set(queue);
      for (let i = 0; i < queue.length && !parents.has(start); i++) {
        check();
        for (const edge of adjacency.get(queue[i]!) ?? []) {
          if (edge.to !== null && members.has(edge.to) && !seen.has(edge.to)) {
            seen.add(edge.to); parents.set(edge.to, edge); queue.push(edge.to);
          }
        }
      }
      const back: Dependency[] = [];
      let cursor = start;
      while (cursor !== first.to) { const edge = parents.get(cursor)!; back.push(edge); cursor = edge.from; }
      path.push(...back.reverse());
    }
    findings.push({
      ruleId: 'runtime-cycle', category: 'dependencies', title: 'Runtime dependency cycle',
      description: 'Static runtime references form a closed path. This does not prove that every branch executes.',
      severity: 'warning', confidence: 'CONFIRMED', file: start, line: first.line,
      relatedFiles: component,
      evidence: path.map(edge => ({ from: edge.from, to: edge.to!, line: edge.line, column: edge.column })),
      recommendation: 'Review coupling and move shared responsibilities into an independent module when needed.'
    });
  }
  return { findings, truncated: components.length > maxFindings };
}
