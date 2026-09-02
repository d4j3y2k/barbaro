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
  `barbaro context --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`
  (scoped to this workstream). Newest turns per session are under
  `.value.turns.items[]`; when projected there, a peer's answer excerpt is its
  `response.text`. The leading context tool hook acknowledges every currently
  unread peer turn and re-arms Barbaro's nudge channels after Codex admits the
  same active turn or a trace-attested fresh goal-turn `PreToolUse`. An
  idle same-turn, stale, or unattested boundary leaves the cursor unchanged;
  the command itself is read-only.
- Context and nudges guide bounded attention; neither is a complete transcript.
  The per-session context window can omit older turns even when shown equals
  total, so use the exhaustive reader whenever completeness or absence matters.
  Always switch to it if any rendered content has `truncated.projection: true`,
  if `.value.turns.shown < .value.turns.total`, or if the nudge count exceeds
  the number of turns context showed. Run
  `barbaro turn list --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`
  and follow `.value.turns.next_cursor` with `--cursor` until complete. For each
  relevant ID, run
  `barbaro turn show <turn_id> --field response --provider codex --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`.
  Follow `.value.next_cursor` with `--cursor` and concatenate `.value.text` in
  order. Use `--field request` for the exact request or `--field record` for
  the entire canonical turn.
- Retrieve referenced canonical evidence with the provider and canonical
  session ID from its owning turn:
  `barbaro evidence show <evidence_id> --provider <turn_provider> --session-id <turn_session_id> --field record --project-root "$PWD"`.
  Follow `.value.next_cursor` as above; use `--field content`, `request`,
  `response`, or `actions` when only that exact evidence field is needed.
  Never read `.barbaro/*.jsonl` directly.
- Barbaro's losslessness guarantee covers every byte of each canonical
  `barbaro.turn.v1` record plus every referenced canonical evidence record
  through these supported commands. Provider-raw omissions made before
  canonicalization stay outside that guarantee.
- Barbaro may add a one-line nudge beginning `Barbaro: N new peer turns` and
  ending `run barbaro context` at a prompt, tool, or Stop boundary. This never
  starts a turn. Within one cursor revision, prompt and tool nudges repeat only
  when the unread count has grown; Stop does not block a turn that already
  received a nudge for that revision, but may block once on a later turn while
  those turns remain unread. When a nudge appears, run the context command
  above exactly once, weigh the peer turns, and continue. If a Stop hook blocks
  the response, context is the first action in that continuation; then resend
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
  command above once to clear the cursor and read the content, then react and
  end the turn. If the tool execution yields, do not launch a replacement
  await; concurrent waiters are nondestructive, but one await per iteration
  avoids duplicate work. Do not turn this into polling, pings, or timers.
  While waiting, do work the reply does not gate. A pending review is
  `WAITING: …`, not `BLOCKED`/`BLOCKER` — those pause a goal and require a
  human to resume it, so reserve them for something you truly cannot route
  around.
- Before writing a file, look at `active` claims in context; if a peer
  currently claims that path, wait or say so rather than writing over it.
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
