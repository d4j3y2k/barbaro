---
name: barbaro
description: Join this Codex session to a Barbaro workstream with `$barbaro new <name>` or `$barbaro join <name>`, or list the project's workstreams with a bare `$barbaro`. Use only when the user invokes $barbaro or selects Barbaro in the composer; never infer participation or invoke this skill automatically.
---

# Barbaro workstreams

A workstream is the group of Codex and Claude sessions sharing one objective
in this project. This session belongs to one workstream at a time and may move
forward to another open one; earlier records stay where they happened. The
installed Barbaro `UserPromptSubmit` hook — never you — parses the invocation:

- `$barbaro new <name> [task…]` — create the workstream and join it.
- `$barbaro join <name> [task…]` — join an existing open workstream.
- `$barbaro` — bare: list workstreams and join nothing. `$barbaro <text>`
  without `new`/`join` is also bare.

Codex submits a composer selection as a leading `[$barbaro](…/SKILL.md)`
attachment followed by a newline; the verbs may follow it on the same line
or on the next one, and a repeated `$barbaro`/`/barbaro` typed after the
attachment is tolerated. The hook recognizes the exact Barbaro skill
installed for the current project or at the user-wide
`$HOME/.agents/skills/barbaro/SKILL.md`.

These delivery commands require matching alpha.6 hooks and CLI. During an
explicitly staged rollout, follow the approved runtime plan; do not replace a
running build merely to update guidance. With alpha.6 hooks, legacy `context`
and `turn show` remain observers.

## What to do

1. Confirm read-only:
   `barbaro codex status --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`.
   Use `CODEX_SESSION_ID`, never `CODEX_THREAD_ID` (a subagent may have a
   different physical thread ID).
2. `"joined":true` with a `workstream` object: say which workstream this
   session is in, then continue with any task included in the prompt.
3. `"joined":false` — a bare invocation, or a refused `new`/`join`: run
   `barbaro workstream list --project-root "$PWD"`, show the open workstreams
   (or say none exist), and ask the user to re-invoke as
   `$barbaro join <name>` or `$barbaro new <name>`. **Do not start the task.**
   The user asked for coordination; hold the task and continue it once they
   have joined in a later turn. Likely refusal reasons: the name is already
   taken (use `join`), no such workstream (use `new`), the workstream is
   completed, or the name is invalid. An invocation targeting a different
   open workstream moves this session forward and status reports that target.
4. `"joined":true` with `"unscoped":true`: this session joined before
   workstreams existed and is still project-wide. Ask the user to re-invoke
   with `join`/`new` if they want to move it forward; earlier turns stay
   unscoped.

Never create or edit `.barbaro/` markers, never call
`SessionParticipationStore` or `WorkstreamStore`, never run
`barbaro workstream new` to get a session enrolled, and never simulate a hook.
Say Barbaro is on only when status returns `"joined":true`.

## Working with peers through Barbaro

Barbaro is the channel between the sessions in this workstream. Peers see
your **completed turns** — request, final response, actions, changed files —
and your live write claims. They never see a turn in progress, so how you end
turns is how you talk.

None of this requires a goal, a long-running loop, or a watcher. A person
may drive each session directly and relay between them, or run a session
alone in a workstream; the peer context is simply there whenever a session
reads it, and the handshake below is only for gated review. Do not start
polling, waiting on peers, or reviewing on your own initiative — only when
the user sets that up.

- To tell a peer something, say it in the final message of a turn and end the
  turn. A peer running a watcher wakes within seconds; its reply lands as a
  turn of its own, seconds after it finishes.
- To read the bounded peer-attention view:
  `barbaro read context --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`
  (scoped to this workstream). Newest turns per session are under
  `.value.turns.items[]`; when projected there, a peer's answer excerpt is its
  `response.text`. The CLI is read-only. PreToolUse reserves a native read;
  only successful delivery of the complete canonical response (or request when
  no response exists) acknowledges that turn. Exact pages accumulate only for
  the same record/field hash with no missing ranges. A partial window leaves
  older gaps unread; launching a command never clears the unread scan.
- Run each read as one foreground command, without pipes, redirection,
  composition, output filtering, or background execution. Keep the complete
  envelope and newline within the default 8192-byte budget. Larger actual
  output is observer-only. `delivery.eligible` describes a candidate, not proof
  of acknowledgement: failed, truncated, missing or unsupported model output
  consumes nothing. Turn lists and evidence are always observers.
- In Codex code mode, forward exactly one literal result:
  `text(await tools.exec_command({cmd:"barbaro read context ...",max_output_tokens:10000}));`
  Replace the ellipsis with the identity/project flags above. Do not assign,
  batch, transform, or omit the result. The supported 0.153.2 or 0.153.3 trace must prove
  both native success and the later full model output; acknowledgement can
  wait until the next natural boundary before its nudge or Stop decision.
- Context and nudges guide bounded attention; neither is a complete transcript.
  The per-session context window can omit older turns even when shown equals
  total. Honor `.value.coverage.history` and its window/projection/attention
  counts. Use the exhaustive reader whenever completeness or absence matters.
  Always switch to it if any rendered content has `truncated.projection: true`,
  if `.value.turns.shown < .value.turns.total`, or if the nudge count exceeds
  the number of turns context showed. Run
  `barbaro turn list --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`
  and follow `.value.turns.next_cursor` with `--cursor` until complete. For each
  relevant ID, run
  `barbaro read turn show <turn_id> --field response --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`.
  Follow `.value.next_cursor` with `--cursor` and concatenate `.value.text` in
  order. If `.value.representation` is `json-string`, JSON-parse the complete
  concatenated value once. Use `--field request` when the response is absent
  or you need the exact request; use
  `--field record` for the entire canonical turn.
- Retrieve referenced canonical evidence with the provider and canonical
  session ID from its owning turn:
  `barbaro evidence show <evidence_id> --provider <turn_provider> --session-id <turn_session_id> --field record --project-root "$PWD"`.
  Follow `.value.next_cursor` as above; use `--field content`, `request`,
  `response`, or `actions` when only that exact evidence field is needed.
  Never read `.barbaro/**/*.jsonl` directly.
- Barbaro's losslessness guarantee covers every byte of each canonical
  `barbaro.turn.v1` record plus every referenced canonical evidence record
  through these supported commands, within their exposed file and record
  limits. Provider-raw omissions are outside that guarantee when made before
  canonicalization.
- Barbaro may add a one-line nudge beginning `Barbaro: N new peer turns` and
  giving a scoped `barbaro read context` command, or reports unread gaps outside
  the delivered window, at a prompt, tool, or Stop boundary. This never
  starts a turn. Within one cursor revision, prompt and tool nudges repeat only
  when the unread count has grown; Stop does not block a turn that already
  received a nudge for that revision, but may block once on a later turn while
  those turns remain unread. When a nudge appears, run the context command
  above exactly once, weigh the peer turns, and continue. If turns remain
  outside the delivered window, use the scoped turn index and exact read pages
  to close those gaps; repeating the same context does not acknowledge them.
  If a Stop hook blocks
  the response, the indicated read is the first action in that continuation; then resend
  the previous response verbatim unless the peer context warrants changing it.
  Do not answer the synthetic Stop feedback as though it were a new user
  request.
- Waiting for a reply is normal, not a blocker. Publish the request in your
  final message and end the turn. On each later turn or goal iteration, run
  exactly one
  `barbaro await --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`.
  Await is a read-only cursor observer: it returns immediately for peer turns
  that were already unread, and every peer turn counts, including a review
  verdict published from a Monitor wake. It reports availability but does not
  acknowledge it. When await returns — unread or timeout — run the context
  command above once to inspect delivered content, then react and
  end the turn. If the tool execution yields, do not launch a replacement
  await; concurrent waiters are nondestructive, but one await per iteration
  avoids duplicate work. Do not turn this into polling, pings, or timers.
  While waiting, do work the reply does not gate. A pending review is
  `WAITING: …`, not `BLOCKED`/`BLOCKER` — those pause a goal and require a
  human to resume it, so reserve them for something you truly cannot route
  around.
- Before writing a file, inspect `.value.project_claims` in scoped context.
  This separate project-wide view includes foreign paths before your own hook
  announces a write; conversation and ordinary activity stay scoped. Claims
  name the workstream (null means unscoped), actor, confidence, unknown scope
  and expiry. Exact matching paths and ancestor/descendant paths can overlap;
  directory overlaps are inferred, and unknown scope alone is no collision.
  These are advisory claims, never locks. If a peer claims the path, wait or
  say so before writing. Inspect claims/overlaps shown and total counts and
  coverage: omitted or invalid claims cannot prove a path free. Use observer
  `barbaro context` with a larger `--byte-budget` in the same scope when needed;
  if the view remains incomplete, resolve that uncertainty before writing.
  During the approved alpha.5 staged runtime, use the legacy project-wide
  observer `barbaro context --all-workstreams --project-root "$PWD"`.
- Shared handshake, so nobody has to spell it out in a prompt: ask for review
  with `PLAN REQUEST v1: <summary, file>` or
  `CHECKPOINT N: <what changed, commit sha, how to verify>`; a reviewer answers
  with `PLAN APPROVED`, `PLAN REVISE: …`, `CHECKPOINT N APPROVED`, or
  `CHECKPOINT N REVISE: …`; close with `DONE: <commits>`. Do not start the
  next gated phase before its `APPROVED`.
- A verdict is the peer turn whose response *begins with* one of those
  keywords. Other peer turns — a person's main session thinking aloud, a
  direction like "also handle X", a status line — are context or
  instructions to weigh, never verdicts. A workstream may hold several
  sessions of the same provider; tell them apart by what they say, not by
  provider.
- The hooks publish for you; never write into `.barbaro/`.
