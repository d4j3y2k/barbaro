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

import {
  beginIngestAttempt,
  INGEST_ATTEMPT_SCHEMA,
} from "../../src/hooks/ingest-attempt.js";

const execFileAsync = promisify(execFile);

const SESSION_ID = "ses_fedcba9876543210fedcba9876543210";

function markerPath(project: string, provider: string): string {
  return join(
    project,
    ".barbaro",
    "logs",
    "ingest",
    provider,
    `${SESSION_ID}.json`,
  );
}

/** A pid that certainly existed and certainly no longer does. */
async function deadPid(): Promise<number> {
  const child = execFileAsync("true");
  const pid = child.child.pid!;
  await child;
  return pid;
}

test("an ingest attempt logs its birth before work and its outcome after", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const finish = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });

    const markerPath = join(
      project,
      ".barbaro",
      "logs",
      "ingest",
      "claude",
      `${SESSION_ID}.json`,
    );
    const started = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(started.schema, INGEST_ATTEMPT_SCHEMA);
    assert.equal(started.event, "Stop");
    assert.equal(started.session_id, SESSION_ID);
    assert.equal(started.pid, process.pid);
    // The whole point: a marker without an outcome is a run that never
    // finished. It must be on disk BEFORE the work it describes.
    assert.equal(started.finished_at, undefined);
    assert.equal(started.outcome, undefined);

    await finish("ok");
    const finished = JSON.parse(await readFile(markerPath, "utf8"));
    assert.equal(finished.outcome, "ok");
    assert.equal(finished.started_at, started.started_at);
    assert.ok(finished.finished_at >= finished.started_at);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a failed attempt keeps its marker with the error outcome", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-err-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const finish = await beginIngestAttempt({
      projectRoot: project,
      provider: "codex",
      sessionId: SESSION_ID,
      event: "SubagentStop",
    });
    await finish("error");

    const marker = JSON.parse(
      await readFile(
        join(
          project,
          ".barbaro",
          "logs",
          "ingest",
          "codex",
          `${SESSION_ID}.json`,
        ),
        "utf8",
      ),
    );
    assert.equal(marker.outcome, "error");
    assert.equal(marker.event, "SubagentStop");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("an older finish never clobbers a newer attempt's marker", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-lap-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const attempt = {
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    } as const;
    const finishOlder = await beginIngestAttempt(attempt);
    const finishNewer = await beginIngestAttempt(attempt);
    const newer = JSON.parse(
      await readFile(markerPath(project, "claude"), "utf8"),
    );

    // The older attempt concluding must not hide the newer, still-running one.
    await finishOlder("ok");
    const afterOlder = JSON.parse(
      await readFile(markerPath(project, "claude"), "utf8"),
    );
    assert.equal(afterOlder.attempt_id, newer.attempt_id);
    assert.equal(afterOlder.finished_at, undefined);

    await finishNewer("ok");
    const afterNewer = JSON.parse(
      await readFile(markerPath(project, "claude"), "utf8"),
    );
    assert.equal(afterNewer.attempt_id, newer.attempt_id);
    assert.equal(afterNewer.outcome, "ok");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a dead unfinished attempt becomes an incident before the marker is reused", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-rip-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const attempt = {
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    } as const;
    // Seed the marker via the real writer, then rewrite it as the corpse of a
    // process that no longer exists.
    await beginIngestAttempt(attempt);
    const corpse = {
      schema: INGEST_ATTEMPT_SCHEMA,
      provider: "claude",
      session_id: SESSION_ID,
      event: "SubagentStop",
      attempt_id: "deadbeefdeadbeef",
      pid: await deadPid(),
      started_at: "2026-08-18T00:00:00.000Z",
    };
    await writeFile(
      markerPath(project, "claude"),
      `${JSON.stringify(corpse)}\n`,
      { mode: 0o600 },
    );

    await beginIngestAttempt(attempt);
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
    assert.equal(incident.kind, "hook_error");
    assert.equal(incident.event, "SubagentStop");
    assert.match(incident.detail.text, /died without an outcome/u);
    // The reused marker belongs to the live attempt again.
    const reused = JSON.parse(
      await readFile(markerPath(project, "claude"), "utf8"),
    );
    assert.equal(reused.finished_at, undefined);
    assert.notEqual(reused.attempt_id, "deadbeefdeadbeef");
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("an overlapping live attempt is not reported as a death", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-live-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const attempt = {
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    } as const;
    await beginIngestAttempt(attempt);
    await beginIngestAttempt(attempt);
    await assert.rejects(
      stat(join(project, ".barbaro", "logs", "incidents")),
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a symlink planted at the marker path is neither read nor followed", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-sym-"));
  const outside = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-out-"));
  try {
    await mkdir(join(project, ".barbaro"), { mode: 0o700 });
    const secret = join(outside, "secret.json");
    // Shaped like a dead unfinished attempt: if the journal read followed the
    // link, this would fabricate a death incident from attacker-chosen bytes.
    await writeFile(
      secret,
      `${JSON.stringify({
        schema: INGEST_ATTEMPT_SCHEMA,
        provider: "claude",
        session_id: SESSION_ID,
        event: "Stop",
        attempt_id: "attackercontrolled",
        pid: 999_999_999,
        started_at: "2026-08-18T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const marker = markerPath(project, "claude");
    await mkdir(join(project, ".barbaro", "logs", "ingest", "claude"), {
      recursive: true,
      mode: 0o700,
    });
    await symlink(secret, marker);

    const finish = await beginIngestAttempt({
      projectRoot: project,
      provider: "claude",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await finish("ok");

    // No incident fabricated from the linked bytes …
    await assert.rejects(
      stat(join(project, ".barbaro", "logs", "incidents")),
    );
    // … the outside file is untouched …
    assert.match(await readFile(secret, "utf8"), /attackercontrolled/u);
    // … and the marker is now a regular file owned by the live attempt.
    const written = JSON.parse(await readFile(marker, "utf8"));
    assert.notEqual(written.attempt_id, "attackercontrolled");
    assert.equal(written.outcome, "ok");
    assert.ok((await lstat(marker)).isFile());
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a project without a store never sprouts one for the journal", async () => {
  const project = await mkdtemp(join(tmpdir(), "barbaro-ingest-attempt-none-"));
  try {
    const finish = await beginIngestAttempt({
      projectRoot: project,
      provider: "codex",
      sessionId: SESSION_ID,
      event: "Stop",
    });
    await finish("error");
    await assert.rejects(stat(join(project, ".barbaro")));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
