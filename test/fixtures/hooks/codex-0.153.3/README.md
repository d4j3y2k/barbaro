# Codex desktop 0.153.3 transport fixture

Derived from the transport shape observed on 2026-09-05. Native session metadata
identified producer `0.153.3`; the separately installed CLI was `0.153.2`.

The public fixture replaces every output body with synthetic observer text and
replaces session, turn, call, execution, process, and chunk identifiers. It keeps
the literal forwarded command, native CommandExecution completion, two-block
model result, and their correlation. The output remains 8,185 bytes including
its newline, with `eligible:false`; it is not a delivery receipt. The envelope's
`utf8_bytes` is 8,184, excluding the final newline.

`pre.reconstructed.trace.jsonl` is a reconstructed prefix, not a captured
PreToolUse snapshot. It tests open-call recognition, not real reservation timing.
The public regression checks native/model equality, exact producer pinning,
and refusal of altered output, failed commands, wrong cwd, or unsupported shape.
Separate synthetic hook lifecycle tests exercise reservation and acknowledgment.
Private session bodies and review evidence are not included.
