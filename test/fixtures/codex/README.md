# Codex adapter fixtures

Every `*.input.jsonl` is a sanitized rollout-shaped byte stream. Its paired
`*.expected.json` contains byte-exact Barbaro turn records under `turns` and
extra parser assertions under `oracle`.

Rules for the corpus:

- each object in `turns` validates independently as `barbaro.turn.v1`;
- source line numbers are one-based physical lines in the input file;
- fixture IDs use the Barbaro v1 typed hash with no trailing NUL after the last
  length-prefixed part;
- action record identity is `response_item:id:<id>` where these fixtures supply
  a response item ID;
- `partial-final-line.input.jsonl` deliberately ends in invalid JSON with no
  terminating LF byte. That final record is a simulated in-progress append and
  must not fail or alter the completed turn before it;
- `oracle.preserved_records` means retain the raw source identity and payload
  for inspection. It does not mean emit a common Barbaro feed/evidence record.

The text, UUIDs, paths, outputs, scores, and errors are synthetic. After an
intentional ID or normalizer change, regenerate the turn records with
`npm run fixtures:regenerate` and review the resulting diff.

`test/providers/codex/fixtures.test.ts` is the executable harness. It injects
the `trace_id` stored in each expected turn, deliberately supplies no
`trace_path`, and uses the local fixture path only to read bytes. The default
suite checks reader behavior, stable IDs, core turn semantics, pairing, drift
diagnostics, and byte-exact turn conformance.

| Fixture | Target behavior |
|---|---|
| `success-turn` | Normal `task_started` → final answer → `task_complete`. |
| `aborted-turn` | `turn_aborted/interrupted` becomes `cancelled`. |
| `failed-turn` | `task_complete.error` becomes `failed`. |
| `tool-pairing` | Function/custom outputs pair by `call_id`, not adjacency; action order follows calls. |
| `duplicate-projections` | Legacy `event_msg` text projections do not duplicate request/response. |
| `repeated-session-meta` | First valid metadata remains canonical. |
| `unknown-types` | Unknown outer and both nested discriminators are preserved and skipped. |
| `partial-final-line` | An incomplete final append is ignored and retried later. |
| `security-risk-score-head` | Current-main outer variant is forward-compatible with the pinned producer parser. |
| `paginated-turn` | `history_mode: paginated` (Codex Desktop 0.149+): `item_completed` `CommandExecution`/`FileChange` projections become test, command, and file-change actions; an exec call with projected items yields no second generic tool action. |
