import assert from "node:assert/strict";
import test from "node:test";

import {
  fieldText,
  settleCreate,
  validateCreateForm,
  writerArgv,
  type CreatedRecord,
} from "../../src/tui/create.js";
import {
  osc52Sequence,
  punchOut,
  refusePunchPayload,
} from "../../src/tui/punch.js";

const RECORD: CreatedRecord = {
  workstream_id: `ws_${"d".repeat(32)}`,
  name: "motion-study",
  title: "Explore the motion-study interface",
  status: "open",
};

test("local validation gates the writer exactly as §5 words it", () => {
  assert.deepEqual(validateCreateForm("motion-study", "A title"), {
    ok: true,
    status: "Ready to create",
  });
  assert.equal(validateCreateForm("", "").ok, false);
  assert.equal(validateCreateForm("Motion", "").ok, false);
  assert.equal(validateCreateForm("-lead", "").ok, false);
  assert.equal(validateCreateForm("trail-", "").ok, false);
  assert.equal(validateCreateForm("a".repeat(65), "").ok, false);
  assert.equal(validateCreateForm("ok", "a".repeat(513)).ok, false);
  assert.equal(validateCreateForm("ok", "--title-like").ok, false);
  assert.equal(validateCreateForm("ok", "  --padded  ").ok, false);
  assert.equal(validateCreateForm("a", "").ok, true);
  assert.equal(validateCreateForm("a".repeat(64), "").ok, true);
});

test("the writer argv is fields only, with the trimmed optional title", () => {
  assert.deepEqual(writerArgv("lane", "", "/root"), [
    "workstream",
    "new",
    "lane",
    "--project-root",
    "/root",
  ]);
  assert.deepEqual(writerArgv("lane", "  A title  ", "/root"), [
    "workstream",
    "new",
    "lane",
    "--title",
    "A title",
    "--project-root",
    "/root",
  ]);
});

test("settle keeps every §5 outcome distinct and proof-shaped", () => {
  const success = settleCreate({
    expectedName: "motion-study",
    outcome: { code: 0, stdout: JSON.stringify(RECORD), cancelled: false },
    lookup: "absent",
  });
  assert.deepEqual(success, {
    kind: "created",
    record: RECORD,
    originKnown: true,
  });

  // Malformed success output falls back to reconciliation.
  const malformed = settleCreate({
    expectedName: "motion-study",
    outcome: { code: 0, stdout: "not json", cancelled: false },
    lookup: RECORD,
  });
  assert.deepEqual(malformed, {
    kind: "created",
    record: RECORD,
    originKnown: false,
  });
  const wrongName = settleCreate({
    expectedName: "motion-study",
    outcome: {
      code: 0,
      stdout: JSON.stringify({ ...RECORD, name: "other" }),
      cancelled: false,
    },
    lookup: "absent",
  });
  assert.equal(wrongName.kind, "unknown");

  assert.equal(
    settleCreate({
      expectedName: "motion-study",
      outcome: { code: 1, stdout: "", cancelled: false },
      lookup: "absent",
    }).kind,
    "failed",
  );
  assert.equal(
    settleCreate({
      expectedName: "motion-study",
      outcome: { code: null, stdout: "", cancelled: true },
      lookup: "absent",
    }).kind,
    "cancelled",
  );
  // Cancellation cannot claim no write until reconciliation proves it.
  assert.deepEqual(
    settleCreate({
      expectedName: "motion-study",
      outcome: { code: null, stdout: "", cancelled: true },
      lookup: RECORD,
    }),
    { kind: "created", record: RECORD, originKnown: false },
  );
  assert.equal(
    settleCreate({
      expectedName: "motion-study",
      outcome: { code: 1, stdout: "", cancelled: false },
      lookup: "unknown",
    }).kind,
    "unknown",
  );
});

test("field text drops control bytes and stays single-line", () => {
  assert.equal(fieldText("motion-study"), "motion-study");
  assert.equal(fieldText("a\r\nb\u0008c\u001b[31m"), "abc[31m");
  assert.equal(fieldText("q n r c"), "q n r c");
});

test("punch payloads are exact or refused, never truncated", () => {
  assert.equal(refusePunchPayload("/barbaro join motion-study"), undefined);
  assert.notEqual(refusePunchPayload(""), undefined);
  assert.notEqual(refusePunchPayload("two\nlines"), undefined);
  assert.notEqual(refusePunchPayload("nul\u0000"), undefined);
  assert.notEqual(refusePunchPayload("bidi\u202e"), undefined);
  assert.notEqual(refusePunchPayload("x".repeat(8193)), undefined);
  assert.equal(refusePunchPayload("x".repeat(8192)), undefined);
});

test("only helper exit 0 reports success; everything else stays honest", async () => {
  const oscWrites: string[] = [];
  const oscWrite = (sequence: string) => oscWrites.push(sequence);

  const confirmed = await punchOut("payload", {
    oscWrite,
    runHelper: async () => "ok",
  });
  assert.deepEqual(confirmed, { kind: "reported_success", value: "payload" });
  assert.equal(oscWrites.length, 1);
  assert.equal(
    oscWrites[0],
    `\u001b]52;c;${Buffer.from("payload", "utf8").toString("base64")}\u001b\\`,
  );
  assert.equal(oscWrites[0], osc52Sequence("payload"));

  const unconfirmed = await punchOut("payload", {
    oscWrite,
    runHelper: async () => "missing",
  });
  assert.equal(unconfirmed.kind, "sent_unconfirmed");

  const failedHelper = await punchOut("payload", {
    runHelper: async () => "failed",
  });
  assert.equal(failedHelper.kind, "unavailable");

  const nothing = await punchOut("payload", {});
  assert.equal(nothing.kind, "unavailable");

  const refused = await punchOut("bad\nline", {
    oscWrite: () => assert.fail("a refused payload sends nothing"),
    runHelper: async () => {
      assert.fail("a refused payload spawns nothing");
    },
  });
  assert.equal(refused.kind, "refused");
});
