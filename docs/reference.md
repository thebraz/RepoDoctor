# CLI and analysis reference

### Languages and large repositories

| Analysis | Coverage |
| --- | --- |
| TypeScript/JavaScript/Node | Syntax, imports/re-exports/require, graph/cycles, usage candidates, functions and token duplication. |
| Python, Go, Rust, Java, C/C++, C#, Kotlin, Swift, Dart, Ruby, PHP, Vue/Svelte and other recognized extensions | File lines, size and whole-file UTF-8 text duplication; imports, functions, types and usage are not interpreted. |
| Additional extension, such as `.nim` | Declare `sourceExtensions: [.nim]` for the same text analysis. |

Also recognizes Scala, Elixir/Erlang, Haskell, Lua, Perl, R, Julia, Objective-C, Fortran, Shell, PowerShell, SQL, HTML/CSS, Protocol Buffers, Terraform, Zig, OCaml, Clojure, F#, Solidity, Assembly and Bazel sources. Ambiguous extensions are inventory classifications, not proof of syntax. No target compiler, plugin or script is executed. Files in languages without a parser have usage `unknown/UNKNOWN`; they do not generate dead-code accusations. Mixed and purely textual repositories retain `score.value=null` while any category lacks full coverage.

`--profile large` selects the maximum values in the limits table as a baseline; explicit YAML limits still apply. CLI `--profile` overrides the YAML profile. `--scope apps/web --scope services/api` restricts discovery and prunes subtrees outside those paths while preserving configuration and manifests in necessary ancestors. CLI scopes replace YAML scopes. Use `scope: []` in YAML for the whole repository. References leaving the scope are neither followed nor declared nonexistent.

For monorepos exceeding the limits, analyze modules/services separately and check each report's scope; scores are not automatically aggregated. The larger profile increases budgets; it does not guarantee constant time/memory or unlimited analysis. There is no incremental cache, distributed execution, behavioral evaluation, complete security audit or universal semantic support. Capacity beyond the documented limits has not been verified.

In text analysis, `duplicate-block` requires `duplication.minLines` (default 5) and `minBytes` (default 100; maximum 100,000). Fingerprints select candidates in linear time; only candidates are reread with root/link/byte controls and compared in full. Whitespace, comments and line endings are preserved. Text verification has its own budget for blocks and compared bytes within the same duplication limits; both adapters remain subject to global acquisition and finding limits.

| Code | Meaning |
| --- | --- |
| `0` | Complete analysis within the configured scope, without selected findings. |
| `1` | Complete analysis with at least one selected finding, including informational findings. |
| `2` | Partial result, operational failure/invalid configuration or invalid arguments. Takes precedence over findings. |

`complete` means full coverage of the supported/configured scope; it is not a health score or proof of no issues in excluded code or dynamic behavior. An empty directory has coverage of 0/0 files without an invented score.

Terminal, JSON and HTML render the same `ScanResult` without recalculating findings. JSON uses `schemaVersion: "1.3"` and the [report.schema.json](../report.schema.json) contract. It includes root, limitations, effective configuration, languages, applied ignore files, acquisition and category coverage, files, dependencies, entry points, file/package usage, metrics, duplication groups, findings, diagnostics, score and selected query. In JSON mode, stdout contains only the report. Usage errors and operational startup/interruption failures also receive a summary in stderr. Recoverable file/reference errors appear in `diagnostics` and make coverage partial.

References distinguish `kind` (`runtime` / `type-only`), `syntax` (`import`, `re-export`, `require`, `dynamic-import`, `import-type`) and `resolution` (`internal`, `external`, `unresolved`, `indeterminate`). Each reference has a file, 1-based line and column, target when resolved and reason when available. An interruption before resolution may leave `unresolved` references with a null reason; the interruption diagnostic identifies incomplete analysis.

Each cycle finding includes rule `runtime-cycle`, severity `warning`, confidence `CONFIRMED`, description, recommendation, related files and a closed evidence path with verifiable lines/columns. Confidence confirms the cycle in the **analyzed syntax graph**, without claiming that every branch executes. Type-only dependencies do not participate in this graph.

Lists are sorted by character code, without timestamps or duration in the comparable contract. Identical content and configuration produce identical results. At discovery limits, selection also depends on directory structure but is stable for the same tree.

## Configuration

Reads `.repodoctor.yml` in the requested root. If absent, uses the defaults below. The file must be a YAML map; accepted fields are `profile`, `scope`, `respectGitignore`, `sourceExtensions`, `exclude`, `entryPoints`, `limits`, `thresholds`, `duplication` and `score`. Unknown fields, dangerous keys, duplicates, unknown tags, YAML aliases, invalid types and out-of-range numbers are rejected. No tag execution or alias expansion. Configuration permits up to 64 KiB and structure depth 16.

```yaml
profile: standard
scope: []
respectGitignore: true
sourceExtensions: []
exclude:
  - "fixtures/**"
  - "**/legacy-?.ts"
entryPoints:
  - "src/cli.ts"
  - "scripts/**/*.ts"
thresholds:
  fileLines: 300
  functionLines: 50
duplication:
  minTokens: 50
  minLines: 5
  minBytes: 100
score:
  weights:
    runtime-cycle: 8
    potentially-unused-file: 2
    potentially-unused-package: 3
    oversized-file: 4
    oversized-function: 2
    duplicate-block: 5
  caps:
    cycles: 30
    unusedFiles: 15
    packages: 15
    size: 20
    duplication: 20
limits:
  maxFiles: 10000
  maxFileBytes: 2097152
  timeoutMs: 60000
```

YAML exclusions are **additional** to default protections. Use root-relative paths with `/`: `*` and `?` within a segment and `**` as a complete segment, including for directories. YAML patterns are case-sensitive and reject absolute paths, `..`, backslashes, negation, groups/extglobs and character classes. Maximum: 128 patterns of 256 characters.

`.gitignore` and `.repodoctorignore` are respected in the root and traversed subdirectories, including anchored rules, directories, escapes and negations. Ignored directories are pruned before their sources are read; a file cannot be re-included while its parent directory remains ignored. `.repodoctorignore` overrides `.gitignore` in the same directory; nearer rules override ancestors. `respectGitignore: false` disables only `.gitignore`. Global Git rules and `.git/info/exclude` are not read, and tracked files are not distinguished: scope is the filtered local tree. Each ignore file permits 64 KiB; the total is limited to 10,000 lines. Read failures do not become silent success.

Default excluded directories: `.git`, `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.cache`, `.tmp`, `.npm-cache`, `__pycache__`, `.venv`, `venv`, `.gradle`, `.terraform`, `target`, `obj` and `vendor`, at any depth. Declarations `.d.ts`/`.d.mts`/`.d.cts`, `.min.js`, `*.generated.*` files and initial commented headers with generation markers are also omitted. Content with NUL or invalid UTF-8 is rejected. Configuration cannot remove these protections.

| Limit | Default | Configurable maximum |
| --- | ---: | ---: |
| `maxFiles` | 10,000 | 100,000 |
| `maxEntries` | 100,000 | 1,000,000 |
| `maxDepth` | 64 | 128 |
| `maxFileBytes` | 2,097,152 | 8,388,608 |
| `maxTotalBytes` | 67,108,864 | 268,435,456 |
| `maxParseTimeMs` | 5,000 | 30,000 |
| `maxAstNodes` | 200,000 | 1,000,000 |
| `maxDependencies` | 100,000 | 1,000,000 |
| `maxFindings` | 1,000 | 10,000 |
| `timeoutMs` | 60,000 | 300,000 |
| `maxDuplicationTokens` | 200,000 | 2,000,000 |
| `maxDuplicationBlocks` | 10,000 | 100,000 |
| `maxDuplicationComparisons` | 5,000,000 | 20,000,000 |

All are positive integers. Bytes are actual UTF-8 bytes read, including configuration and manifests; a file rejected for size before reading does not consume that budget. Entries include files and directories enumerated before exclusions. Root depth is 0. The AST limit is per file; dependencies and findings are per run. Manifests are read as JSON up to 64 KiB; public entries have maximum depth 16 and up to 1,024 elements per field. Total metadata (entry points, declarations and tools) also respects `maxEntries`; the total functions stored in metrics has a separate `maxEntries` budget, with `METRIC_LIMIT` when exceeded; manifests respect `maxFiles`. Files with syntax errors, parser failure/limits or invalid UTF-8 contribute no references. Generated headers count toward discovery and bytes read but not analyzed files. `skippedEntries` counts recognized omissions; it does not estimate all content in pruned directories.

The parser runs in a reusable worker with a 256 MiB memory ceiling and per-file timeout, including initialization on the first file. That ceiling applies to the worker, not the entire process. Acquisition and graph work use count/byte limits and a total deadline. `Ctrl+C`/SIGINT and SIGTERM interrupt analysis and return a partial result. Time limits are budget checks, with no real-time guarantee for system calls/serialization.

## Resolution and analysis limits

- Recursively discovers `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs` in the explicit root; does not search for a project above it.
- Uses the TypeScript parser for imports/exports, re-exports, import equals, direct `require` calls, import types and dynamic imports with strings/templates without interpolation. Dynamic arguments remain indeterminate; expressions are not evaluated.
- Resolves relative source files, extensions and `index.*`. Source priority is TS/TSX/MTS/CTS before JS/JSX/MJS/CJS. An explicit `.js`, `.jsx`, `.mjs` or `.cjs` reference permits corresponding TS source before the JS file. Does not reproduce all Node ESM extension restrictions.
- Reads the nearest JSONC `tsconfig.json`, `baseUrl`, exact/single-`*` `paths` aliases, alternative targets and `extends` of a relative local JSON file, up to 16 levels. Respects the origin of inherited paths and `baseUrl`/`paths` overrides. Configurations never escape the root or use excluded directories.
- Package/list `extends`, circular inheritance, invalid configurations and `rootDirs`, `moduleSuffixes` or `customConditions` produce diagnostics. Language service plugins (including Next.js) are editor data: never loaded and do not block valid relative imports/aliases. References under invalid/unsupported resolution configurations have no confirmed target. Project references and triple-slash directives produce diagnostics. Tsconfig `include`/`files`/`exclude` do not define discovery: the scanner uses its own filters.
- Package and subpath references are external; installation/existence is not verified. Does not resolve `package.json` exports/imports, local workspace packages by name, loaders, bundler aliases or executable configurations. `#...`, absolute, `file:`, control-character or known loader references remain unresolved. A bare specifier without a `baseUrl` match is classified as external; this does not prove that it is an installed package.
- Explicit `import/export type`, including named elements in mixed declarations and references in ambient `declare` contexts, is separated from runtime references. Does not reproduce import elision inferred from types or emit options. A local binding or write to `require` anywhere in a file conservatively makes its calls indeterminate, including assignments, destructuring, increments and iteration variables; there is no semantic scope analysis. Writes to properties such as `obj.require` do not affect this rule. Detectable indirect loaders such as `module.require` and `import.meta.glob` receive diagnostics. Reflection, arbitrary function aliases and JSDoc imports may remain unknown.
- The graph uses strongly connected components with iterative traversal, without deep recursion. Shows **one verifiable cycle per component**, including self-imports. Does not enumerate every combination of cycles.

Identity uses real root paths and relative paths with `/` for display. On Windows, resolution follows the default case-insensitive name convention while preserving displayed spelling. Individually case-sensitive Windows directories were not verified. Missing or excluded files, unsupported formats and unknown targets produce diagnostics without inventing dependencies. Syntax/parser errors discard that file's references. A source extension containing binary data is rejected; `.env` is not discovered.

Reports include no source snippets or `.env` values. Target-controlled text has control/bidirectional characters neutralized and possible credential patterns redacted, including in names and specifiers, quoted keys and values with spaces or escaped quotes. Redacted markers include a short SHA-256 fingerprint to distinguish masked names. Redaction is conservative and may hide legitimate long identifiers; it is not a universal secret detector. `scan()` provides the internal model; consumers creating another output must retain renderer sanitization.

## Potentially unused files and packages

Reachability uses internal runtime **and type-only** references from entry points recorded in `entryPoints`. Explicit YAML paths/patterns add to recognized entries, with the same glob restrictions as exclusions. A missing explicit/public entry produces a diagnostic; unreached files require lower confidence.

Recognized entries: package.json `main`, `module`, `types`/`typings`, `bin`, `exports` and `browser` (all supported declared targets); scripts with literal paths; `index`, `main`, `server` and equivalents under `src/`; directories `test`, `tests`, `__tests__` and `.test`/`.spec` suffixes. Compiled targets map from `outDir` to `rootDir` when both are explicit in tsconfig, including public declarations to TS source. Without that mapping, declare the source in YAML. When `next` is declared, recognizes `pages/`, `app/` routes/entry components, middleware and instrumentation, also under `src/`. Other frameworks require configured entries.

Next, ESLint, Vite, Vitest, Jest, Webpack, Rollup, Astro, Nuxt, Svelte, Tailwind and PostCSS `*.config.[cm]?[jt]s` files are entries when the corresponding tool is declared in the package manifest. Executable configuration is treated as source without execution; other conventions require `entryPoints`. Internal paths are canonicalized before comparison, including aliases with multiple segments on Windows.

An unreached file receives `candidate/LIKELY` and rule `potentially-unused-file`. Indeterminate dynamic loading, errors or unknown entries reduce confidence to `SUSPICIOUS` and category coverage to partial. Without any known entry, files remain `unknown/UNKNOWN`, the category is unavailable and no unused finding is created. Literal dynamic imports participate in the graph; expressions and reflection are not evaluated. Confirmed reachability does not prove actual execution.

Each package declared in dependencies/devDependencies/peerDependencies/optionalDependencies is identified by manifest and name. Imports/re-exports/require/import types, including subpaths and scoped names, record runtime/type-only evidence. The nearest ancestral declaration for that name receives usage. References to Node.js built-ins with a declared package name such as `fs` or `buffer` leave that package `unknown/UNKNOWN`: they neither confirm usage nor exclude a possible bundler polyfill. Other tool/non-native usage evidence may confirm the package; explicit `node:` references do not count as installed package usage.

Scripts are only tokenized: tools in command position (such as tsc→typescript, eslint, npx/npm exec and direct Yarn/pnpm calls), literal paths and preload/loader options are considered. In Node/nodejs/tsx/ts-node/ts-node-esm, the first operand is the entry; application arguments do not become entries. Extensionless entries and local preloads use the same source resolver, including compiled output mapping. Recognized preload options accept separate values or `=`, plus `-rname`. `echo`/`printf`/`cat`/`type` do not make argument paths reachable. The full shell is not interpreted: inline eval/print (also `-eCODE`/`-pCODE`), `NODE_OPTIONS`, substitutions/environment variables/invalid quotes leave usage indeterminate. Directory changes and executable entries with no matching source produce `SCRIPT_UNCERTAIN`; the scanner does not emulate that context.

Packages with static evidence have `used/CONFIRMED`. @types packages are `indirect/LIKELY`; peers/optional packages are `indirect/UNKNOWN`, preserving contracts and conditional consumption. Others without evidence receive `candidate/SUSPICIOUS` and `potentially-unused-package`. Failures or indeterminate loading keep them `unknown/UNKNOWN`. Without a manifest, the category is unavailable. Tools in executable configurations, plugins and external usage may escape the model; candidates never authorize removal.

## Metrics and basic duplication

`metrics` records physical file lines (including blank lines/comments; excludes the final empty line after a newline) and the inclusive signature-to-end range of every function with a body. Both use TypeScript's line map: CRLF, CR, LF, U+2028 and U+2029. Includes functions, expressions, arrows, methods, constructors and accessors; excludes ambient declarations/signatures without bodies. String method names are decoded before report sanitization. Line count is not complexity. Empty files have zero lines. `oversized-file` and `oversized-function` require **more** than the limits, never equality. Defaults: 300/50 lines; integers from 1 to 100,000.

`duplicate-block` compares whole files and complete function bodies, including expression bodies. Uses tokens from the already parsed AST, SHA-256 per token, a length/hash bucket and verification of the entire fingerprint sequence. Ignores comments and whitespace outside literals; preserves identifiers, string spelling/content, regexes, templates and JSX text. The external signature/name is not part of the compared body; internal renaming or literal changes no longer match. Does not search arbitrary fragments inside a function or infer intent or authorship.

Default minimums per occurrence: 50 tokens and 5 inclusive lines between the first/last token; both configurable from 1 to 1,000. Each group shows files, start line/column and end line. Larger groups suppress nested groups when all occurrences are already covered. Extracted tokens (including truncated files), eligible candidates and comparisons/containment checks respect the three duplication limits per run. Files with truncated tokenization do not participate; any truncation is a diagnostic and partial coverage. No indiscriminate comparison of all pairs.

## Explainable score

Formula version 1.1: **100 − sum of applied penalties**, between 0 and 100. Raw penalty is rule weight × confidence factor × context factor. Confidence: CONFIRMED=1, LIKELY=0.75, SUSPICIOUS=0.25, UNKNOWN=0. Default weights: cycle 8; candidate file 2; candidate package 3; oversized file 4; oversized function 2; duplicate group 5. Category caps: cycles 30, unusedFiles 15, packages 15, size 20, duplication 20. Weights/caps accept finite numbers from 0 to 100; zero disables that penalty while preserving the finding.

Equivalent identities count once: cycle per component, candidate per file or manifest/package, duplication per group. Size is one conservative signal per file: applies the **highest** penalty between the file and its functions, avoiding accumulation of the same signal in overlapping ranges. Contributions are sorted by identity before category caps and the global cap of 100 (also when configured caps sum to more than 100). Penalties round to six decimals and score to two. Caps with precision beyond six decimals are truncated downward to that precision before application so rounding does not exceed the configured value. Each contribution exposes weight, confidence, `contextFactor` and raw/applied value; `penalties` and `explanation` explain the composition.

`score.status=complete` requires all categories complete and at least one analyzed file: `value` and `observedValue` contain the score. With partial/unavailable categories, `status=partial`, `value=null` and `observedValue` describes only what was observed without establishing overall health. Without assessable files/categories, both are null and status is unavailable. Therefore, absence of entry points or a manifest does not earn a complete score of 100. Acquisition coverage and category coverage differ; a partial heuristic category alone does not change the CLI exit code.

### Context and relevance

The scanner records `finding.context` with role, factor and reason without changing counts or evidence confidence. Conventions are local heuristics; they do not understand author intent or prove defects. For size, **factor = min(1, lines/limit − 1) × role factor**, rounded to six decimals: application/unknown 1; tests 0.25; scripts/tool configurations 0.5; historical migration SQL 0. Slightly exceeding a limit weighs less than reaching twice the limit. Up to 20% excess is informational, as are tests/tools below four times the limit. Extreme values remain review warnings. Historical SQL remains informational: size alone does not justify rewriting applied migrations.

Tests are recognized by test entry points, test/tests/__tests__/e2e directories, .test/.spec suffixes and scripts/test-* or scripts/check-*. Migrations require SQL in migrations or db/migration; tools require a script entry or recognized declared configuration. Scripts start/dev/serve/server (including :suffix names) are application entries; test/e2e and node --test mode are tests; other recognized scripts are tools. This declarative purpose appears in `entryPoints[].purpose`. A **runtime dependency** path from an application/configured/public API entry takes precedence: code called by the application gets no discount for being in tests/migrations. A type-only reference is not runtime evidence; src/app/lib code remains application code even when referenced only by tests. Files without a known role keep factor 1.

Demonstrated cycles keep factor 1 in every role. Test-only duplication receives factor 0.5; a group with application or unknown-role code keeps 1. Tool file candidates receive 0.5; SUSPICIOUS/UNKNOWN confidence remains independent of context. Other rules keep 1. Evidence, metrics and all selected findings remain available, including those with factor zero. These factors are an explainable review policy, not a universal percentage of code quality.

## Reports, queries and compatibility

The default terminal highlights the numeric structural score, up to 20 review priorities and a context notice summary; notices are preserved, not removed. `--details` shows full evidence, entry points, packages, metrics, groups, configuration, coverage and calculation. HTML is a standalone English document with coverage/limitations and complete JSON in an expandable section. All text is redacted and escaped; there are no scripts or external resources. The CLI emits stdout without writing to the repository.

Queries run the same scan and filter only `findings`: architecture selects runtime-cycle; duplicates selects duplicate-block; dead-code selects file and package candidates. Graph data, metrics and diagnostics remain available; the score is always **overall**. `view.query` identifies the query and `view.totalFindings` the retained overall total. Exit code 1 depends on selected findings; partial acquisition takes precedence with 2 in every query.

Migration 1.0→1.1: existing fields, flags and cycle evidence are preserved. New fields/configuration/rules require accepting schemaVersion 1.1 and handling the evidence union: runtime-cycle uses from/to; other rules use file/detail with optional location. Strict 1.0 readers need the new schema. Exit code 1 now includes any selected finding, beyond cycles; consumers must not assume every finding is a cycle.

Migration 1.1→1.2: new required fields `languages`, `ignoreFiles`, profile/scope/ignore/extension configuration and `duplication.minBytes`. Duplication groups have `method`: `tokens` preserves the TS/JS contract; `exact-text` uses `tokens: 0` and `bytes`, without inventing another language's tokens. Default terminal output is summarized; use `--details` for previous data. TS/JS rules and weights remain the same. Ignored files no longer participate in the graph or penalties, according to the scope visible in the report.

Migration 1.2→1.3: scan findings include context; severity accepts `info` as well as `warning`. Contributions require `contextFactor` and the formula becomes 1.1, so old scores are not directly comparable. Weights, caps, flags, physical measurements, categories and exit codes remain. `value=null` in partial coverage retains its meaning; use `observedValue` and always show provisional status. Finding order prioritizes relevance before stable rule/location order. Strict readers should use the current schema. Human-readable report text is English, including the `[redacted:…]` marker. Target names and source data are preserved.
