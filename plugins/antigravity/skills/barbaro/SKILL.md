---
name: barbaro
description: Use when the user invokes /barbaro or $barbaro to list workstreams or join this Antigravity CLI conversation to a shared workstream.
---

# Barbaro workstreams

A leading `/barbaro new NAME` creates and joins a workstream.
`/barbaro join NAME` joins an existing open workstream. A bare `/barbaro`
lists workstreams. b-rex uses the equivalent `$barbaro join NAME` when
launching a selected workstream. Only an explicit invocation enrolls a
conversation. The provider hook handles enrollment.

Use the joined checkout's absolute project path wherever the examples say
`ROOT`, even after a directory change. Antigravity exports the native
conversation ID in `ANTIGRAVITY_CONVERSATION_ID`.

- Verify membership with `barbaro agy status --session-id "$ANTIGRAVITY_CONVERSATION_ID" --project-root "ROOT"`.
  Confirm the requested workstream before starting the attached task. If the
  hook refused enrollment, report its reason and the available workstreams.
- Read peers with `barbaro read context --provider agy --session-id "$ANTIGRAVITY_CONVERSATION_ID" --project-root "ROOT"`.
  Run a single foreground `run_command` and keep its complete, unfiltered output.
  When the hook reports unread turns, read once and act on the peer's response.
- Before editing, inspect `.value.project_claims`, including its coverage.
  If another session claims the same file, coordinate with that session. Native
  edit tools publish advisory path claims while they run.
- Put the result, relevant paths and requests for peers in the final response.
  The hook publishes the turn when Antigravity finishes it.
- When the user asks you to wait for a peer, use
  `barbaro await --provider agy --session-id "$ANTIGRAVITY_CONVERSATION_ID" --project-root "ROOT"`,
  then read context once. Resume work after inspecting the reply.

## Retrieve complete peer history

Context provides bounded attention. Its per-session window can omit older turns even when shown equals
total. Use the full turn index whenever completeness or absence matters.
Page the index if rendered content has `truncated.projection: true`, if
`.value.turns.shown < .value.turns.total`, or if the nudge count exceeds
the number of turns shown.

1. Run `barbaro turn list --provider agy --session-id "$ANTIGRAVITY_CONVERSATION_ID" --project-root "ROOT"`.
   Follow `.value.turns.next_cursor` with `--cursor` until complete.
2. Run `barbaro read turn show <turn_id> --field response --provider agy --session-id "$ANTIGRAVITY_CONVERSATION_ID" --project-root "ROOT"` for a peer's full answer.
   Follow `.value.next_cursor` with `--cursor` and concatenate `.value.text` in order.
   If `.value.representation` is `json-string`, JSON-parse the complete
   concatenated value once. Use `--field request` for the exact prompt or
   `--field record` for the complete canonical turn.
3. For referenced canonical evidence, run
   `barbaro evidence show <evidence_id> --provider <turn_provider> --session-id <turn_session_id> --field record --project-root "ROOT"`
   using the provider and canonical session ID from its owning turn. Follow
   `.value.next_cursor` as above. Never read `.barbaro/**/*.jsonl` directly.

These readers preserve each canonical `barbaro.turn.v1` record and its referenced
canonical evidence within their exposed file and record limits. Provider-raw omissions
at capture time fall outside that guarantee.
