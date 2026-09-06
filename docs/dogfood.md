# Dogfooding Barbaro inside the Barbaro repository

Barbaro coordinates parallel coding agents by publishing three project-local
views. Dogfooding means running those agents *on this repository*, with this
repository's own hooks feeding `.barbaro/`. That is useful and slightly
recursive: the tool under development is also the coordination layer the
developers depend on, and a broken build silently breaks coordination.

This document describes the preflight, the parallel-actor protocol, and the
bounded peer-context procedure used in this checkout.

## The public doctor

Run `barbaro doctor --project-root "$PWD"` before live verification; add
`--json` for the stable `barbaro.doctor.v1` report. Exit 0 means every check
passes, 1 means a warning or failure needs attention, and 2 means invalid CLI
usage. Doctor never installs, edits, repairs, enrolls a session, or runs a
configured hook command. Its bounded readers report source paths, hashes,
counts and evidence metadata without canonical request/response bodies.

The public command reads documented user, project, local and managed file
layers. Codex uses `CODEX_HOME` (default `$HOME/.codex`) for user configuration;
Claude uses `CLAUDE_CONFIG_DIR` (default `$HOME/.claude`). Codex user skills
remain under `$HOME/.agents/skills`. Hook arrays merge across scopes: a valid
user installation needs no project settings. Duplicate Barbaro roles are
reported separately from unrelated hook stacks. Provider trust, launch-time
settings, plugins and managed sources outside the inspected files remain
explicit limitations; confirm effective execution in the provider's `/hooks`
view and through the live exchange.

| Check | Evidence |
|---|---|
| `runtime.identity` | Literal CLI paths, package and build versions, and a build manifest covering every emitted JavaScript file. Different builds and partial replacements are visible. |
| `<provider>.hooks` | Required roles, disabled settings, duplicates, command resolution, matcher limits and async mode. SessionEnd ingestion is synchronous. |
| `<provider>.interpreter` | Resolved literal interpreter or supported Node shebang. A version is verified only when the interpreter is the same executable as the current doctor process. |
| `<provider>.skills` | User/project skill hashes compared with the configured runtime's shipped copies; missing, differing and shadowed copies remain visible. |
| `store.ignore` | Git's effective ignore rule, including global rules and `.git/info/exclude`, plus already tracked store files. Git environment overrides are excluded from this query. |
| `store.health` | Supported bounded store-health checks and explicit refusal/coverage diagnostics. |
| `<provider>.publication` | Current members' canonical publication timestamps and ingest-attempt evidence, including an `ok` outcome with a publication blocker. |
| `<provider>.delivery` | Bounded hook observations, pending/expired reservations, current build identity and saved-feed availability. |
| `build.dist-freshness` | Source/output timestamps in a Barbaro development checkout, separately from installed/runtime identity. |

Publication and delivery have separate `observed_working`, `stale`,
`unverified` and `attention` states. The reference freshness interval is 15
minutes. A configured hook is not a live observation. A canonical publication
proves publication; it does not prove every configured hook executes.
Delivery is observed working only after a recorded verified model delivery
matches a currently verified build. The hook-owned delivery journal retains
16 observations per session and an omitted count; it contains hashes and
fixed reason codes, never commands or output. Reservations and staged output
alone prove no acknowledgment. Missing journals, unfamiliar producer versions
or shapes, and reservations that expire without a commit remain explicit.
Claude's accepted shape does not itself attest its producer version.

Live-evidence selection streams the complete scoped enrollment roster. Each
candidate contributes its newest known canonical publication, main-lease time
and participation time before the eight-members-per-provider display cap.
Only the eight newest candidates are retained in memory; enumeration work
scales with enrollment count, while each feed suffix is bounded to 1 MiB.
The separate store-health census retains its 64-entry category cap. Neither
that census nor an id-sorted catalogue decides which live members appear.

The report declares its scan, actor, saved-feed and output bounds. Limited
coverage does not erase a selected member's positive publication or verified
delivery. The provider state is `observed_working` when such recent evidence
exists, with limited coverage and counts of other attention items beside it.
The diagnostic remains a warning when coverage or another selected session
needs attention. Older selected sessions retain their own stale/unverified
states. Coverage limits cannot establish absence or healthy quiet. Missing saved feeds remain
unread obligations: restore the original feed or investigate with supported
readers. There is no supported retire-feed operation. Raising observer limits
does not raise the fixed acknowledgment limits (64 MiB per feed, 8 MiB per
record). Retention remains outside this implementation.

The legacy `runSetupDoctor()` / `formatSetupDoctorReport()` library remains
available under `dist/src/setup/index.js` with its original project-only
`barbaro.setup.doctor.v1` contract. Use `runDoctor()` / `formatDoctorReport()`
for effective user/project installation checks.

## Parallel actors and checkout boundaries

Choose the boundary deliberately. Separate worktrees isolate filesystem writes
but are separate Barbaro projects: they do not share a `.barbaro/` store,
workstream, context, or advisory claims. Actors that need Barbaro coordination
must use this same checkout and protect it with disjoint path ownership. A
branch name alone never isolates filesystem writes.

1. **Pick isolation or one shared coordination store.** Use a worktree and
   branch per actor when filesystem isolation matters more than shared Barbaro
   context. Use one checkout only when the actors need the same workstream.
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
   user explicitly invokes `/barbaro new|join <name>` in Claude Code or
   `$barbaro new|join <name>` in Codex — a bare invocation only lists the
   workstreams; nothing in `src/setup/` enrolls it automatically.

A lane prompt that works looks like:

> /barbaro join <workstream> Your lane: *one sentence of intent*. Own only
> `src/<area>/**`, `test/<area>/**`, and `docs/<file>.md`. Do not edit
> *(explicit list)*.

Create the workstream first with `barbaro workstream new <name>` (or let the
first actor do it with `/barbaro new <name> …`); every later actor joins it by
name so their peer context and wake-ups stay scoped to that objective.

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

Once every lane has landed, run the combined tests and package checks in an
isolated source snapshot. If hooks execute this checkout's `dist/`, switch the
complete reviewed build only at an approved idle rollout boundary with a
recovery bundle; a shared `npm test` would replace that running build.

## Peer context and project-wide claims

Use the observer `barbaro context --all-workstreams --project-root "$PWD"` for
project-wide leases and claims. Delivery context is scoped to a joined session:

```sh
barbaro read context \
  --provider codex \
  --session-id "$CODEX_SESSION_ID" \
  --project-root "$PWD" \
  --byte-budget 8192 \
  --turns-per-session 5
```

Use the Claude provider and `CLAUDE_CODE_SESSION_ID` in Claude. The delivery
budget includes the full envelope and newline. Run one foreground read with
unfiltered output; the CLI is read-only and only provider-verified delivery
acknowledges complete canonical attention fields. Older gaps remain unread.
Legacy `context` and `turn show` are observers under alpha.6 hooks. The complete delivery envelope and newline must stay within 8192 bytes. Follow an approved staged runtime
plan when upgrading live hooks; never rebuild the running `dist/` mid-session.

Before planning any work:

1. **Read active leases.** The projection includes only non-expired leases and
   compact fields such as provider, session, actor, state, expiry, claims,
   unknown write scope, and current action.
2. **Read the bounded turns.** Inspect the newest projected turns per session,
   including their sequence, timing, outcome, and touched paths. Honor every
   `shown` / `total` count rather than assuming the projection is complete.
   Context is a bounded attention view whose per-session window can omit older
   turns even when shown equals total. Use the exhaustive index whenever
   completeness or absence matters; any rendered content with
   `truncated.projection: true`, `turns.shown < turns.total`, or a nudge count
   above what context showed requires exact retrieval.
3. **Stay inside the byte budget.** The top-level `byte_budget` and `utf8_bytes`
   make the render limit explicit. Actual output above 8192 bytes is observer-only;
   use exact pages when acknowledgement is needed.
4. **Escalate through supported readers.** Run `barbaro turn list` in the same
   scope with the same provider/session/project flags, then `barbaro read turn show <turn_id> --field response`; follow each
   `next_cursor` with `--cursor`. `turn show` also pages exact `record`,
   `request`, and `actions` fields. If a page reports
   `representation: "json-string"`, concatenate all page text and JSON-parse it
   once.
5. **Open evidence on demand only.** Follow a needed `evidence_ref` with
   `barbaro evidence show`, using its exact `record`, `content`, `request`,
   `response`, or `actions` field when the bounded projection is insufficient.
   Never read or print `.barbaro/**/*.jsonl` directly.
6. **Restate before editing.** Say what peer activity you observed and what
   your exact file scope is, then inspect `barbaro context --all-workstreams --project-root "$PWD"`
   again before each edit.

Within the readers' exposed `--max-file-bytes` and `--max-record-bytes` limits,
lossless retrieval means every byte of a canonical Barbaro turn plus its
referenced canonical evidence remains reachable through those commands. Raise
the limits deliberately for larger stores or records. This does not claim that
provider-raw fields or records omitted during adapter mapping are present.

## Reading a doctor report

Treat a doctor report as a snapshot of the checkout it inspected. A Git checkout can support separate worktrees, but actors in this checkout still share its files. Stale coordination views must likewise be
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
  serialized report, The public report may name stable session IDs and feed identities needed for diagnosis; the legacy library retains its stricter metadata-only contract.
- **No writes** — a `path|size|mtime` census of the whole fixture tree is taken
  before and after a full doctor run and must be byte-identical.
