import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const SHIPPED_SKILLS = [
  {
    path: ".agents/skills/barbaro/SKILL.md",
    commands: [
      "barbaro codex status",
      "barbaro await",
      "barbaro turn list",
      "barbaro read turn show",
      "barbaro evidence show",
    ],
  },
  {
    path: ".claude/skills/barbaro/SKILL.md",
    commands: [
      "barbaro claude status",
      "barbaro await",
      "barbaro turn list",
      "barbaro read turn show",
      "barbaro evidence show",
    ],
  },
  {
    path: ".claude/skills/barbaro-watch/SKILL.md",
    commands: [
      "barbaro watch",
      "barbaro read context",
      "barbaro turn list",
      "barbaro read turn show",
      "barbaro evidence show",
    ],
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
    /When await returns — unread or timeout — run the context\s+command above once to inspect delivered content/u,
  );
  assert.match(codex, /If the tool execution yields, do not launch a replacement/u);
  assert.match(codex, /If a Stop hook blocks\s+the response/u);
  assert.match(codex, /Within one cursor revision, prompt and tool nudges repeat only\s+when the unread count has grown/u);
  assert.match(codex, /Stop does not block a turn that already\s+received a nudge for that revision/u);
  assert.match(codex, /block once on a later turn while\s+those turns remain unread/u);
  assert.match(
    codex,
    /native success and the later full model output/u,
  );
  assert.match(
    codex,
    /failed, truncated, missing or unsupported model output\s+consumes nothing/u,
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
    /When it returns — unread or timeout — read\s+`barbaro read context --provider claude[\s\S]+once to inspect delivered content/u,
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
  assert.match(watch, /Do not read on a cadence/u);
});

test("README and INSTALL pin the public installation contract", async () => {
  const [readme, install, contributing, horseStudy] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("INSTALL.md", "utf8"),
    readFile("CONTRIBUTING.md", "utf8"),
    readFile("docs/horse-study.md", "utf8"),
  ]);
  const readmeInstall = readme.match(
    /^## Install$[\s\S]+?(?=^## Quick start$)/mu,
  )?.[0];

  assert.ok(readmeInstall, "README must put Install before the quickstart");
  assert.match(readmeInstall, /\[`INSTALL\.md`\]\(INSTALL\.md\)/u);
  assert.match(readmeInstall, /^npm install --global barbaro$/mu);
  assert.doesNotMatch(readmeInstall, /barbaro@alpha/u);
  assert.doesNotMatch(readmeInstall, /barbaro-0\.1\.0-alpha/u);
  assert.match(readme, /\[alpha limitations\]\(ALPHA\.md\)/u);
  assert.match(readme, /\[security policy\]\(SECURITY\.md\)/u);
  assert.doesNotMatch(readme, /npm link/u);
  assert.match(
    horseStudy,
    /npm --prefix "\$\(npm root --global\)\/barbaro" run study:horse/u,
  );
  assert.match(contributing, /^npm ci$/mu);
  assert.match(contributing, /^npm run typecheck$/mu);
  assert.match(contributing, /^npm test$/mu);

  const registryIndex = install.indexOf("npm install --global barbaro");
  const assetIndex = install.indexOf("## Install a GitHub release asset");
  const maintainerIndex = install.indexOf(
    "## Maintainer-only checkout development",
  );
  assert.notEqual(registryIndex, -1);
  assert.ok(registryIndex < assetIndex, "registry installation must come first");
  assert.ok(assetIndex < maintainerIndex, "release asset must be a user path");
  assert.doesNotMatch(install, /barbaro@alpha/u);
  assert.match(
    install,
    /releases\/download\/v0\.1\.0-alpha\.6\/barbaro-0\.1\.0-alpha\.6\.tgz/u,
  );
  assert.match(install, /^npm install --global \.\/barbaro-0\.1\.0-alpha\.6\.tgz$/mu);
  assert.match(install, /barbaro-0\.1\.0-alpha\.6\.tgz\.sha256/u);
  assert.match(
    install,
    /github:d4j3y2k\/barbaro#v0\.1\.0-alpha\.6[\s\S]+source tags do\s+not contain/u,
  );
  assert.match(install, /^command -v barbaro$/mu);
  assert.match(install, /Choose either user scope or project scope/u);
  assert.match(install, /replace\s+`BARBARO_BIN` with the absolute path/u);
  assert.match(install, /\[public-alpha limitations\]\(ALPHA\.md\)/u);
  assert.match(install, /\[security policy\]\(SECURITY\.md\)/u);
  assert.doesNotMatch(install.slice(0, maintainerIndex), /npm link/u);
  assert.doesNotMatch(install.slice(0, maintainerIndex), /npm run build/u);
  assert.match(install.slice(maintainerIndex), /^npm link$/mu);
  assert.match(
    install.slice(maintainerIndex),
    /^npm publish --dry-run --tag latest$/mu,
  );
});

test("usage guide documents consent-gated, workstream-scoped await", async () => {
  const guide = await readFile("docs/usage.md", "utf8");
  assert.match(guide, /barbaro await/u);
  assert.match(guide, /stable\s+`--self <ses_id>`/u);
  assert.match(guide, /observes the joined session's hook-owned unread cursor/u);
  assert.match(guide, /cursor always belongs to the session's\s+current workstream/u);
  assert.match(guide, /default timeout is 600000 ms/u);
  assert.match(guide, /hard cap is 3600000\s+ms/u);
  assert.match(guide, /returns\s+immediately when peer turns are already unread/u);
  assert.match(guide, /Every peer turn counts/u);
  assert.match(guide, /bounded, read-only cursor observer/u);
  assert.match(guide, /Concurrent waits[\s\S]+cannot consume or hide/u);
  assert.match(guide, /refuses identity-less, all-workstream, and\s+foreign-workstream reads/u);
});

test("the optional guide teaches the gated builder-reviewer loop", async () => {
  const [readme, workflow] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("docs/gated-review.md", "utf8"),
  ]);

  assert.match(workflow, /Goal mode belongs to Codex/u);
  assert.match(workflow, /not a Barbaro command or requirement/u);
  assert.match(workflow, /^\$barbaro join api-cleanup /mu);
  assert.match(workflow, /^\/barbaro join api-cleanup /mu);
  assert.match(workflow, /\/barbaro-watch/u);
  assert.match(workflow, /runs exactly one cursor observer/u);
  assert.match(workflow, /resume it rather than launching a replacement/u);
  assert.match(workflow, /run one context read/u);
  assert.match(workflow, /pending review is `WAITING`, not\s+`BLOCKED`/u);
  assert.match(workflow, /^PLAN REQUEST v1:/mu);
  assert.match(workflow, /^CHECKPOINT 1:/mu);
  assert.match(workflow, /^DONE: <commits>$/mu);
  assert.doesNotMatch(workflow, /DONE: <commits and tag>/u);
  assert.match(workflow, /begins at byte zero/u);

  assert.match(readme, /^## Availability and boundaries$/mu);
  assert.match(readme, /Codex Desktop is the first-class Codex environment/u);
  assert.match(readme, /only on iOS or in\s+the cloud is invisible/u);
  assert.match(readme, /rollout lands locally/u);
  assert.match(readme, /Cross-worktree workstreams are not supported/u);
});

test("nudge RFC records cursor ownership and the watch-only echo limitation", async () => {
  const rfc = await readFile("docs/workstreams.md", "utf8");
  assert.match(rfc, /^## Barbaro nudges .*implemented.*$/mu);
  assert.match(rfc, /\.barbaro\/state\/nudge\/<provider>\/<ses_id>\.json/u);
  assert.match(rfc, /membership_from/u);
  assert.match(rfc, /`barbaro\.nudge-cursor\.v3`/u);
  assert.match(rfc, /v1 and v2 records remain strictly accepted/u);
  assert.match(rfc, /highest unread\s+count announced by any channel/u);
  assert.match(rfc, /synthetic generation/u);
  assert.match(rfc, /unknown fields/u);
  assert.match(rfc, /markers that do not equal `cursor_revision`/u);
  assert.match(rfc, /Readers observe all three\s+schemas without migration/u);
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
