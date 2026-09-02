---
name: barbaro
description: Join this Claude Code session to a Barbaro workstream with `/barbaro new <name>` or `/barbaro join <name>`, or list the project's workstreams with a bare `/barbaro`.
disable-model-invocation: true
---

# Barbaro workstreams

A workstream is the group of Codex and Claude sessions sharing one objective
in this project. This session belongs to one workstream at a time and may move
forward to another open one; earlier records stay where they happened. The
installed Barbaro hook — never you — parses the invocation:

- `/barbaro new <name> [task…]` — create the workstream and join it.
- `/barbaro join <name> [task…]` — join an existing open workstream.
- `/barbaro` — bare: list workstreams and join nothing. `/barbaro <text>`
  without `new`/`join` is also bare.

On a bare or join-related invocation the hook prints the outcome — the open
roster, a confirmation, or the refusal reason — into this turn's context.

## What to do

1. Confirm read-only:
   `barbaro claude status --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`.
2. `"joined":true` with a `workstream` object: say which workstream this
   session is in, then continue with the task below if one was supplied.
3. `"joined":false` — a bare invocation, or a refused `new`/`join`: run
   `barbaro workstream list --project-root "$PWD"`, show the open workstreams
   (or say none exist), and ask the user to re-invoke as
   `/barbaro join <name>` or `/barbaro new <name>`. **Do not start the task
   below.** The user asked for coordination; hold the task and continue it
   once they have joined in a later turn.
4. If the hook reported a refusal — name already taken, no such workstream,
   completed workstream, or invalid name — repeat the reason plainly. An
   invocation targeting a different open workstream moves this session
   forward and the hook reports the new current target.
5. `"joined":true` with `"unscoped":true`: this session joined before
   workstreams existed and is still project-wide. Ask the user to re-invoke
   with `join`/`new` if they want to move it forward; earlier turns stay
   unscoped.

Never write into `.barbaro/`, never call `SessionParticipationStore` or
`WorkstreamStore`, never run `barbaro workstream new` to get a session
enrolled, and never simulate a hook. Enrollment belongs to the provider hook
carrying the user's exact invocation. Say Barbaro is on only when status
returns `"joined":true`.

## Working with peers through Barbaro

Barbaro is the channel between the sessions in this workstream. Peers see
your **completed turns** — request, final response, actions, changed files —
and your live write claims. They never see a turn in progress, so how you end
turns is how you talk.

None of this requires a long-running loop or a watcher. A person may drive
each session directly and relay between them, or run a session alone in a
workstream; the peer context is simply there whenever a session reads it,
and the handshake below is only for gated review. Do not start polling,
waiting on peers, or reviewing on your own initiative — only when the user
sets that up.

- To tell a peer something, say it in the final message of a turn and end the
  turn; it publishes seconds after the turn ends. To be woken when peers
  post, arm `/barbaro-watch`; its Monitor is Claude's primary wake mechanism.
- To read the bounded peer-attention view:
  `barbaro context --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`
  (scoped to this workstream). Newest turns per session are under
  `.value.turns.items[]`; when projected there, a peer's answer excerpt is its
  `response.text`. The leading context tool hook acknowledges every currently
  unread peer turn and re-arms Barbaro's nudge channels; the command itself is
  read-only.
- Context and nudges guide bounded attention; neither is a complete transcript.
  The per-session context window can omit older turns even when shown equals
  total, so use the exhaustive reader whenever completeness or absence matters.
  Always switch to it if any rendered content has `truncated.projection: true`,
  if `.value.turns.shown < .value.turns.total`, or if the nudge count exceeds
  the number of turns context showed. Run
  `barbaro turn list --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`
  and follow `.value.turns.next_cursor` with `--cursor` until complete. For each
  relevant ID, run
  `barbaro turn show <turn_id> --field response --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`.
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
  above exactly once, weigh the peer turns, and continue. If Stop hook feedback
  blocks the response, context is the first action in that continuation; then
  resend the previous response verbatim unless peer context warrants changing
  it. Do not treat the synthetic feedback as a new user request.
- Waiting for a reply is normal, not a blocker: end your turn and let the
  `/barbaro-watch` Monitor wake you. Without a watcher, use Bash for one
  watcher-less one-shot wait per turn:
  `barbaro await --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD" --timeout-ms 540000`.
  Set that Bash tool call's `timeout` to `600000` ms; Bash defaults to 120 s
  and caps at 600 s, approximately `barbaro await`'s default. The shorter
  child deadline leaves Bash time to return the timeout result. Await is a
  read-only cursor observer: it returns immediately for peer turns that were
  already unread, and every peer turn counts, including a review verdict
  published from a Monitor wake. It reports availability but does not
  acknowledge it. When it returns — unread or timeout — read
  `barbaro context --provider claude --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`
  once to clear the cursor and read the content, then react and end the turn.
  Never start a second await in the same turn; concurrent waits are
  nondestructive, but duplicate waits do no useful work. Do not turn this into
  polling. A pending review is `WAITING`, not `BLOCKED`. Never loop pings or
  arm timers just to re-publish — a finished turn already publishes on its
  own.
- Before writing a file, look at `active` claims in context; if a peer
  currently claims that path, wait or say so rather than writing over it.
- Shared handshake, so nobody has to spell it out in a prompt: ask for review
  with `PLAN REQUEST v1: <summary, file>` or
  `CHECKPOINT N: <what changed, commit sha, how to verify>`; a reviewer answers
  in one turn that begins with `PLAN APPROVED`, `PLAN REVISE: …`,
  `CHECKPOINT N APPROVED`, or `CHECKPOINT N REVISE: …`; close with
  `DONE: <commits>`. Do not start the next gated phase before its `APPROVED`.
- A verdict is the peer turn whose response *begins with* one of those
  keywords. Other peer turns — a person's main session thinking aloud, a
  direction like "also handle X", a status line — are context or
  instructions to weigh, never verdicts. A workstream may hold several
  sessions of the same provider; tell them apart by what they say, not by
  provider.
- The hooks publish for you; never write into `.barbaro/`.

Arguments supplied with the command: $ARGUMENTS
