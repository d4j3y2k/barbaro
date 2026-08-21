# Dogfooding Barbaro inside the Barbaro repository

Barbaro coordinates parallel coding agents by publishing three project-local
views. Dogfooding means running those agents *on this repository*, with this
repository's own hooks feeding `.barbaro/`. That is useful and slightly
recursive: the tool under development is also the coordination layer the
developers depend on, and a broken build silently breaks coordination.

This document describes the preflight, the parallel-actor protocol, and the
bounded peer-context procedure used in this checkout.

## The setup doctor

`src/setup/` is a read-only diagnostic library. It answers one question — *is
this checkout in a state where launching parallel actors is safe?* — as a
structured, deterministic record.

The library observes and never repairs:

- it never installs anything, never writes or edits a hook config, and never
  touches user or global settings;
- it reads only project-local configuration files. The one exception is
  deliberate and read-only: to decide whether a hook is runnable it stats the
  interpreter and CLI that the project's own hook config names, resolving a
  bare command through `PATH` the way the hook runner will. It never reads a
  user or global settings file;
- it inspects `.barbaro/` through metadata alone (`lstat`, `readdir`), so no
  canonical feed, evidence, or lease bytes can reach a report or a terminal
  through it;
- given the same filesystem, clock, and environment, two runs serialize
  byte-identically under `stableStringify`.

Diagnostics are named, sorted by id, and carry machine-readable `facts` plus
manual `remediation` steps. Statuses are deliberately coarse:

| Status | Meaning |
|---|---|
| `pass` | Verified good. |
| `warn` | Works, but a parallel launch is riskier than it looks. |
| `fail` | Coordination is broken until a human fixes it. |

The report's overall `status` is the worst diagnostic.

### Running it

The setup doctor is currently a project-local library, not a `barbaro setup
doctor` CLI command. Build the project and call the library directly:

```sh
npm run build
node --input-type=module -e '
  import { runSetupDoctor, formatSetupDoctorReport } from "./dist/src/setup/index.js";
  process.stdout.write(formatSetupDoctorReport(await runSetupDoctor()));
'
```

`runSetupDoctor()` accepts `projectRoot`, `now`, `env`, `freshness`,
`maxEntries`, and `maxDepth`; every one of them exists so a caller can make a
run reproducible. `formatSetupDoctorReport` is only a projection — the
structured report stays the source of truth for any wrapper.

### What it checks

| Diagnostic | Question |
|---|---|
| `build.dist-freshness` | Is `dist/src/cli.js` present, and is every `src/**/*.ts` compiled and newer-than-source? Hooks execute `dist/`, so an unbuilt edit never reaches a peer. |
| `gitignore.barbaro-ignored` | Does `.gitignore` actually ignore `.barbaro/`? Derived views carry request and response excerpts. A `!.barbaro` negation counts as a failure. |
| `hooks.claude` / `hooks.codex` | Does a project-local hook config exist, does it name both `hook` and `hook-ingest`, does it cover the required events, and do the interpreter and CLI it names actually resolve on disk (including installed executable symlinks)? |
| `views.coordination-state` | Are `.barbaro/active`, `feed`, `evidence`, and `state` present, non-empty, and recent? Freshness thresholds default to the 5-minute lease TTL for `active` and one hour elsewhere. |
| `workspace.isolation` | Is there a Git repository at all? Without one there are no branches and no worktrees, so parallel actors share one mutable checkout. |

A stale view is reported as stale, never as current: treat it as *no* peer
context rather than as peer context that happens to be old.

## Parallel actors in this checkout

This working copy is a Git repository. Give concurrent actors separate
worktrees when practical; separate branches in one shared working tree do not
isolate filesystem writes. When actors share this checkout, disjoint ownership
and live peer context remain required:

1. **Isolate the checkout when possible.** Use one worktree and branch per
   actor. Never treat a branch name alone as filesystem isolation.
2. **One lane per actor.** Every prompt states the paths the actor owns *and*
   the paths it must not touch. Two actors never own the same path.
3. **Leases are advisory.** `.barbaro/active/` is a snapshot with an expiry,
   not a lock. It tells you what a peer *said* it was doing; it cannot stop
   anyone.
4. **Recheck immediately before editing.** Run the bounded context reader again
   before touching a file, not only at planning time.
5. **`.barbaro/` is generated and read-only.** Never edit it, never hand-repair
   it, never commit it. In particular, do not call the participation store to
   enroll yourself or a peer; only a provider hook carrying the user's exact
   leading command/skill invocation may create consent state.
6. **Installation and participation are separate decisions.** Hook and settings
   changes are manual per project. Each new actor also stays dormant until its
   user explicitly invokes `/barbaro` in Claude Code or `$barbaro` in Codex;
   nothing in `src/setup/` enrolls it automatically.

A lane prompt that works looks like:

> /barbaro Your lane: *one sentence of intent*. Own only `src/<area>/**`,
> `test/<area>/**`, and `docs/<file>.md`. Do not edit *(explicit list)*.

### Verifying a lane without clobbering a peer

`npm test` runs `npm run build`, which writes the shared `dist/`. When another
actor may be building at the same moment, compile your lane to a scratch
directory instead and run only your own tests:

```sh
cat > /tmp/tsconfig.lane.json <<'JSON'
{
  "extends": "/abs/path/to/barbaro/tsconfig.json",
  "compilerOptions": {
    "rootDir": "/abs/path/to/barbaro",
    "outDir": "/tmp/lane-dist",
    "typeRoots": ["/abs/path/to/barbaro/node_modules/@types"],
    "sourceMap": false,
    "declaration": false
  },
  "include": [
    "/abs/path/to/barbaro/src/**/*.ts",
    "/abs/path/to/barbaro/test/<area>/**/*.ts"
  ]
}
JSON
npx tsc -p /tmp/tsconfig.lane.json
node --test /tmp/lane-dist/test/<area>/*.test.js
```

`npx tsc -p tsconfig.json --noEmit` is always safe: it writes nothing.

Once every lane has landed, one actor runs the shared `npm test` to rebuild
`dist/` — which also restores the build that the hooks execute.

## Peer-context preflight with `barbaro context`

`barbaro context` is the supported bounded reader for live leases and recent
completed turns. It filters expired leases, limits turns per provider session,
and applies one UTF-8 byte budget to the projection without changing canonical
feed or evidence records. Use explicit limits when a reproducible context size
matters:

```sh
barbaro context \
  --project-root "$PWD" \
  --byte-budget 32768 \
  --turns-per-session 5
```

The CLI defaults to a 16384-byte budget and five turns per session. The doctor
also publishes the peer-context limits as structured guidance, backed by the
exported `PEER_CONTEXT_RENDER_BUDGET_BYTES`,
`PEER_CONTEXT_FEED_RECORDS_PER_SESSION`, and `COMPACT_LEASE_FIELDS` constants.

Before planning any work:

1. **Read active leases.** The projection includes only non-expired leases and
   compact fields such as provider, session, actor, state, expiry, claims,
   unknown write scope, and current action.
2. **Read the bounded turns.** Inspect the newest projected turns per session,
   including their sequence, timing, outcome, and touched paths. Honor every
   `shown` / `total` count rather than assuming the projection is complete.
3. **Stay inside the byte budget.** The top-level `byte_budget` and `utf8_bytes`
   make the render limit explicit. Increase it deliberately when necessary.
4. **Never print canonical JSONL as a shortcut.** Canonical feed and evidence
   stay complete on disk; the reader projects them without rewriting them. One
   busy turn can exceed an entire context budget on its own.
5. **Open evidence on demand only.** Follow an `evidence_ref` needed for the
   task, never scan the whole evidence directory into context.
6. **Restate before editing.** Say what peer activity you observed and what
   your exact file scope is, then run `barbaro context` again before each edit.

## Reading a doctor report

Treat a doctor report as a snapshot of the checkout it inspected. In this
repository, `workspace.isolation` should report that Git is present. That means
separate worktrees are available; it does not mean actors sharing this worktree
are isolated from one another. Stale coordination views must likewise be
treated as no current peer context rather than as old-but-trustworthy context.

`build.dist-freshness` failing is the normal steady state *during* parallel
work and clears when a lane lands and someone rebuilds. It matters because a
stale `dist/` means the running hooks are an older Barbaro than the source in
front of you.

## Tests

`test/setup/` covers the library directly, including two invariants that are
easy to lose by accident:

- **No canonical leakage** — a canary string planted inside `.barbaro/feed`,
  `.barbaro/evidence`, and `.barbaro/active` must not appear anywhere in the
  serialized report, and neither may session file names.
- **No writes** — a `path|size|mtime` census of the whole fixture tree is taken
  before and after a full doctor run and must be byte-identical.
