# Install Barbaro

Barbaro requires Node.js 22 or newer. The npm registry package is the canonical
installation path and installs a normal npm-managed `barbaro` executable into
npm's global bin directory without running a build. That directory must already
be on `PATH`.

## Install from npm

```sh
npm install --global barbaro
barbaro --version
command -v barbaro
```

## Install a GitHub release asset

If the registry is unavailable, download the built prerelease tarball and its
separate SHA-256 checksum asset:

The examples below use alpha.6. Download the tarball and checksum from the
same published release.

```sh
curl --fail --location --remote-name \
  https://github.com/d4j3y2k/barbaro/releases/download/v0.1.0-alpha.6/barbaro-0.1.0-alpha.6.tgz
curl --fail --location --remote-name \
  https://github.com/d4j3y2k/barbaro/releases/download/v0.1.0-alpha.6/barbaro-0.1.0-alpha.6.tgz.sha256
```

Run the checksum command for your platform:

```sh
sha256sum --check barbaro-0.1.0-alpha.6.tgz.sha256
```

On macOS, use:

```sh
shasum -a 256 --check barbaro-0.1.0-alpha.6.tgz.sha256
```

Then install the verified local archive:

```sh
npm install --global ./barbaro-0.1.0-alpha.6.tgz
barbaro --version
```

The `github:d4j3y2k/barbaro#<tag>` source-install form is intentionally
unsupported. In particular, do not use
`npm install --global github:d4j3y2k/barbaro#v0.1.0-alpha.6`: Git source tags do
not contain the ignored `dist/` output, and rebuilding development sources at
install time is not part of Barbaro's release contract. Use the registry or the
built release tarball instead.

## Install the opt-in skills

Choose either user scope or project scope for each provider, not both. Matching
hooks installed at both scopes run twice, and duplicate skill copies make it
unclear which definition a session used.

For a user-scoped installation, locate the shipped package and copy its skills:

```sh
BARBARO_PACKAGE="$(npm root --global)/barbaro"

mkdir -p "$HOME/.agents/skills/barbaro"
cp -R "$BARBARO_PACKAGE/.agents/skills/barbaro/." "$HOME/.agents/skills/barbaro/"

mkdir -p "$HOME/.claude/skills/barbaro" "$HOME/.claude/skills/barbaro-watch"
cp -R "$BARBARO_PACKAGE/.claude/skills/barbaro/." "$HOME/.claude/skills/barbaro/"
cp -R "$BARBARO_PACKAGE/.claude/skills/barbaro-watch/." "$HOME/.claude/skills/barbaro-watch/"
```

For a project-local installation, use `.agents/skills/` and `.claude/skills/`
under the target project instead and skip the user-scoped copies above.
Installing skills and hooks does not enroll a session: every Codex or Claude
Code session stays dormant until the user invokes the shipped Barbaro skill.

## Check the installation

With alpha.6 installed, run `barbaro doctor --project-root /path/to/project`
(add `--json` for source paths and build hashes). Doctor reads effective user
and project settings and does not require duplicate project-local hooks.
It honors `CODEX_HOME` and `CLAUDE_CONFIG_DIR` for user configuration; if you
set `CLAUDE_CONFIG_DIR`, install Claude skills under its `skills/` directory.
The commands above use the default roots.

A fresh installation normally has unverified publication and delivery until
both providers complete a real exchange. Follow the diagnostic remediation
and [live preflight](docs/dogfood.md#the-public-doctor). Doctor makes no changes.
For a development checkout whose CLI points into `dist/`, build/runtime
identity and source freshness are separate; use an agreed idle/drain rollout
before replacing a build used by running hooks.

## Install hooks

Before enabling hooks, add `.barbaro/` either to the target project's
`.gitignore` or to `$HOME/.config/git/ignore` for user-wide coverage. Derived
coordination data can contain sensitive request, response, tool, path, and
failure excerpts.

Resolve the installed executable first:

```sh
command -v barbaro
```

Merge the applicable template from the installed package into the existing
configuration at the same scope as the skills. In either template, replace
`BARBARO_BIN` with the absolute path printed above, keeping the surrounding
single quotes so the shell treats the path literally, spaces, `$`, and
backticks included. Paste the path inside the JSON string exactly as
printed; if it contains a backslash or a double quote, escape that character
as JSON requires (`\\` and `\"`). A path that itself contains a single quote
is not supported by the templates:

- Codex: merge `examples/codex-hooks.json` into `$HOME/.codex/hooks.json` or
  the target project's `.codex/hooks.json`.
- Claude Code: merge `examples/claude-hooks.json` into
  `$HOME/.claude/settings.json` or the target project's
  `.claude/settings.json`.

Append to existing hook arrays; do not overwrite other tools' hooks or register
Barbaro at both user and project scope. Restart the provider if newly installed
skills do not appear, then inspect its installed skills and hooks before using
them.

Read the [public-alpha limitations](ALPHA.md) and
[security policy](SECURITY.md) before enabling coordination. Barbaro does not
alter ignore rules or enroll sessions automatically.

## Maintainer-only checkout development

The source-checkout workflow is for Barbaro maintainers. It is not an
alternative end-user installation path, and persistent hooks must not point at
a development checkout.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm link
```

`npm link` exposes the current checkout rather than an immutable installed
package. Maintainers can exercise the release artifact without that link:

```sh
npm run test:package
npm publish --dry-run --tag latest
```

The package check builds a tarball, installs it globally under a fresh temporary
home and npm prefix, confirms the executable resolves into the packed package,
and exercises the installed CLI. Neither command publishes Barbaro.
