import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const SHIPPED_SKILLS = [
  {
    path: ".agents/skills/barbaro/SKILL.md",
    commands: ["barbaro codex status"],
  },
  {
    path: ".claude/skills/barbaro/SKILL.md",
    commands: ["barbaro claude status"],
  },
  {
    path: ".claude/skills/barbaro-watch/SKILL.md",
    commands: ["barbaro watch", "barbaro context"],
  },
] as const;

test("shipped Barbaro skills use portable CLI commands", async () => {
  for (const skill of SHIPPED_SKILLS) {
    const contents = await readFile(skill.path, "utf8");

    assert.doesNotMatch(contents, /\/Users\/|\/opt\/homebrew\//u, skill.path);
    assert.doesNotMatch(contents, /dist\/src\/cli\.js/u, skill.path);
    for (const command of skill.commands) {
      assert.ok(contents.includes(command), `${skill.path} must invoke ${command}`);
    }
  }
});
