---
name: barbaro
description: Explicitly join the current Claude Code session to Barbaro live coordination.
disable-model-invocation: true
---

# Join Barbaro

Treat this invocation as explicit consent for the current Claude Code session
to publish its derived coordination state through the installed Barbaro hooks.

- Confirm enrollment read-only before saying it is on:
  `barbaro claude status --session-id "$CLAUDE_CODE_SESSION_ID" --project-root "$PWD"`.
- Continue with the task below when one was supplied.
- Do not create or edit `.barbaro/` participation markers manually. Do not
  call `SessionParticipationStore` or simulate a hook to enroll a session; the
  provider hook owns enrollment.
- Do not join another session unless the user invokes `/barbaro` there too.
- Say Barbaro is on only when status returns `"joined":true`. Otherwise say
  that the join request was made but Barbaro could not be confirmed active.

Task supplied with the command: $ARGUMENTS
