# Codex 0.153.2 delivery surfaces

Captured September 5, 2026 with the installed `/opt/homebrew/bin/codex` CLI,
using `codex exec`, a scratch working directory, and four synthetic commands.
The model used the desktop code-mode host's `exec` tool. This is real provider
output, not a manually generated hook lifecycle. The fixture session never
joined a Barbaro workstream.

The successful capture's invocation enabled and trusted only its vetted logger.
An effective `hooks/list` inventory verified the entire invocation-local
`hooks.state` table. Existing user hooks were disabled for that invocation;
persistent user hook files, trust state, and the shared runtime were unchanged.
Earlier capture attempts produced no logger payloads because dotted override
keys containing source paths did not establish the intended trust entries.
Those attempts are not delivery evidence. They may have emitted dormant-session
incidents through the existing user hooks.

## Evidence retained

The numbered JSON files are captured hook stdin with home and scratch-root paths
replaced by literal `$HOME` and `$CAPTURE_ROOT`. Each matching trace fixture is
the selected prefix of the original append-only provider trace at the byte size
observed by the logger during that hook. The prefix was reconstructed from the
final trace; no later bytes are included. The final trace fixture includes all
selected completed synthetic calls. Only session identity/version, turn
boundaries, command execution completions, and model tool calls/results remain.
Session instruction bodies and unrelated transcript messages were omitted.
`manifest.json` records the sanitized artifact hashes.

## Observations

- Every terminal unified-exec PostToolUse has canonical `tool_name: "Bash"`,
  exactly `tool_input: { command }`, a native `exec-...` tool-use id, and a
  **string** tool response. There is no exit code in that hook payload.
- The failed command also emits PostToolUse. Its native CommandExecution has
  numeric exit code 3 and status `failed`; the forwarded model result also has
  numeric exit code 3. A PostToolUse event alone proves no success.
- The paginated provider trace contains `event_msg` / `item_completed` /
  `CommandExecution` with the same native id, exact shell argv, cwd, output,
  status, and numeric exit code. This native completion is already present in
  the small command's PostToolUse prefix.
- Model-facing output is a later `custom_tool_call_output` bound to its outer
  `custom_tool_call.call_id`. That output is absent at the corresponding
  PostToolUse boundary and present by the next natural boundary.
- The captured wrapper is one literal expression:
  `text(await tools.exec_command({cmd:"...",max_output_tokens:10000}));`
  Its model result is exactly two `input_text` blocks: the host's completion
  header and a serialized result object containing numeric `exit_code` and
  `output`. The native command completion lies between this single outer call
  and its result. Ambiguous intervals, arbitrary JavaScript, multiple forwarded
  results, or transformed output are not granted acknowledgement authority.
- The 9,000-byte output remains intact on both surfaces. This exceeds Barbaro's
  independent 8,192-byte acknowledgement ceiling. Actual oversized envelopes
  remain observers even if the provider delivers them intact.
- A 5,000-byte command with a 64-token request produces a marked shortened hook
  string and shortened forwarded model output. Its native stdout remains full.
  Neither the requested token limit nor native stdout proves what the model saw.

A separate scratch probe disabled the code-mode host and code-mode features.
The current model's four exec attempts failed with `code-mode host is disabled`;
that run supplied no direct-tool compatibility evidence. The adapter admits only
the captured 0.153.2 paginated, literal-forwarding form. Unknown versions, trace
shapes, direct tools, and wrappers remain unread. Interactive live rollout and
its recovery checks are still required by the approved delivery plan.
