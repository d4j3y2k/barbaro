# Install Barbaro

Barbaro requires Node.js 22 or newer. Install the CLI once at user scope; do
not run `npm link` and do not point hooks into a development checkout.

## npm alpha

Once the alpha is published to npm:

```sh
npm install --global barbaro@alpha
barbaro --help
```

To install a tagged GitHub release before the npm alpha is available:

```sh
npm install --global github:d4j3y2k/barbaro#v0.1.0-alpha.2
barbaro --help
```

Both commands install a normal npm-managed `barbaro` executable on `PATH`.
The executable resolves into the installed package, independently of the
checkout that produced it.

## Install the opt-in skills

From the project where agents will collaborate, copy the shipped skills from
the installed package:

```sh
BARBARO_PACKAGE="$(npm root --global)/barbaro"

mkdir -p .agents/skills/barbaro
cp -R "$BARBARO_PACKAGE/.agents/skills/barbaro/." .agents/skills/barbaro/

mkdir -p .claude/skills/barbaro .claude/skills/barbaro-watch
cp -R "$BARBARO_PACKAGE/.claude/skills/barbaro/." .claude/skills/barbaro/
cp -R "$BARBARO_PACKAGE/.claude/skills/barbaro-watch/." .claude/skills/barbaro-watch/
```

Installing skills and hooks does not enroll a session. Each Codex or Claude
Code session remains dormant until the user explicitly invokes the shipped
Barbaro skill.

## Install hooks

Before enabling hooks, add `.barbaro/` to the target project's `.gitignore`.
Then merge the applicable shipped template into the project's existing hook
configuration:

- Codex: copy entries from `examples/codex-hooks.json` into
  `.codex/hooks.json`.
- Claude Code: copy entries from `examples/claude-hooks.json` into
  `.claude/settings.json`, replacing `BARBARO_BIN` with the absolute path
  printed by `command -v barbaro`.

Append to existing hook arrays; do not overwrite other tools' hooks.

## Verify a release tarball

Maintainers can exercise the same packed artifact without `npm link`:

```sh
npm ci
npm run test:package
```

The packaging check builds a tarball, installs it globally under a fresh
temporary home and npm prefix, confirms the executable resolves into that
installed package rather than this checkout, runs `barbaro --help`, and then
removes the temporary files.
