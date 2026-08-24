import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { JSONL_CHECKPOINT_SCHEMA } from "../../src/core/checkpoint.js";
import {
  beginIngestAttempt,
  INGEST_ATTEMPT_SCHEMA,
  LEGACY_INGEST_ATTEMPT_SCHEMA,
  MAX_INGEST_ATTEMPTS,
  MAX_INGEST_ATTEMPT_BYTES,
  MAX_INGEST_OBSERVATION_TRANSITIONS,
  type BarbaroIngestAttemptJournalV2,
  type BarbaroIngestAttemptV2,
} from "../../src/hooks/ingest-attempt.js";
import { withDirectoryLock } from "../../src/output/directory-lock.js";

const execFileAsync = promisify(execFile);
const SESSION_ID = "ses_fedcba9876543210fedcba9876543210";
const IDENTITY = {
  device: "11",
  inode: "22",
  birthtime_ns: "33",
} as const;

function markerPath(project: string, provider = "claude"): string {
  return join(
    project,
    ".barbaro",
    "logs",
    "ingest",
    provider,
    `${SESSION_ID}.json`,
  );
}

async function readJournal(
  project: string,
  provider = "claude",
): Promise<BarbaroIngestAttemptJournalV2> {
  return JSON.parse(
    await readFile(markerPath(project, provider), "utf8"),
  ) as BarbaroIngestAttemptJournalV2;
}

function findAttempt(
  journal: BarbaroIngestAttemptJournalV2,
  attemptId: string,
): BarbaroIngestAttemptV2 {
  const attempt = journal.attempts.find(
    (candidate) => candidate.attempt_id === attemptId,
  );
  assert.ok(attempt, `missing ingest attempt ${attemptId}`);
  return attempt;
}

function checkpoint(byteOffset: number, observedSize: number) {
  return {
    schema: JSONL_CHECKPOINT_SCHEMA,
    file_identity: IDENTITY,
    byte_offset: byteOffset,
    next_line_number: byteOffset + 1,
    observed_size: observedSize,
    anchor: {
      byte_length: Math.min(byteOffset, 8),
      sha256: "a".repeat(64),
    },
  } as const;
}

async function deadPid(): Promise<number> {
  const child = execFileAsync("true");
  const pid = child.child.pid!;
  await child;
  return pid;
}

test("an ingest attempt journals birth, trigger, reads, checkpoints, and outcome", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const trace = join(project, "trace.jsonl");
    await writeFile(trace, "{}\n", "utf8");
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
      tracePath: trace,
      triggeredAt: "2026-08-23T20:24:47.108Z",
      nativeTurnId: "native-turn",
      turnId: "turn_stable",
      agentId: "main",
      stopHookActive: true,
      lastAssistantMessage: "CHECKPOINT 1 APPROVED",
    });

    const started = await readJournal(project);
    assert.equal(started.schema, INGEST_ATTEMPT_SCHEMA);
    assert.equal(started.provider, "claude");
    assert.equal(started.session_id, SESSION_ID);
    const born = findAttempt(started, handle.attemptId);
    assert.equal(born.event, "Stop");
    assert.equal(born.pid, process.pid);
    assert.equal(born.triggered_at, "2026-08-23T20:24:47.108Z");
    assert.deepEqual(
      {
        native_turn_id: born.trigger?.native_turn_id,
        turn_id: born.trigger?.turn_id,
        agent_id: born.trigger?.agent_id,
      },
      {
        native_turn_id: "native-turn",
        turn_id: "turn_stable",
        agent_id: "main",
      },
    );
    assert.equal(
      born.trigger?.last_assistant_message?.utf8_bytes,
      Buffer.byteLength("CHECKPOINT 1 APPROVED", "utf8"),
    );
    assert.match(
      born.trigger?.last_assistant_message?.sha256 ?? "",
      /^[0-9a-f]{64}$/u,
    );
    assert.equal(born.trigger?.stop_hook_active, true);
    assert.equal(born.outcome, undefined);
    assert.equal(born.observations.count, 1, "invocation snapshot is durable");
    assert.equal(born.observations.first?.observed_size, 3);

    await handle.observe({
      observedSize: 200,
      fileIdentity: IDENTITY,
      checkpointBefore: checkpoint(10, 100),
      checkpointAfter: checkpoint(20, 200),
      runnerInput: {
        complete_lines: 7,
        trailing_turn_open: true,
        withheld_reason: "source_grew_during_ingest",
        pending_background_ids: ["tool-1"],
      },
      turnsAppended: 2,
      pendingBackgroundIds: ["tool-1"],
      pendingAgentIds: ["agent-1"],
      withheldReason: "source_grew_during_ingest",
      publishBlocker: "source_grew_during_ingest",
    });
    await handle.finish("ok");

    const completed = findAttempt(await readJournal(project), handle.attemptId);
    assert.equal(completed.outcome, "ok");
    assert.ok(completed.finished_at! >= completed.started_at);
    assert.equal(completed.observations.count, 2);
    assert.equal(completed.observations.last?.observed_size, 200);
    assert.equal(completed.observations.size_transitions.length, 2);
    assert.equal(completed.checkpoint_before?.byte_offset, 10);
    assert.equal(completed.checkpoint_after?.byte_offset, 20);
    assert.equal(completed.turns_appended, 2);
    assert.equal(
      completed.withheld_reason,
      "source_grew_during_ingest",
    );
    assert.equal(completed.publish_blocker, "source_grew_during_ingest");
    assert.deepEqual(completed.pending_background_ids, ["tool-1"]);
    assert.deepEqual(completed.pending_agent_ids, ["agent-1"]);
    assert.equal(completed.runner_input?.complete_lines, 7);

    await handle.observe({
      observedSize: 999,
      fileIdentity: IDENTITY,
      runnerInput: {},
      turnsAppended: 99,
    });
    await handle.finish("error");
    const stillCompleted = findAttempt(
      await readJournal(project),
      handle.attemptId,
    );
    assert.equal(stillCompleted.outcome, "ok", "first finish is final");
    assert.equal(stillCompleted.turns_appended, 2, "finished attempts are immutable");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a failed attempt is retained with an error outcome", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-err-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "codex",
      sessionId: SESSION_ID,
      event: "SubagentStop",
    });
    await handle.finish("error");
    const attempt = findAttempt(await readJournal(project, "codex"), handle.attemptId);
    assert.equal(attempt.event, "SubagentStop");
    assert.equal(attempt.outcome, "error");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("overlapping attempts are retained and finish independently", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-lap-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const options = {
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    } as const;
    const older = await beginIngestAttempt(options);
    const newer = await beginIngestAttempt(options);
    let journal = await readJournal(project);
    assert.deepEqual(
      journal.attempts.map((attempt) => attempt.attempt_id),
      [older.attemptId, newer.attemptId],
    );

    await older.finish("ok");
    journal = await readJournal(project);
    assert.equal(findAttempt(journal, older.attemptId).outcome, "ok");
    assert.equal(findAttempt(journal, newer.attemptId).outcome, undefined);

    await newer.finish("error");
    journal = await readJournal(project);
    assert.equal(findAttempt(journal, older.attemptId).outcome, "ok");
    assert.equal(findAttempt(journal, newer.attemptId).outcome, "error");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a completed v1 marker is explicitly migrated and retained", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-migrate-"));
  try {
    await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      markerPath(project),
      `${JSON.stringify({
        schema: LEGACY_INGEST_ATTEMPT_SCHEMA,
        provider: "claude",
        session_id: SESSION_ID,
        event: "Stop",
        attempt_id: "legacy-complete",
        pid: process.pid,
        started_at: "2026-08-18T00:00:00.000Z",
        finished_at: "2026-08-18T00:00:01.000Z",
        outcome: "ok",
      })}\n`,
      "utf8",
    );
    const current = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "SessionEnd",
    });
    const journal = await readJournal(project);
    assert.equal(journal.schema, INGEST_ATTEMPT_SCHEMA);
    assert.equal(journal.attempts.length, 2);
    const migrated = findAttempt(journal, "legacy-complete");
    assert.equal(migrated.migrated_from_schema, LEGACY_INGEST_ATTEMPT_SCHEMA);
    assert.equal(migrated.finished_at, "2026-08-18T00:00:01.000Z");
    assert.equal(migrated.outcome, "ok");
    assert.equal(findAttempt(journal, current.attemptId).outcome, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a malformed v1 marker is replaced without poisoning the v2 journal", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-v1-invalid-"));
  try {
    await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      markerPath(project),
      `${JSON.stringify({
        schema: LEGACY_INGEST_ATTEMPT_SCHEMA,
        provider: "claude",
        session_id: SESSION_ID,
        event: "",
        attempt_id: "",
        pid: 0,
        started_at: "not-a-timestamp",
      })}\n`,
      "utf8",
    );
    const first = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await first.finish("ok");
    const second = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "SessionEnd",
    });
    await second.finish("ok");
    const journal = await readJournal(project);
    assert.deepEqual(
      journal.attempts.map((attempt) => attempt.attempt_id),
      [first.attemptId, second.attemptId],
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a v1 marker with a one-sided completion is replaced", async () => {
  for (const completion of [
    { finished_at: "2026-08-18T00:00:01.000Z" },
    { outcome: "ok" },
  ] as const) {
    const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-v1-half-done-"));
    try {
      await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        markerPath(project),
        `${JSON.stringify({
          schema: LEGACY_INGEST_ATTEMPT_SCHEMA,
          provider: "claude",
          session_id: SESSION_ID,
          event: "Stop",
          attempt_id: "legacy-half-finished",
          pid: process.pid,
          started_at: "2026-08-18T00:00:00.000Z",
          ...completion,
        })}\n`,
        "utf8",
      );
      const current = await beginIngestAttempt({
        projectRoot: project,
        provider: "claude",
        sessionId: SESSION_ID,
        event: "SessionEnd",
      });
      await current.finish("ok");
      const journal = await readJournal(project);
      assert.deepEqual(
        journal.attempts.map((attempt) => attempt.attempt_id),
        [current.attemptId],
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
});

test("an owner-gone v1 marker is migrated with an honest unknown outcome", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-rip-"));
  try {
    await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      markerPath(project),
      `${JSON.stringify({
        schema: LEGACY_INGEST_ATTEMPT_SCHEMA,
        provider: "claude",
        session_id: SESSION_ID,
        event: "SubagentStop",
        attempt_id: "deadbeefdeadbeef",
        pid: await deadPid(),
        started_at: "2026-08-18T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const current = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    const journal = await readJournal(project);
    const corpse = findAttempt(journal, "deadbeefdeadbeef");
    assert.equal(corpse.outcome, "outcome_not_recorded");
    assert.ok(corpse.finished_at);
    assert.ok(corpse.autopsied_at);
    assert.equal(corpse.migrated_from_schema, LEGACY_INGEST_ATTEMPT_SCHEMA);
    assert.equal(findAttempt(journal, current.attemptId).outcome, undefined);

    const incidentDirectory = join(
      project,
      ".barbaro",
      "logs",
      "incidents",
      "claude",
    );
    const incidents = await readdir(incidentDirectory);
    assert.equal(incidents.length, 1);
    const incident = JSON.parse(
      await readFile(join(incidentDirectory, incidents[0]!), "utf8"),
    );
    assert.equal(incident.event, "SubagentStop");
    assert.match(incident.detail.text, /exited without a recorded outcome/u);
    assert.doesNotMatch(incident.detail.text, /deadbeef|pid|2026-/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("overlapping live attempts are not reported as deaths", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-live-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const options = {
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    } as const;
    const [first, second] = await Promise.all([
      beginIngestAttempt(options),
      beginIngestAttempt(options),
    ]);
    const journal = await readJournal(project);
    assert.equal(journal.attempts.length, 2);
    findAttempt(journal, first.attemptId);
    findAttempt(journal, second.attemptId);
    await assert.rejects(stat(join(project, ".barbaro", "logs", "incidents")));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("concurrent processes append and finish distinct attempt records", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-procs-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const moduleUrl = new URL(
      "../../src/hooks/ingest-attempt.js",
      import.meta.url,
    ).href;
    const childSource = `
      const { beginIngestAttempt } = await import(${JSON.stringify(moduleUrl)});
      const handle = await beginIngestAttempt({
        projectRoot: ${JSON.stringify(project)},
        provider: "claude",
        sessionId: ${JSON.stringify(SESSION_ID)},
        event: "Stop"
      });
      await handle.finish("ok");
    `;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [
          "--input-type=module",
          "--eval",
          childSource,
        ]),
      ),
    );
    const journal = await readJournal(project);
    assert.equal(journal.attempts.length, 8);
    assert.equal(
      new Set(journal.attempts.map((attempt) => attempt.attempt_id)).size,
      8,
    );
    assert.equal(
      journal.attempts.every((attempt) => attempt.outcome === "ok"),
      true,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("same-source polls coalesce in memory and transitions flush immediately", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-coalesce-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    const observe = async (
      observedSize: number,
      parsedLines: number,
      turnsAppended: number,
    ): Promise<void> =>
      handle.observe({
        observedSize,
        fileIdentity: IDENTITY,
        runnerInput: { parsed_lines: parsedLines },
        turnsAppended,
      });

    await observe(10, 1, 0);
    const firstFunctionalWrite = await readFile(markerPath(project), "utf8");
    for (let index = 2; index <= 6; index += 1) {
      await observe(10, 1, 0);
    }
    assert.equal(
      await readFile(markerPath(project), "utf8"),
      firstFunctionalWrite,
      "same-source polls must not rename the journal",
    );

    await observe(20, 7, 2);
    const transitioned = findAttempt(await readJournal(project), handle.attemptId);
    assert.deepEqual(
      transitioned.observations.size_transitions.map(
        (item) => item.observed_size,
      ),
      [10, 20],
    );
    assert.equal(transitioned.observations.size_transitions[0]!.repeat_count, 6);
    assert.equal(transitioned.observations.count, 7);
    assert.equal(transitioned.turns_appended, 2);
    assert.equal(transitioned.runner_input?.parsed_lines, 7);

    await observe(20, 8, 3);
    const materiallyChanged = findAttempt(
      await readJournal(project),
      handle.attemptId,
    );
    assert.equal(materiallyChanged.runner_input?.parsed_lines, 8);
    assert.equal(materiallyChanged.turns_appended, 5);
    await handle.finish("ok");
    const finished = findAttempt(await readJournal(project), handle.attemptId);
    assert.equal(finished.observations.count, 8);
    assert.equal(finished.observations.size_transitions[1]!.repeat_count, 2);
    assert.equal(finished.turns_appended, 5);
    assert.equal(finished.runner_input?.parsed_lines, 8);
    assert.equal(finished.outcome, "ok");
    assert.ok(
      finished.observations.size_transitions.every(
        (item) => item.first_observed_at <= item.observed_at,
      ),
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a failed transition flush stays dirty across a return to the prior source", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-retry-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    const observation = (observedSize: number) => ({
      observedSize,
      fileIdentity: IDENTITY,
      runnerInput: { parsed_lines: 1 },
      turnsAppended: 0,
    });
    await handle.observe(observation(10));
    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = withDirectoryLock(markerPath(project), async () => {
      acquired();
      await releasePromise;
    });
    await acquiredPromise;

    await handle.observe(observation(20));
    await handle.observe(observation(10));
    assert.equal(
      findAttempt(await readJournal(project), handle.attemptId).observations
        .count,
      1,
      "the contended diagnostic write stayed fail-open",
    );
    release();
    await holding;

    await handle.observe(observation(10));
    const retried = findAttempt(await readJournal(project), handle.attemptId);
    assert.equal(retried.observations.count, 4);
    assert.deepEqual(
      retried.observations.size_transitions.map(
        (transition) => transition.observed_size,
      ),
      [10, 20, 10],
    );
    assert.equal(retried.observations.size_transitions[2]?.repeat_count, 2);
    assert.equal(retried.runner_input?.parsed_lines, 1);
    await handle.finish("ok");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("attempts and observation transitions remain strictly bounded", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-bound-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const ids: string[] = [];
    for (let index = 0; index < MAX_INGEST_ATTEMPTS + 5; index += 1) {
      const handle = await beginIngestAttempt({
        projectRoot: project,
        provider: "claude",
        sessionId: SESSION_ID,
        event: `event-${index}`,
      });
      ids.push(handle.attemptId);
      await handle.finish("ok");
    }
    let journal = await readJournal(project);
    assert.equal(journal.attempts.length, MAX_INGEST_ATTEMPTS);
    assert.equal(journal.dropped_attempts, 5);
    assert.equal(
      journal.attempts.some((attempt) => attempt.attempt_id === ids[0]),
      false,
    );
    assert.equal(journal.attempts.at(-1)?.attempt_id, ids.at(-1));
    assert.ok((await stat(markerPath(project))).size <= MAX_INGEST_ATTEMPT_BYTES);

    const observationProject = await mkdtemp(
      join(tmpdir(), "barbaro-ingest-observation-bound-"),
    );
    try {
      await mkdir(join(observationProject, ".barbaro"), { mode: 0o700 });
      const handle = await beginIngestAttempt({
        projectRoot: observationProject,
        provider: "claude",
        sessionId: SESSION_ID,
        event: "Stop",
      });
      for (
        let index = 0;
        index < MAX_INGEST_OBSERVATION_TRANSITIONS + 4;
        index += 1
      ) {
        await handle.observe({
          observedSize: index,
          fileIdentity: IDENTITY,
          runnerInput: { parsed_lines: index },
          turnsAppended: 1,
        });
      }
      await handle.finish("ok");
      journal = await readJournal(observationProject);
      const attempt = findAttempt(journal, handle.attemptId);
      assert.equal(
        attempt.observations.count,
        MAX_INGEST_OBSERVATION_TRANSITIONS + 4,
      );
      assert.equal(
        attempt.observations.size_transitions.length,
        MAX_INGEST_OBSERVATION_TRANSITIONS,
      );
      assert.equal(attempt.observations.dropped_transitions, 4);
      assert.equal(attempt.observations.first?.observed_size, 0);
      assert.equal(
        attempt.observations.last?.observed_size,
        MAX_INGEST_OBSERVATION_TRANSITIONS + 3,
      );
      assert.equal(
        attempt.turns_appended,
        MAX_INGEST_OBSERVATION_TRANSITIONS + 4,
      );
    } finally {
      await rm(observationProject, { recursive: true, force: true });
    }
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("an over-limit v2 journal is rejected before dead-attempt autopsy", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-shaped-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const seed = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await seed.finish("ok");
    const valid = await readJournal(project);
    const template = findAttempt(valid, seed.attemptId);
    const {
      finished_at: _finishedAt,
      outcome: _outcome,
      ...unfinishedTemplate
    } = template;
    const dead = await deadPid();
    const shaped: BarbaroIngestAttemptJournalV2 = {
      ...valid,
      attempts: Array.from(
        { length: MAX_INGEST_ATTEMPTS + 1 },
        (_, index) => ({
          ...unfinishedTemplate,
          attempt_id: `shaped-${index}`,
          pid: dead,
        }),
      ),
    };
    await writeFile(markerPath(project), `${JSON.stringify(shaped)}\n`, "utf8");

    const current = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "SessionEnd",
    });
    await current.finish("ok");
    const replaced = await readJournal(project);
    assert.deepEqual(
      replaced.attempts.map((attempt) => attempt.attempt_id),
      [current.attemptId],
    );
    await assert.rejects(stat(join(project, ".barbaro", "logs", "incidents")));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a symlink planted at the journal path is neither read nor followed", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-sym-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-out-"));
  try {
    await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
      recursive: true,
      mode: 0o700,
    });
    const secret = join(outside, "secret.json");
    await writeFile(secret, '{"secret":"attackercontrolled"}\n', "utf8");
    await symlink(secret, markerPath(project));

    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await handle.finish("ok");

    assert.match(await readFile(secret, "utf8"), /attackercontrolled/u);
    assert.ok((await lstat(markerPath(project))).isFile());
    const journal = await readJournal(project);
    assert.equal(findAttempt(journal, handle.attemptId).outcome, "ok");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("corrupt and oversized prior diagnostics are replaced fail-open", async () => {
  for (const prior of ["not-json\n", "x".repeat(MAX_INGEST_ATTEMPT_BYTES + 1)]) {
    const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-bad-"));
    try {
      await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(markerPath(project), prior, "utf8");
      const handle = await beginIngestAttempt({
        projectRoot: project,
        provider: "claude",
        sessionId: SESSION_ID,
        event: "Stop",
      });
      await handle.finish("ok");
      const journal = await readJournal(project);
      assert.equal(journal.schema, INGEST_ATTEMPT_SCHEMA);
      assert.equal(findAttempt(journal, handle.attemptId).outcome, "ok");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
});

test("journal failures never reject begin, observe, or finish", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-open-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    await writeFile(join(project, ".barbaro", "logs"), "not a directory\n");
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await handle.observe({
      observedSize: 1,
      fileIdentity: IDENTITY,
      runnerInput: {},
      turnsAppended: 0,
    });
    await handle.observe({
      observedSize: -1,
      fileIdentity: IDENTITY,
      runnerInput: {},
      turnsAppended: 0,
    });
    await handle.finish("error");
    assert.ok(handle.attemptId.length > 0);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a project without a store never sprouts one for the journal", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-none-"));
  try {
    const handle = await beginIngestAttempt({
      projectRoot: project,
      provider: "codex",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await handle.finish("error");
    await assert.rejects(stat(join(project, ".barbaro")));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
