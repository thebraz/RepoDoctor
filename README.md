# RepoDoctor

Local repository analysis with structural scores and review priorities.

[![CI](https://github.com/thebraz/RepoDoctor/actions/workflows/ci.yml/badge.svg)](https://github.com/thebraz/RepoDoctor/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-43853d)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/thebraz/RepoDoctor/blob/main/LICENSE)

RepoDoctor helps you review dependency cycles, potentially unused code, large files/functions and exact duplication. It produces a structural score with evidence, confidence and explicit analysis coverage. Scans run locally and treat the target as read-only data.

## Quick start

Requires Node.js 22 or later and npm. Install the package from the GitHub release, then run it inside your project:

```sh
npm install -g --ignore-scripts https://github.com/thebraz/RepoDoctor/releases/download/v0.3.3/repodoctor-0.3.3.tgz
cd /path/to/your/project
repodoctor scan
```

The package is distributed through [GitHub Releases](https://github.com/thebraz/RepoDoctor/releases). It is not currently published on npm; installing the release archive still lets npm resolve its runtime dependencies from the registry. You can also [build from source](https://github.com/thebraz/RepoDoctor/blob/main/CONTRIBUTING.md).

## What it analyzes

Structural signals are useful when deciding where to investigate a codebase. RepoDoctor keeps the evidence visible and separates review priorities from common context notices; a candidate finding is not permission to delete code.

| Area | What you get |
| --- | --- |
| Dependencies | TS/JS syntax references and a verifiable path for each reported runtime cycle. |
| Usage | Potentially unused files/packages, accounting for entry points, types, scripts and supported framework conventions. |
| Size | Physical file/function line counts, with contextual weight for tests, migration SQL and tools. |
| Duplication | Exact token sequences for TS/JS whole files/function bodies; identical full text for other languages. |
| Score and reports | Explainable penalties, category coverage and the same result in terminal, JSON and HTML. |

**TypeScript and JavaScript** have syntax analysis. Python, Go, Rust, Java, C/C++, SQL and other recognized languages have file metrics and whole-file text duplication; their imports, functions and usage are not interpreted. Mixed-language scores remain explicitly provisional when semantic categories are incomplete.

## Usage

```sh
repodoctor scan
repodoctor scan "../another project" --details
repodoctor architecture
repodoctor duplicates --format json
repodoctor dead-code --format html
repodoctor scan --profile large --scope apps/web --scope services/api
repodoctor --help
```

| Command | Selected findings |
| --- | --- |
| `scan` | All structural findings. |
| `architecture` | Runtime dependency cycles. |
| `duplicates` | Exact duplication groups. |
| `dead-code` | Potentially unused files and packages. |

All commands use the current directory when no root is provided. Queries retain the overall score of the selected scope; they only filter findings. `--details` expands terminal output. `--format terminal|json|html` selects output; JSON and HTML keep full data. Repeat `--scope` with root-relative paths, and use `--profile large` for higher bounded budgets.

Reports go to stdout. To save one, choose a destination outside the analyzed source tree:

```sh
repodoctor scan --format html > ../repodoctor-report.html
```

Exit codes: **0** for complete acquisition without selected findings, **1** with findings (including informational), **2** for partial acquisition, operational/configuration failure or invalid arguments. Check category coverage as well: a complete file acquisition can still have a provisional score.

## Example analysis

The repository includes a small intentional TS cycle. After [building the checkout](https://github.com/thebraz/RepoDoctor/blob/main/CONTRIBUTING.md), reproduce it with:

```sh
node dist/src/cli.js scan examples/cycle
```

Excerpt from the actual CLI output; the root path and remaining coverage details are omitted:

```text
Structural score: 92/100
Query: scan · 1/1 findings · 2 dependencies
```

The finding points to the closed path `index.ts:1 → worker.ts:1 → index.ts`, with `CONFIRMED` confidence in the analyzed syntax graph. That proves a static runtime cycle, not execution of every branch. The example is excluded from scans of RepoDoctor itself; scanning its directory explicitly includes it.

## Reading the score

Formula 1.1 starts at 100 and subtracts capped penalties using rule weight, evidence confidence and context. Equivalent findings count once; size uses the highest penalty per file. A small threshold excess weighs less than an extreme one, and demonstrated cycles keep full weight.

A complete score requires complete category coverage and analyzed files. Partial results show a **provisional** numeric score for observed findings while `score.value` stays null. Empty or failed analysis receives no invented score. The score guides review; it is not a percentage of perfection, a security certification or proof of poor architecture.

## Architecture and documentation

The CLI coordinates bounded discovery/parsing, normalized graph and metrics, pure analysis/scoring and shared report rendering. TypeScript parsing runs in a reusable worker. Target code, scripts and executable configurations are never loaded.

- [CLI, configuration, supported languages, rules and limits](https://github.com/thebraz/RepoDoctor/blob/main/docs/reference.md)
- [Architecture and module boundaries](https://github.com/thebraz/RepoDoctor/blob/main/docs/architecture.md)
- [JSON report schema 1.3](https://github.com/thebraz/RepoDoctor/blob/main/report.schema.json)
- [Changelog](https://github.com/thebraz/RepoDoctor/blob/main/CHANGELOG.md)

Analysis is static. Package exports/imports, arbitrary loaders, full shell semantics and external consumers are not reproduced. Missing references and unknown loading reduce confidence or coverage. There is no universal semantic support, behavior evaluation, incremental cache or distributed analysis. Scans use documented resource limits and do not provide atomic isolation from concurrent target changes.

## Development

```sh
git clone https://github.com/thebraz/RepoDoctor.git
cd RepoDoctor
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run verify:package
```

Tests use Node's built-in runner and synthetic repositories. Package verification installs a real tarball outside the checkout and checks the installed commands, formats and target preservation. See [Contributing](https://github.com/thebraz/RepoDoctor/blob/main/CONTRIBUTING.md) for the workflow and [Security](https://github.com/thebraz/RepoDoctor/blob/main/SECURITY.md) for private vulnerability reporting.

## License

[MIT](https://github.com/thebraz/RepoDoctor/blob/main/LICENSE) · Copyright 2026 braz.
