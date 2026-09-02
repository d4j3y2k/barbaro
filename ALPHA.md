# Barbaro public alpha

Barbaro is experimental software for testing agent coordination on trusted
development machines. It is not recommended for production, unattended, or
high-assurance workflows.

## Current limitations

- Provider session formats are private, version-sensitive implementation
  details. The Codex adapter is version-pinned and the Claude Code adapter is
  based on observed traces; a provider update can require a Barbaro update.
- Active path claims are advisory. They do not lock files, prevent concurrent
  writes, or replace normal Git branch and worktree isolation.
- The v1 interchange schemas are the current normative contract, but the CLI,
  hook configuration, setup flow, and undocumented implementation files may
  change between prereleases.
- CI currently covers macOS and Linux with Node.js 22, 24, and 26. Windows
  behavior is not verified.
- Coordination state is per checkout. Two Git worktrees have separate
  `.barbaro/` stores and workstream namespaces; a workstream cannot currently
  span them.
- Barbaro coordinates processes that share a trusted local project. It is not a
  distributed coordination service or a boundary between mutually untrusted
  users.

## Data and privacy

Barbaro leaves provider traces untouched, but its derived `.barbaro/` views can
contain sensitive request, response, tool, path, and failure data. Add
`.barbaro/` to the target project's ignore rules before enabling hooks. Do not
commit, upload, or share that directory unless you have deliberately reviewed
the material. A byte-bounded reader projection improves context size; it does
not guarantee redaction.

Report suspected vulnerabilities through the private process in
[`SECURITY.md`](SECURITY.md). Ordinary compatibility bugs and sanitized
reproductions are welcome through the repository's public issue tracker.
