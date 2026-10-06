# Security

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/thebraz/RepoDoctor/security/advisories/new). Include the affected version, Node/OS details, impact and a small reproduction using synthetic data. Do not post credentials, private repository content or exploit details in a public issue.

Non-security bugs belong in [GitHub issues](https://github.com/thebraz/RepoDoctor/issues). This project has not undergone an independent security audit and does not promise a fixed response time.

## Analysis boundary

RepoDoctor treats target repositories as untrusted data. Scans do not execute target code, hooks, scripts, tests, installations or executable configuration. Declarative manifests/configuration are validated; target instructions do not control the scanner.

Paths must remain within the requested root. Symbolic links and junctions are not traversed. File/count/depth/parser/analysis budgets prevent unbounded work; failures and unsupported cases remain visible as diagnostics and partial coverage.

Reports exclude source snippets and `.env` values. Target-controlled names and text are sanitized, possible credentials redacted and HTML escaped. Redaction is conservative rather than a universal secret detector. Consumers rendering the internal result themselves must preserve these controls.

## Limitations

Static analysis does not certify target security or prove runtime behavior. Scans are not atomically isolated from concurrent filesystem changes. Avoid changing the target during analysis, and check coverage before acting on findings. When saving stdout, choose a destination outside source files; shell redirection can overwrite an existing file.

For implementation details and limits, see the [reference](docs/reference.md) and [architecture](docs/architecture.md).
