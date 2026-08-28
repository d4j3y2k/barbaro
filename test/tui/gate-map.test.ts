import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

/**
 * Appendix E, gate by gate. Every comfort-spec verification gate names the
 * test that demonstrates it, or carries a written reason in place of one —
 * no silent omissions. This file asserts the map stays true: every named
 * covering test exists verbatim in its named file.
 */

interface GateEntry {
  readonly gate: number;
  readonly claim: string;
  readonly coveredBy: readonly { file: string; test: string }[];
  readonly reason?: string;
}

const GATE_MAP: readonly GateEntry[] = [
  {
    gate: 1,
    claim: "index and validator name the same twenty-six files",
    coveredBy: [
      {
        file: "test/tui/fixtures.test.ts",
        test: "the fixture directory holds exactly the twenty-six indexed keyframes",
      },
      {
        file: "test/tui/fixtures.test.ts",
        test: "every keyframe has exact filename dimensions and a final newline",
      },
    ],
  },
  {
    gate: 2,
    claim: "default card anatomy sums to 28 rows",
    coveredBy: [
      {
        file: "test/tui/geometry.test.ts",
        test: "the anatomy sums are exactly the card heights (gates 2 and 3)",
      },
    ],
  },
  {
    gate: 3,
    claim: "sub-card anatomy sums to 22 rows",
    coveredBy: [
      {
        file: "test/tui/geometry.test.ts",
        test: "the anatomy sums are exactly the card heights (gates 2 and 3)",
      },
    ],
  },
  {
    gate: 4,
    claim: "no canvas carries diamonds, engine ids, legends, or sigils",
    coveredBy: [
      {
        file: "test/tui/gate-map.test.ts",
        test: "no keyframe canvas carries banned chrome (gate 4)",
      },
    ],
  },
  {
    gate: 5,
    claim: "Home contains no horse art or gait tokens",
    coveredBy: [
      {
        file: "test/tui/gate-map.test.ts",
        test: "Home carries no horse art or shading (gate 5)",
      },
    ],
  },
  {
    gate: 6,
    claim: "live cards use the complete 36x8 plate; statics use the strip",
    coveredBy: [
      {
        file: "test/tui/render-golden.test.ts",
        test: "dashboard-working-64x28 renders byte-identically",
      },
      {
        file: "test/tui/render-golden.test.ts",
        test: "dashboard-working-56x22 renders byte-identically",
      },
      {
        file: "test/tui/fixtures.test.ts",
        test: "the checked-in strip asset is byte-identical to its keyframe",
      },
    ],
  },
  {
    gate: 7,
    claim: "40x12 and 12x6 use words; below 12x6 uses actual geometry",
    coveredBy: [
      {
        file: "test/tui/geometry.test.ts",
        test: "below the floor the notice uses true geometry and zero emits nothing",
      },
      {
        file: "test/tui/cli.test.ts",
        test: "tui --once composes the §8 ladder at exactly the requested size",
      },
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "narrow steady-state pages render byte-identically with honest escapes",
      },
    ],
  },
  {
    gate: 8,
    claim: "larger dimensions center the same card without new density",
    coveredBy: [
      {
        file: "test/tui/geometry.test.ts",
        test: "a larger terminal centers the same card in deterministic matte",
      },
      {
        file: "test/tui/cli.test.ts",
        test: "wide tui snapshots center the same card in deterministic matte",
      },
    ],
  },
  {
    gate: 9,
    claim: "same inputs produce byte-identical --once output with the strip",
    coveredBy: [
      {
        file: "test/tui/cli.test.ts",
        test: "tui --once resolves workstream names and IDs and scopes the reader",
      },
    ],
  },
  {
    gate: 10,
    claim: "quiet and incomplete open workstreams remain individually reachable",
    coveredBy: [
      {
        file: "test/tui/reduce.test.ts",
        test: "every open workstream remains individually selectable",
      },
    ],
  },
  {
    gate: 11,
    claim: "incomplete evidence blocks no-work, empty, all-clear, healthy",
    coveredBy: [
      {
        file: "test/tui/reduce.test.ts",
        test: "no-work apertures follow the evidence, never the word idle",
      },
      {
        file: "test/reader/catalogue.test.ts",
        test: "quiet is proven only with complete evidence and zero attention",
      },
    ],
  },
  {
    gate: 12,
    claim: "exact unread needs a complete scan; the TUI never acknowledges",
    coveredBy: [
      {
        file: "test/reader/unread-summary.test.ts",
        test: "invalid and rebuilt cursor regions are unknown, never zero",
      },
      {
        file: "test/reader/unread-summary.test.ts",
        test: "an absent store yields a pure deterministic virtual zero",
      },
    ],
  },
  {
    gate: 13,
    claim: "missing or invalid publish evidence never says clear",
    coveredBy: [
      {
        file: "test/reader/publish-summary.test.ts",
        test: "an absent journal is deterministic unknown and never creates the store",
      },
      {
        file: "test/reader/publish-summary.test.ts",
        test: "legacy, malformed, invalid, and identity-mismatched journals stay unknown and unchanged",
      },
    ],
  },
  {
    gate: 14,
    claim: "create covers invalid, pending, races, malformed, and resize",
    coveredBy: [
      {
        file: "test/tui/create-flow.test.ts",
        test: "settle keeps every §5 outcome distinct and proof-shaped",
      },
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "the create flow edits literally, submits by chord, and punches honestly",
      },
    ],
  },
  {
    gate: 15,
    claim: "paste cannot submit, punch, or execute command keys",
    coveredBy: [
      {
        file: "test/tui/comfort-input.test.ts",
        test: "a bracketed paste arrives whole and its bytes never become commands",
      },
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "pasted command keys never act; typed ones do",
      },
    ],
  },
  {
    gate: 16,
    claim: "TERM=dumb emits no controls and exits 2; --once unaffected",
    coveredBy: [
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "TERM=dumb is refused with the exact lines and zero terminal bytes",
      },
      {
        file: "test/tui/cli.test.ts",
        test: "tui --once is always plain, noninteractive, and accepts styling controls",
      },
    ],
  },
  {
    gate: 17,
    claim: "absent, degraded, refused, empty, and too-small stay distinct",
    coveredBy: [
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "an absent store is the No film loaded screen and reads no catalogue",
      },
      {
        file: "test/tui/reduce.test.ts",
        test: "no-work apertures follow the evidence, never the word idle",
      },
    ],
  },
  {
    gate: 18,
    claim: "every interior line uses the sanitized measured cell buffer",
    coveredBy: [
      {
        file: "test/tui/cells.test.ts",
        test: "frame walls sit at fixed columns regardless of interior content",
      },
      {
        file: "test/tui/cells.test.ts",
        test: "padding produces exactly the requested cells for hostile content",
      },
    ],
  },
  {
    gate: 19,
    claim: "NO_COLOR changes styling only; motion has its own policy",
    coveredBy: [
      {
        file: "test/tui/cli.test.ts",
        test: "interactive tui keeps motion independent of color and refuses TERM=dumb",
      },
    ],
  },
  {
    gate: 20,
    claim: "detail stops sit at card column 38 and sub-card column 26",
    coveredBy: [
      {
        file: "test/tui/render-golden.test.ts",
        test: "dashboard-working-64x28 renders byte-identically",
      },
      {
        file: "test/tui/render-golden.test.ts",
        test: "dashboard-working-56x22 renders byte-identically",
      },
    ],
  },
  {
    gate: 21,
    claim: "exactly one editor-cursor underscore, excluded from values",
    coveredBy: [
      {
        file: "test/tui/render-golden.test.ts",
        test: "create-form-64x28 renders byte-identically",
      },
      {
        file: "test/tui/create-flow.test.ts",
        test: "the writer argv is fields only, with the trimmed optional title",
      },
    ],
  },
  {
    gate: 22,
    claim: "the confirmed fixture contains exactly the Punched line",
    coveredBy: [
      {
        file: "test/tui/render-golden.test.ts",
        test: "create-success-punched-64x28 renders byte-identically",
      },
    ],
  },
  {
    gate: 23,
    claim: "the unavailable fixture repeats the raw command, no Punched",
    coveredBy: [
      {
        file: "test/tui/render-golden.test.ts",
        test: "create-success-no-clipboard-64x28 renders byte-identically",
      },
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "a missing helper never claims Punched and offers manual copy",
      },
    ],
  },
  {
    gate: 24,
    claim: "only reported_success renders Punched",
    coveredBy: [
      {
        file: "test/tui/create-flow.test.ts",
        test: "only helper exit 0 reports success; everything else stays honest",
      },
    ],
  },
  {
    gate: 25,
    claim: "punch payloads compare byte-for-byte; short forms are ineligible",
    coveredBy: [
      {
        file: "test/tui/create-flow.test.ts",
        test: "punch payloads are exact or refused, never truncated",
      },
      {
        file: "test/tui/comfort-shell.test.ts",
        test: "the create flow edits literally, submits by chord, and punches honestly",
      },
    ],
  },
  {
    gate: 26,
    claim: "--once performs no clipboard or terminal-control side effect",
    coveredBy: [
      {
        file: "test/tui/cli.test.ts",
        test: "tui --once resolves workstream names and IDs and scopes the reader",
      },
      {
        file: "test/tui/cli.test.ts",
        test: "tui --once is always plain, noninteractive, and accepts styling controls",
      },
    ],
  },
  {
    gate: 27,
    claim: "repository status remains clean; no src/ change in that round",
    coveredBy: [],
    reason:
      "Gate 27 closed the design-only tui-reboot round, which shipped no code. " +
      "The tui-build workstream exists to change src/ under its own approved " +
      "plan and per-checkpoint clean-tree audits, so this gate is recorded as " +
      "satisfied by that round and out of scope for this suite.",
  },
];

test("every Appendix E gate is covered by a named test or a written reason", async () => {
  assert.equal(GATE_MAP.length, 27);
  const contents = new Map<string, string>();
  for (const entry of GATE_MAP) {
    assert.equal(
      entry.coveredBy.length > 0 || entry.reason !== undefined,
      true,
      `gate ${entry.gate} has coverage or a reason`,
    );
    for (const coverage of entry.coveredBy) {
      let text = contents.get(coverage.file);
      if (text === undefined) {
        text = await readFile(join(process.cwd(), coverage.file), "utf8");
        contents.set(coverage.file, text);
      }
      assert.ok(
        text.includes(`"${coverage.test}"`),
        `gate ${entry.gate}: ${coverage.file} defines "${coverage.test}"`,
      );
    }
  }
});

test("no keyframe canvas carries banned chrome (gate 4)", async () => {
  const fixtures = [
    "boot-40x12.txt",
    "boot-56x22.txt",
    "boot-64x28.txt",
    "create-form-11x4.txt",
    "create-form-12x6.txt",
    "hub-56x22.txt",
    "hub-40x12.txt",
    "hub-64x28.txt",
    "hub-completed-56x22.txt",
    "hub-completed-64x28.txt",
    "lifecycle-confirm-56x22.txt",
    "lifecycle-confirm-64x28.txt",
    "lifecycle-confirmed-56x22.txt",
    "lifecycle-confirmed-64x28.txt",
    "lifecycle-pending-56x22.txt",
    "lifecycle-pending-64x28.txt",
    "dashboard-working-64x28.txt",
    "dashboard-idle-56x22.txt",
    "dashboard-idle-64x28.txt",
    "create-form-64x28.txt",
    "create-success-64x28.txt",
    "create-success-punched-64x28.txt",
    "create-success-no-clipboard-64x28.txt",
    "dashboard-once-strip-64x28.txt",
    "dashboard-working-56x22.txt",
    "help-64x28.txt",
  ];
  for (const name of fixtures) {
    const canvas = await readFile(
      join(process.cwd(), "test", "tui", "fixtures", name),
      "utf8",
    );
    assert.doesNotMatch(canvas, /◇|◆/u, name);
    assert.doesNotMatch(canvas, /E-0[1-8]/u, name);
    assert.doesNotMatch(canvas, /\[g\d\d\]/u, name);
  }
});

test("Home carries no horse art or shading (gate 5)", async () => {
  for (const name of ["hub-64x28.txt", "hub-completed-64x28.txt"]) {
    const hub = await readFile(
      join(process.cwd(), "test", "tui", "fixtures", name),
      "utf8",
    );
    assert.doesNotMatch(hub, /[█▓▒░]/u, name);
    assert.doesNotMatch(hub, /horse|gallop|F0\d/iu, name);
  }
});
