import assert from "node:assert/strict";
import test from "node:test";
import { FeedCoverageTracker, feedAvailabilityFailure } from "../../src/core/feed-availability.js";
import { InputLimitError } from "../../src/core/input-limit.js";
import { UnsafeStorePathError } from "../../src/core/safe-store.js";

const file = { provider: "claude", sessionId: `ses_${"a".repeat(32)}` };

test("feed availability admits only explicit input bounds and recognized IO failures", () => {
  assert.equal(feedAvailabilityFailure(file, new InputLimitError("bounded", "file", 8))?.reason, "file_too_large");
  assert.equal(feedAvailabilityFailure(file, new InputLimitError("bounded", "record", 8))?.reason, "record_too_large");
  for (const code of ["ENOENT", "EACCES", "EPERM", "EMFILE", "ENFILE", "EIO", "ESTALE", "EBUSY", "ETIMEDOUT"]) {
    assert.equal(feedAvailabilityFailure(file, Object.assign(new Error(code), { code }))?.code, code);
  }
  for (const error of [
    new RangeError("invalid cursor offset"), new TypeError("corrupt state"),
    new UnsafeStorePathError("path", "symlink"), new Error("identity changed"),
    Object.assign(new Error("unsafe path"), { code: "ELOOP" }),
    Object.assign(new Error("not a directory"), { code: "ENOTDIR" }),
  ]) assert.equal(feedAvailabilityFailure(file, error), undefined);
});

test("feed coverage keeps complete failure counts with a bounded diagnostic sample", () => {
  const tracker = new FeedCoverageTracker();
  tracker.scanned();
  for (let index = 0; index < 20; index += 1) {
    assert.equal(tracker.unavailable(file, Object.assign(new Error("denied"), { code: "EACCES" })), true);
  }
  const coverage = tracker.value();
  assert.equal(coverage.state, "incomplete");
  assert.equal(coverage.scanned_feed_files, 1);
  assert.equal(coverage.unavailable.total, 20);
  assert.equal(coverage.unavailable.shown, 8);
  assert.equal(coverage.unavailable.items.length, 8);
});
