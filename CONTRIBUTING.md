# Contributing to Barbaro

Barbaro is a public alpha built around private, version-sensitive provider
formats. Useful reports and small, well-tested changes are welcome; raw session
data is not.

## Report a bug safely

Use the repository's bug form for ordinary installation, compatibility, and
behavior problems. Include:

- Barbaro, Node.js, operating-system, provider, and provider-version details;
- the exact command or hook event involved;
- minimal steps that reproduce the problem; and
- sanitized output showing the failure.

Never attach raw Codex or Claude Code traces, `.barbaro/`, credentials, private
prompts or responses, usernames, home-directory paths, repository secrets, or
proprietary source. Build the smallest synthetic reproduction you can and
replace identifying values consistently.

Report security problems privately as described in [`SECURITY.md`](SECURITY.md),
not through a public issue.

## Develop from a checkout

Barbaro requires Node.js 22 or newer. Install the locked dependencies and run
the main checks:

```sh
npm ci
npm run typecheck
npm test
npm run docs:assets:check
```

`npm test` builds the project before running the compiled tests. Before a
release, maintainers also run `npm run test:package`; that command intentionally
refuses dirty package inputs, so commit or restore the release tree first.

Keep changes focused and preserve the core safety properties:

- provider traces are read-only;
- session enrollment is explicit and hook-owned;
- canonical derived records are deterministic and append-only;
- active claims remain advisory; and
- bounded projections disclose what they omit.

## Fixtures and generated files

Fixtures must be synthetic or thoroughly sanitized. Preserve the relevant
record structure while removing identifying content, local paths, credentials,
and unrelated transcript text. Document new source-format observations in the
matching mapping file under `docs/`.

Do not hand-edit generated TUI fixtures or files under `docs/assets/` when a
generator owns them. After an intentional visual change, regenerate and verify:

```sh
npm run docs:assets
npm run docs:assets:check
```

The horse source generator additionally requires Python and Pillow, but those
are not runtime dependencies. See [`docs/horse-study.md`](docs/horse-study.md).

## Pull requests

Explain the observable behavior change, the provider versions or fixtures it
affects, and the commands used to verify it. Call out any schema, hook, privacy,
or packaging impact explicitly. Do not publish packages, create tags, or attach
real session data from a pull request.
