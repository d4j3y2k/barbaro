# Claude Code hook payload fixtures for alpha.6 checkpoint 1

Captured 2026-09-05 by the reviewer session in a synthetic temporary project.
Producer: Claude Code 2.1.261, headless `claude -p --model sonnet --settings <capture hooks> --allowedTools Bash --output-format json`.
Capture hook: a shell script that writes each hook's stdin to `payloads/NNN.<event>.json` (the private capture setup is not shipped).
Model-visible text: `message.content[].tool_result.content` rows from the session transcript (transcript-tool-results.jsonl).
Synthetic session id 11111111-1111-4111-8111-000000000001 replaces the disposable capture identity. UUIDs and the encoded username are replaced consistently; `$HOME` replaces the home directory. Output byte sizes and tool-result equality are preserved.
Limitation: captured in print mode. Interactive-mode payloads are expected to match but are not proven here; the live exercise should confirm.

## Sequence observed (single Bash calls, then one parallel pair)

| step | command | events fired |
|---|---|---|
| 1 small 16 B | printf | PreToolUse, PostToolUse, PostToolBatch(1 call) |
| 2 medium 12000 B | python print M*12000 | PreToolUse, PostToolUse, PostToolBatch(1 call) |
| 3 oversized 40001 B | python print X*40000 | PreToolUse, PostToolUse, PostToolBatch(1 call) |
| 4 exit 3 with stderr | sh -c exit 3 | PreToolUse, PostToolUseFailure (no PostToolUse), PostToolBatch(1 call) |
| 5 parallel pair | two printf in one assistant message | PreToolUse x2, PostToolUse x2, PostToolBatch(2 calls) |

## Findings

1. PostToolBatch fires after every assistant tool batch, including a batch of one. Its `tool_calls[]` entries carry `tool_use_id`, `tool_name`, `tool_input`, and `tool_response` as a plain string.
2. In every case `tool_calls[].tool_response` equals the model-visible `tool_result.content` byte for byte (see checks below). This is the model-facing surface.
3. PostToolUse `tool_response` is a structured object: stdout, stderr, interrupted, isImage, noOutputExpected, plus persistedOutputPath and persistedOutputSize when output was persisted. It is NOT the model-facing text: for the 40001-byte run, stdout was cut to exactly 30000 bytes while the model saw a 2330-byte `<persisted-output>` preview naming a file.
4. Trailing newline: Claude strips the trailing newline from stdout before both PostToolUse.stdout and the model-visible text (`printf 'X\n'` arrives as `X`). A projection hash over CLI stdout must be computed on the same trimmed form or compare after trimming exactly one trailing newline.
5. Non-zero exit fires PostToolUseFailure with `error` = `Exit code N` + newline + stderr and an `is_interrupt` field; PostToolUse does not fire. PostToolBatch still fires and its tool_response is the same error text, with NO is_error marker inside `tool_calls[]`. The batch alone cannot prove success; the prior PostToolUse (not PostToolUseFailure) for the same tool_use_id is required, as the plan states.
6. `tool_use_id` is present at PreToolUse, PostToolUse, PostToolUseFailure, and inside PostToolBatch entries, so correlation by native id works across all four. Payloads also carry session_id, transcript_path, cwd, prompt_id, permission_mode, effort, and duration_ms (PostToolUse only).
7. The transcript row for a tool_result also carries `toolUseResult` mirroring the PostToolUse structured object (30000-byte stdout for the oversized run), distinct from the model-visible content.
8. 12000 bytes passed intact on every surface, so the 8 KiB ceiling sits below the observed intact regime; the 30000-byte cut and persisted-output preview are what an oversized observer read looks like.

## Oversized preview (model-visible), head and tail

```
<persisted-output>
Output too large (39.1KB). Full output saved to: $HOME/.claude/projects/-private-tmp-claude-501--Users-testuser-Developer-barbaro-11111111-1111-4111-8111-000000000004-scratchpad-hookcap-proj/11111111-1111-4111-8111-000000000001/tool-results/b541rbpmq.txt

Preview (first 2KB):
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
...
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
...
</persisted-output>
```

## Byte checks
002.PostToolBatch.json toolu_011itWi2Vd5p6VTFnV7i3diV batch==model:True bytes=16 is_error=False trailing_newline=stripped sha256[:16]=7d7fa4f1cacc2b27
005.PostToolBatch.json toolu_0128pcdbxWsUFewtJbh5h31v batch==model:True bytes=12000 is_error=False trailing_newline=None sha256[:16]=fb6b666583c85d90
008.PostToolBatch.json toolu_01XNK4MefV68oHSDACrwU9Ki batch==model:True bytes=2330 is_error=False trailing_newline=None sha256[:16]=c4597c3fd197995a
011.PostToolBatch.json toolu_017P5ahd9xcjHiD9z8tkXazz batch==model:True bytes=31 is_error=True trailing_newline=None sha256[:16]=ec3907c19c116a24
016.PostToolBatch.json toolu_01T33LnrPBnUxAQ33mjF8peY batch==model:True bytes=13 is_error=False trailing_newline=stripped sha256[:16]=5755ffd7fc4589d7
016.PostToolBatch.json toolu_01UX9KYQzYtEVzB9XRhGz4Ki batch==model:True bytes=13 is_error=False trailing_newline=stripped sha256[:16]=8908da4bd5013094
001.PostToolUse.json toolu_011itWi2Vd5p6VTFnV7i3diV stdout==model:True stdout_bytes=16 model_bytes=16 persisted=None
004.PostToolUse.json toolu_0128pcdbxWsUFewtJbh5h31v stdout==model:True stdout_bytes=12000 model_bytes=12000 persisted=None
007.PostToolUse.json toolu_01XNK4MefV68oHSDACrwU9Ki stdout==model:False stdout_bytes=30000 model_bytes=2330 persisted=40001
013.PostToolUse.json toolu_01T33LnrPBnUxAQ33mjF8peY stdout==model:True stdout_bytes=13 model_bytes=13 persisted=None
015.PostToolUse.json toolu_01UX9KYQzYtEVzB9XRhGz4Ki stdout==model:True stdout_bytes=13 model_bytes=13 persisted=None

## Run result
{"subtype": "success", "is_error": false, "num_turns": 7, "session_id": "11111111-1111-4111-8111-000000000001", "result": "FIXTURES DONE"}
