// Run with Node and two prebuilt dist roots: <alpha5-dist> <candidate-dist>.
// Every hook below operates only on a newly created, disposable fixture project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const [baselineArg, candidateArg] = process.argv.slice(2);
if (!baselineArg || !candidateArg || process.argv.length !== 4) throw new Error("usage: read-runtime-compatibility.mjs <alpha5-dist> <candidate-dist>");
const baseline = resolve(baselineArg);
const candidate = resolve(candidateArg);
const load = (root, path) => import(pathToFileURL(join(root, "src", path)).href);
const { createSessionId, createTurnId } = await load(candidate, "core/id.js");
const { SessionParticipationStore } = await load(candidate, "hooks/participation.js");
const run = promisify(execFile);
const results = [];

for (const provider of ["claude", "codex"]) {
  for (const oldHooks of [true, false]) {
    const hookRoot = oldHooks ? baseline : candidate;
    const cliRoot = oldHooks ? candidate : baseline;
    const hook = (await load(hookRoot, `hooks/${provider}.js`))[provider === "codex" ? "handleCodexHook" : "handleClaudeHook"];
    const { inspectUnreadPeerTurns } = await load(hookRoot, "nudge/unread.js");
    const project = await realpath(await mkdtemp(join(tmpdir(), "barbaro-runtime-pair-")));
    try {
      const session = `compatibility-${provider}`;
      const turn = "compatibility-turn";
      const tracePath = join(project, "trace.jsonl");
      const row = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n";
      await writeFile(tracePath, row("session_meta", { id: session, session_id: session, cwd: project, cli_version: "0.153.2", history_mode: "paginated" }) +
        row("event_msg", { type: "task_started", turn_id: turn }));
      const actor = { session_id: session, cwd: project, ...(provider === "codex" ? { turn_id: turn, transcript_path: tracePath } : {}) };
      const joined = await hook({ ...actor, hook_event_name: "UserPromptSubmit", prompt: `${provider === "codex" ? "$" : "/"}barbaro new compatibility` });
      assert.equal(joined.ignored, undefined);
      const stream = (await new SessionParticipationStore(project).read(provider, session)).workstream_id;
      assert.ok(stream);
      const peer = provider === "codex" ? "claude" : "codex";
      const peerId = createSessionId(peer, "compatibility-peer");
      const content = (text) => ({ text, fidelity: "verbatim", truncated: false, redactions: [] });
      await mkdir(join(project, ".barbaro", "feed", peer), { recursive: true });
      const records = Array.from({ length: 8 }, (_, index) => ({
        schema: "barbaro.turn.v1", provider: peer, session_id: peerId, workstream_id: stream,
        turn_id: createTurnId(peer, "compatibility-peer", "main", `peer-${index}`), sequence: index + 1, agent_id: "main",
        started_at: "2099-01-01T00:00:00.000Z", ended_at: `2099-01-01T00:00:0${index}.999Z`, outcome: "success",
        request: content("Review request"), response: content(`Review ${index}`), actions: [], evidence_refs: [], source_refs: [],
        subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] },
      }));
      await writeFile(join(project, ".barbaro", "feed", peer, `${peerId}.jsonl`), records.map((record) => JSON.stringify(record) + "\n").join(""));
      const unread = async () => {
        const value = await inspectUnreadPeerTurns({ projectRoot: project, provider, nativeSessionId: session });
        assert.equal(value.status, "ready");
        return value.unread_count;
      };
      assert.equal(await unread(), 8);
      const argv = ["read", "context", "--provider", provider, "--session-id", session, "--project-root", project];
      const command = `barbaro ${argv.map((arg) => `'${arg}'`).join(" ")}`;
      const call = { ...actor, tool_name: "Bash", tool_use_id: "native-compatibility", tool_input: { command } };
      if (provider === "codex") await appendFile(tracePath, row("response_item", {
        type: "custom_tool_call", name: "exec", call_id: "model-compatibility",
        input: `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:10000}));`,
        internal_chat_message_metadata_passthrough: { turn_id: turn },
      }));
      await hook({ ...call, hook_event_name: "PreToolUse" });
      assert.equal(await unread(), 8, "launch never acknowledges the new protocol");
      let result;
      try { result = { ...await run(process.execPath, [join(cliRoot, "src/cli.js"), ...argv]), code: 0 }; }
      catch (error) { result = error; }
      if (oldHooks) {
        assert.equal(result.code, 0);
        assert.equal(JSON.parse(result.stdout).value.delivery.reason, "no_invocation");
        await hook({ ...call, hook_event_name: "PostToolUse", tool_response: provider === "codex" ? result.stdout : {
          stdout: result.stdout.trimEnd(), stderr: "", interrupted: false, isImage: false, noOutputExpected: false,
        } });
      } else {
        assert.equal(result.code, 2);
        assert.match(result.stderr, /Unknown command: read/u);
        await hook({ ...call, hook_event_name: provider === "codex" ? "PostToolUse" : "PostToolUseFailure", tool_response: result.stdout, error: result.stderr });
      }
      if (provider === "claude") await hook({ ...actor, hook_event_name: "PostToolBatch",
        tool_calls: [{ ...call, tool_response: result.stdout }] });
      assert.equal(await unread(), 8, "terminal mismatch consumes zero records");
      const record = { provider, hooks: oldHooks ? "alpha5" : "candidate", cli: oldHooks ? "candidate" : "alpha5", cli_exit: result.code, unread_before: 8, unread_after: 8 };
      if (oldHooks) {
        // Positive control proves the baseline hook was admitted: its known
        // legacy launch behavior remains unsafe and is outside the new protocol.
        await hook({ ...call, tool_use_id: "native-legacy-control", hook_event_name: "PreToolUse", tool_input: { command: `barbaro context --provider ${provider} --session-id ${session} --project-root '${project}'` } });
        assert.equal(await unread(), 0);
        record.legacy_positive_control_unread = 0;
      }
      results.push(record);
    } finally { await rm(project, { recursive: true, force: true }); }
  }
}
process.stdout.write(JSON.stringify({ node: process.execPath, version: process.version, results }, null, 2) + "\n");
