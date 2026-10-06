# Architecture

RepoDoctor is a local Node.js CLI. It reads repository data, normalizes syntax and text measurements, applies structural rules, calculates a score and renders one shared result. It does not load target modules or execute target scripts.

```text
CLI → scan → discovery / configuration / parsing
           → normalized graph, entries and metrics
           → rules and context → score → terminal / JSON / HTML
```

## Module boundaries

| Module | Responsibility |
| --- | --- |
| `src/cli.ts` | Arguments, cancellation signals, output selection and exit codes. |
| `src/scan.ts` | Stage sequencing, shared budgets, coverage and result assembly. |
| `src/files.ts` | Contained reads, discovery, exclusions, ignore layers and YAML validation. |
| `src/languages.ts` | Source inventory, generated headers and text-only file metrics. |
| `src/typescript.ts` | Worker lifecycle, declarative tsconfig reading and static local resolution. |
| `src/parser-worker.ts` | TS/JS syntax, references, physical function ranges and token fingerprints. |
| `src/project.ts` | Manifest declarations and entry-point/script metadata, read as data. |
| `src/model.ts` | Normalized types and query selection. |
| `src/graph.ts` | Iterative strongly connected components and cycle evidence. |
| `src/analysis.ts` | File/package usage candidates, size findings and contextual relevance. |
| `src/duplication.ts` | Bounded token comparisons and exact text verification. |
| `src/score.ts` | Pure penalty calculation, deduplication and caps. |
| `src/reports.ts` | Shared sanitization and terminal/JSON/HTML rendering. |

The model, graph, analysis, duplication and score modules operate on normalized data. They do not import the TypeScript adapter or access target files directly. Exact text duplication receives a bounded read callback from orchestration. Reports do not recalculate findings or scores; category queries filter findings while retaining the overall score and diagnostics.

## Parsing and resource limits

A reusable worker parses one TS/JS file at a time, with a per-file timeout and a 256 MiB old-generation memory ceiling. The ceiling applies to the worker, not the entire process. Syntax errors discard that file's references. Other languages receive file metrics and whole-file text comparisons, without inferred imports, functions or dead-code findings.

Acquisition tracks entries, depth, source count and bytes. Graph, metadata, functions and duplication have additional budgets. Limits, unsupported resolution and cancellation remain visible through diagnostics and coverage; truncated analysis does not receive a complete score.

## Analysis decisions

Runtime cycles use only internal runtime edges and show one closed evidence path per strongly connected component. File reachability includes type edges because type consumers are relevant. Package usage combines import evidence with declarative script tool positions; unknown loading and indirect contracts prevent unsupported removal claims.

Context distinguishes application code, tests, migration SQL, tools and unknown roles. A runtime path from an application entry overrides directory conventions. Size and test duplication may carry reduced weight; demonstrated cycles retain full weight. Formula 1.1 deduplicates identities, applies the highest size penalty per file and enforces category/global caps. These are explicit review heuristics, not proof of defects.

## Runtime dependencies

- TypeScript supplies the syntax parser and builds RepoDoctor's own sources.
- YAML reads declarative configuration with aliases/executable tags rejected.
- ignore implements Git pattern semantics, including negation and escaping.
- `@types/node` supplies development types only.

No target dependency installation, persistent analysis cache, network service or distributed worker infrastructure is involved. For configuration, supported resolution, score factors and limits, see the [reference](reference.md).
