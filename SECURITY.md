# Security policy

## Supported versions

Barbaro is a public alpha. Security fixes target the current `main` branch and
the newest tagged prerelease only. Older commits and prereleases are not
supported.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, provider
transcripts, local paths, or other sensitive data.

Use GitHub's private vulnerability reporting for this repository (**Security**
→ **Report a vulnerability**). If that option is unavailable, open a public
issue that asks the maintainers to establish private contact, without including
any sensitive details.

Please include a sanitized description of the impact, the affected commit or
version, operating system, Node.js version, provider and provider version, and
minimal reproduction steps. This volunteer alpha does not currently promise a
response SLA or a bug bounty.

## Security model

Barbaro reads local provider traces and writes derived coordination data under
`.barbaro/`. That directory can contain prompt and response excerpts, tool
details, paths, failure output, and source references. Keep it ignored by Git
and do not publish or attach it without reviewing its contents.

Barbaro is intended for a trusted, single-user development checkout. Its active
claims are advisory, not locks, and its readers and projections are not a
secret-scrubbing boundary. The project root and `.barbaro/` must not be writable
by an untrusted local user. Provider traces are opened read-only; a report that
Barbaro modified a provider trace is always security-relevant.
