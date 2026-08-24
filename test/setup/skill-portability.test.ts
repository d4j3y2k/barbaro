import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const SHIPPED_SKILLS = [
  {
    path: ".agents/skills/barbaro/SKILL.md",
    commands: ["barbaro codex status", "barbaro await"],
  },
  {
    path: ".claude/skills/barbaro/SKILL.md",
    commands: ["barbaro claude status", "barbaro await"],
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

test("provider skills pin the cursor-based nudge and await lifecycle", async () => {
  const codex = await readFile(".agents/skills/barbaro/SKILL.md", "utf8");
  assert.match(codex, /On each later turn or goal iteration/u);
  assert.match(codex, /run\s+exactly one\s+`barbaro await/u);
  assert.match(codex, /read-only cursor observer/u);
  assert.match(codex, /already unread/u);
  assert.match(codex, /including a review\s+verdict published from a Monitor wake/u);
  assert.match(
    codex,
    /When await returns — unread or timeout — run the context\s+command above once to clear the cursor/u,
  );
  assert.match(codex, /If the tool execution yields, do not launch a replacement/u);
  assert.match(codex, /If a Stop hook blocks\s+the response/u);
  assert.match(codex, /Within one cursor revision, prompt and tool nudges repeat only\s+when the unread count has grown/u);
  assert.match(codex, /Stop does not block a turn that already\s+received a nudge for that revision/u);
  assert.match(codex, /block once on a later turn while\s+those turns remain unread/u);
  assert.match(
    codex,
    /trace-attested fresh goal-turn `PreToolUse`/u,
  );
  assert.match(
    codex,
    /idle same-turn, stale, or\s+unattested boundary leaves the cursor unchanged/u,
  );
  assert.match(codex, /resend\s+the\s+previous\s+response\s+verbatim\s+unless/u);
  assert.match(
    codex,
    /pending review is\s+`WAITING: …`, not `BLOCKED`\/`BLOCKER`/u,
  );

  const claude = await readFile(".claude/skills/barbaro/SKILL.md", "utf8");
  assert.match(claude, /Monitor is Claude's primary wake mechanism/u);
  assert.match(claude, /one\s+watcher-less one-shot wait per turn/u);
  assert.match(claude, /--timeout-ms 540000/u);
  assert.match(claude, /`timeout` to `600000` ms/u);
  assert.match(claude, /defaults to 120 s\s+and caps at 600 s/u);
  assert.match(claude, /pending review\s+is `WAITING`, not `BLOCKED`/u);
  assert.match(claude, /shorter\s+child deadline leaves Bash time/u);
  assert.match(claude, /read-only cursor observer/u);
  assert.match(claude, /already unread/u);
  assert.match(claude, /including a review verdict\s+published from a Monitor wake/u);
  assert.match(
    claude,
    /When it returns — unread or timeout — read\s+`barbaro context --provider claude[\s\S]+once to clear the cursor/u,
  );
  assert.match(claude, /If Stop hook feedback\s+blocks\s+the\s+response/u);
  assert.match(claude, /Within one cursor revision, prompt and tool nudges repeat only\s+when the unread count has grown/u);
  assert.match(claude, /Stop does not block a turn that already\s+received a nudge for that revision/u);
  assert.match(claude, /block once on a later turn while\s+those turns remain unread/u);
  assert.match(claude, /resend\s+the\s+previous\s+response\s+verbatim\s+unless/u);
});

test("the watcher skill distinguishes external wake from cursor nudges", async () => {
  const watch = await readFile(
    ".claude/skills/barbaro-watch/SKILL.md",
    "utf8",
  );
  assert.match(watch, /hooks publish state and can annotate/u);
  assert.match(watch, /They still cannot\s+start a turn/u);
  assert.match(watch, /suppressed from `watch`/u);
  assert.match(watch, /cursor deliberately has no echo filter/u);
  assert.match(watch, /nudge says peer turns are unread/u);
  assert.match(watch, /Do not read on a\s+cadence/u);
});

test("README documents consent-gated, workstream-scoped await", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /barbaro await/u);
  assert.match(readme, /stable `--self <ses_id>`/u);
  assert.match(readme, /observes the joined session's hook-owned unread cursor/u);
  assert.match(readme, /cursor always belongs to the\s+session's current workstream/u);
  assert.match(readme, /default timeout is 600000 ms/u);
  assert.match(readme, /hard\s+cap is 3600000 ms/u);
  assert.match(readme, /returns\s+immediately when peer turns are already unread/u);
  assert.match(readme, /Every peer turn counts/u);
  assert.match(readme, /command is read-only/u);
  assert.match(readme, /concurrent waits[\s\S]+cannot consume or hide/u);
  assert.match(readme, /refuses identity-less,\s+all-workstream, and foreign-workstream reads/u);
});

test("README teaches the gated Codex-builder and Claude-reviewer loop", async () => {
  const readme = await readFile("README.md", "utf8");
  const quickstart = readme.match(
    /^## Cowork quickstart:[\s\S]+?(?=^## Build and verify$)/mu,
  )?.[0];

  assert.ok(quickstart, "README must include the cowork quickstart");
  assert.match(quickstart, /barbaro workstream new alpha-demo/u);
  assert.match(quickstart, /Codex Desktop, switch the composer to Goal mode/u);
  assert.match(quickstart, /Goal mode belongs to Codex, not Barbaro/u);
  assert.match(quickstart, /^\$barbaro join alpha-demo /mu);
  assert.match(quickstart, /^\/barbaro join alpha-demo /mu);
  assert.match(quickstart, /^\/barbaro-watch$/mu);
  assert.match(quickstart, /runs exactly one\s+cursor observer/u);
  assert.match(quickstart, /resume the same execution/u);
  assert.match(quickstart, /run exactly one context read/u);
  assert.match(quickstart, /pending review is `WAITING`, never `BLOCKED`/u);
  assert.match(quickstart, /^PLAN REQUEST v1:/mu);
  assert.match(quickstart, /^CHECKPOINT 1:/mu);
  assert.match(quickstart, /^DONE:/mu);
  assert.match(quickstart, /verdict turn must begin at byte zero/u);

  assert.match(readme, /^### Platform availability$/mu);
  assert.match(readme, /Codex Desktop is Barbaro's first-class Codex environment/u);
  assert.match(readme, /only\s+on iOS or in the cloud is not visible/u);
  assert.match(readme, /rollout\s+lands locally/u);
});

test("nudge RFC records cursor ownership and the watch-only echo limitation", async () => {
  const rfc = await readFile("docs/workstreams.md", "utf8");
  assert.match(rfc, /^## Barbaro nudges .*implemented.*$/mu);
  assert.match(rfc, /\.barbaro\/state\/nudge\/<provider>\/<ses_id>\.json/u);
  assert.match(rfc, /membership_from/u);
  assert.match(rfc, /`barbaro\.nudge-cursor\.v2`/u);
  assert.match(rfc, /Existing `barbaro\.nudge-cursor\.v1` records remain strictly accepted/u);
  assert.match(rfc, /highest unread\s+count announced by any channel/u);
  assert.match(rfc, /synthetic generation/u);
  assert.match(rfc, /unknown fields/u);
  assert.match(rfc, /markers that do not equal `cursor_revision`/u);
  assert.match(rfc, /Readers\s+observe v1 or v2 byte-for-byte without migration/u);
  assert.match(rfc, /Stop continuation protocol/u);
  assert.match(rfc, /`stop_hook_active !== true`/u);
  assert.match(rfc, /current provider turn has received\s+no delivery/u);
  assert.match(rfc, /decline leaves the latch untouched/u);
  assert.match(rfc, /holds the actor lock through the cursor claim/u);
  assert.match(rfc, /conditionally rolls back that Stop\s+latch/u);
  assert.match(rfc, /latest `task_started`/u);
  assert.match(
    rfc,
    /`PreToolUse`, `PostToolUse`, `PermissionRequest`, and `Stop`/u,
  );
  assert.match(rfc, /idle older-turn lease/u);
  assert.match(rfc, /idle\s+same-turn tool boundary is terminal or delayed and stays stale/u);
  assert.match(
    rfc,
    /`PreToolUse` writes\s+the new turn as `waiting` for `barbaro await` and `working` otherwise/u,
  );
  assert.match(
    rfc,
    /`PermissionRequest` writes `waiting`, and `PostToolUse` writes `working`/u,
  );
  assert.match(rfc, /None can mutate the lease,\s+cursor, or delivery markers/u);
  assert.match(rfc, /Stop continuation is intentionally nonterminal|intentional nonterminal result/u);
  assert.match(rfc, /absent cursor is a valid uninitialized state/u);
  assert.match(rfc, /malformed, oversized, or\s+path-inconsistent cursor/u);
  assert.match(rfc, /`isEchoTurn` still suppresses[\s\S]+from\s+`barbaro watch`/u);
  assert.match(rfc, /It no longer makes\s+nudges or await blind/u);
});
