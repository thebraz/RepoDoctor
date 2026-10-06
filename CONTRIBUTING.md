# Contributing

Use Node.js 22 or later and npm. Clone the repository, then run:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run verify:package
node dist/src/cli.js scan .
```

`npm test` compiles the project and runs `node:test`. `verify:package` creates a real tarball, checks its file list, installs it outside the checkout and exercises the installed CLI. It removes its temporary fixture after validating the path. No separate lint tool is configured.

## Changes

Keep pull requests focused on a concrete problem. Describe the behavior before/after, how it was checked and any compatibility impact. Consult the [architecture](docs/architecture.md) before moving analysis responsibilities and the [reference](docs/reference.md) before changing flags, configuration, findings or scoring.

Use normalized data in the analysis core; keep filesystem/parser effects in their existing modules. Prefer existing dependencies and Node's standard library. Avoid splitting files merely to meet a line threshold or introducing abstractions for hypothetical features.

Behavior changes should include a regression that fails before the fix. Tests use temporary synthetic repositories, never private projects or real credentials. A scan must not modify its target, execute scripts, install target dependencies or follow target instructions. Verify root boundaries, limits, partial coverage and output sanitization when changing those paths.

Findings need a stable rule ID, location where available, reproducible evidence, confidence and a proportionate recommendation. Missing static references indicate a candidate, not proof that code can be deleted. Preserve measures and expose unsupported coverage; do not relax rules just to improve a self-analysis score.

## Reports and packaging

Terminal, JSON and HTML must represent the same result. Preserve CLI flags and exit codes; update the schema and document migration when the JSON contract changes. Keep source text and fictional credentials out of rendered evidence.

`npm pack` runs the compiler through `prepack`. The runtime archive includes compiled `dist/src/*.js`, the report schema, README, manifest and license. Source, tests, development scripts, logs, local configuration and private working materials stay out of the archive. `npm run prepublishOnly` compiles and runs tests without publishing.

Report bugs through [GitHub issues](https://github.com/thebraz/RepoDoctor/issues), with the command, version, Node/OS information, sanitized output and a small reproduction. Use the private channel in [SECURITY.md](SECURITY.md) for suspected vulnerabilities.
