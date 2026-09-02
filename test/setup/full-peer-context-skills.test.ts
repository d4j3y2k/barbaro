import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const LOSSLESS_PEER_SKILLS = [
  ".agents/skills/barbaro/SKILL.md",
  ".claude/skills/barbaro/SKILL.md",
  ".claude/skills/barbaro-watch/SKILL.md",
] as const;

test("peer skills distinguish bounded attention from lossless retrieval", async () => {
  for (const path of LOSSLESS_PEER_SKILLS) {
    const skill = await readFile(path, "utf8");

    assert.match(skill, /bounded attention/u, path);
    assert.match(skill, /older turns even when shown equals\s+total/u, path);
    assert.match(skill, /whenever completeness or absence matters/u, path);
    assert.match(
      skill,
      /rendered content has\s+`truncated\.projection: true`/u,
      path,
    );
    assert.match(
      skill,
      /\.value\.turns\.shown <\s+\.value\.turns\.total/u,
      path,
    );
    assert.match(skill, /nudge count exceeds/u, path);
    assert.match(skill, /barbaro turn list/u, path);
    assert.match(
      skill,
      /barbaro turn show <turn_id> --field response/u,
      path,
    );
    assert.match(skill, /--field request/u, path);
    assert.match(skill, /barbaro evidence show <evidence_id>/u, path);
    assert.match(skill, /--field record/u, path);
    assert.match(skill, /Never read `\.barbaro\/\*\.jsonl` directly/u, path);
    assert.match(skill, /canonical\s+`barbaro\.turn\.v1`/u, path);
    assert.match(skill, /referenced canonical evidence/u, path);
    assert.match(skill, /provider-raw omissions/iu, path);
    assert.match(skill, /outside (?:that |the )?guarantee/u, path);
  }
});
