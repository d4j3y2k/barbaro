import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { main } from "../../src/cli.js";
import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { stableJsonLine } from "../../src/core/stable-json.js";

const SESSION_ID = "ses_11111111111111111111111111111111";
const TURN_ID = "turn_44444444444444444444444444444444";

function turn(): BarbaroTurnV1 {
  const text = "reachable only with wider limits";
  return {
    schema: "barbaro.turn.v1",
    turn_id: TURN_ID,
    provider: "codex",
    session_id: SESSION_ID,
    sequence: 1,
    agent_id: "root",
    started_at: "2026-09-01T12:00:00.000Z",
    ended_at: "2026-09-01T12:01:00.000Z",
    outcome: "success",
    request: {
      text: "hello",
      fidelity: "verbatim",
      truncated: false,
      original_utf8_bytes: 5,
      redactions: [],
    },
    response: {
      text,
      fidelity: "verbatim",
      truncated: false,
      original_utf8_bytes: Buffer.byteLength(text, "utf8"),
      redactions: [],
    },
    actions: [],
    subagents: { total: 0, by_role: [], outcomes: {}, changed_paths: [], evidence_refs: [] },
    evidence_refs: [],
    source_refs: [{ trace_id: "fixture:record-page-cli" }],
  };
}

test("turn show reports an incomplete search with limit guidance instead of plain absence", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-record-page-cli-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
  });
  const path = join(project, ".barbaro", "feed", "codex", `${SESSION_ID}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stableJsonLine(turn()), "utf8");

  const out: string[] = [];
  const err: string[] = [];
  const io = {
    stdout: (text: string) => {
      out.push(text);
    },
    stderr: (text: string) => {
      err.push(text);
    },
  };
  const code = await main(
    ["turn", "show", TURN_ID, "--all-workstreams", "--max-file-bytes", "64", "--project-root", project],
    io,
  );
  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err.join(""), /1 feed file\(s\) exceeded the reader limits/u);
  assert.match(err.join(""), /--max-file-bytes or --max-record-bytes/u);

  // A scoped search that was cut short gets the limits guidance, not the
  // scope hint that a proven absence would earn.
  assert.equal(await main(["workstream", "new", "lane", "--project-root", project], io), 0);
  out.length = 0;
  err.length = 0;
  const scoped = await main(
    ["turn", "show", TURN_ID, "--workstream", "lane", "--max-file-bytes", "64", "--project-root", project],
    io,
  );
  assert.equal(scoped, 1);
  assert.match(err.join(""), /absence is unproven/u);
  assert.doesNotMatch(err.join(""), /--all-workstreams/u);
  err.length = 0;
  const absent = await main(
    ["turn", "show", "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "--workstream", "lane", "--project-root", project],
    io,
  );
  assert.equal(absent, 1);
  assert.match(err.join(""), /not found/u);
  assert.match(err.join(""), /--all-workstreams/u);
  assert.doesNotMatch(err.join(""), /absence is unproven/u);

  const widened = await main(
    ["turn", "show", TURN_ID, "--all-workstreams", "--field", "response", "--project-root", project],
    io,
  );
  assert.equal(widened, 0);
  assert.match(out.join(""), /reachable only with wider limits/u);
});
