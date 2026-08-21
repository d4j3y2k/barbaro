---
name: barbaro
description: Explicitly join the current Codex session to Barbaro live coordination. Use only when the user invokes $barbaro or selects Barbaro in the composer; never infer participation or invoke this skill automatically.
---

# Join Barbaro

Treat this invocation as explicit consent for the current provider session to
publish its derived coordination state through the installed Barbaro hooks.

- Codex submits this selection as a leading `[$barbaro](.../SKILL.md)`
  attachment. The `UserPromptSubmit` hook owns enrollment and recognizes the
  exact Barbaro skill installed either for the current project or at the
  user-wide `$HOME/.agents/skills/barbaro/SKILL.md` location.
- Confirm enrollment read-only before telling the user it is on:
  `barbaro codex status --session-id "$CODEX_SESSION_ID" --project-root "$PWD"`.
  Use `CODEX_SESSION_ID`, never `CODEX_THREAD_ID` (a subagent may have a
  different physical thread ID).
- Continue with any task included in the same prompt.
- Do not create or edit `.barbaro/` participation markers manually. Do not
  call `SessionParticipationStore` or simulate a hook to enroll a session.
- Do not join another session unless the user invokes this skill there too.
- Say Barbaro is on only when status returns `"joined":true`. Otherwise say
  that the join request was made but Barbaro could not be confirmed active.
