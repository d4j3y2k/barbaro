import assert from "node:assert/strict";
import test from "node:test";

import { centerCells, measureCells } from "../../src/tui/cells.js";
import { COMFORT_CARD, SUB_CARD, TEXT_CARD } from "../../src/tui/geometry.js";
import {
  HORSE_BRAND_WORDMARK,
  HORSE_FRAME_COUNT,
  HORSE_STANDARD_FRAME_INDEX,
  brandedHeroHorseFrame,
  horseFrame,
} from "../../src/tui/horse.js";
import {
  renderBootSplash,
  renderBootTextPage,
  renderComfortCard,
  renderSubCard,
} from "../../src/tui/render-card.js";
import type {
  BootTextView,
  BootView,
  CardView,
} from "../../src/tui/view.js";
import { readFixture } from "./fixtures.test.js";

/**
 * The five commit-2 keyframes, byte for byte. The view models below are the
 * normative reference dataset; the renderer owns every cell between them
 * and the fixture files.
 */

function rendered(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

function framedArtRows(
  lines: readonly string[],
  title: string,
  count: number,
): string[] {
  const top = lines.findIndex((line) => line.includes(title));
  assert.notEqual(top, -1);
  return lines.slice(top + 1, top + 1 + count).map((line) => {
    const left = line.indexOf("│");
    const right = line.lastIndexOf("│");
    assert.ok(left !== -1 && right > left);
    return line.slice(left + 1, right);
  });
}

/** Independent fixture translation for the one-cell horse alphabet. */
function translatedFixtureRows(
  rows: readonly string[],
  left: number,
  width: number,
): string[] {
  return rows.map((row) => {
    const targetStart = Math.max(0, left);
    const sourceStart = Math.max(0, -left);
    const visible = row.slice(
      sourceStart,
      sourceStart + Math.max(0, width - targetStart),
    );
    return `${" ".repeat(targetStart)}${visible}`.padEnd(width).slice(0, width);
  });
}

const WORKING_BENCH_64 = [
  "codex/58d65273 · working",
  "Intent · Approved: contact-print idle...",
  "Action · apply_patch",
  "Latest shown exposure · #23 · succeeded · 02:07",
  "News 13 for codex/58d65273",
  "Publication clear",
];

test("boot-64x28 renders byte-identically", async () => {
  const view: BootView = {
    frameIndex: 10,
    scale: "hero",
    telemetry: "Refresh 1.0s · 23 shown turns · 284 KiB projected",
  };
  assert.equal(
    rendered(renderBootSplash(view, COMFORT_CARD)),
    await readFixture("boot-64x28.txt"),
  );
});

test("all hero boots carry one body mark while compact boots stay raw", () => {
  for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
    const hero = renderBootSplash(
      { frameIndex: index, scale: "hero", telemetry: "Reading store" },
      COMFORT_CARD,
    );
    const heroText = hero.join("\n");
    assert.equal(heroText.split(HORSE_BRAND_WORDMARK).length - 1, 1);
    assert.doesNotMatch(heroText, /B A R B A R O/u);
    assert.match(heroText, /THE HORSE IN MOTION/u);
    assert.deepEqual(
      framedArtRows(hero, `PLATE ${`${index + 1}`.padStart(2, "0")} OF 11`, 13),
      brandedHeroHorseFrame(index),
    );

    const compact = renderBootSplash(
      { frameIndex: index, scale: "compact", telemetry: "Reading store" },
      SUB_CARD,
    );
    assert.doesNotMatch(compact.join("\n"), /b a r b a r o/u);
    assert.deepEqual(
      framedArtRows(
        compact,
        `PLATE ${`${index + 1}`.padStart(2, "0")} OF 11`,
        8,
      ),
      horseFrame(index, "compact", "riderless"),
    );
  }
});

test("compact working plates remain unbranded across the full stride", () => {
  for (let index = 0; index < HORSE_FRAME_COUNT; index += 1) {
    const lines = renderComfortCard({
      location: "branding",
      truth: "1 working",
      frame: {
        kind: "working",
        title: "Motion study",
        horse: { kind: "gallop", frameIndex: index },
        telemetry: "Refresh pending",
        rolls: [],
      },
      bench: [],
      keyLine: "q quit",
    });
    assert.doesNotMatch(lines.join("\n"), /b a r b a r o/u);
    assert.deepEqual(
      framedArtRows(lines, "Motion study", 8),
      horseFrame(index, "compact", "riderless").map(
        (row) => `${" ".repeat(13)}${row}${" ".repeat(13)}`,
      ),
    );
  }
});

test("boot-56x22 renders byte-identically", async () => {
  const view: BootView = {
    frameIndex: 10,
    scale: "compact",
    telemetry: "Refresh 1.0s · 23 shown turns · 284 KiB projected",
  };
  assert.equal(
    rendered(renderBootSplash(view, SUB_CARD)),
    await readFixture("boot-56x22.txt"),
  );
});

test("boot-40x12 renders byte-identically", async () => {
  const view: BootTextView = {
    phase: "Reading the store",
    elapsed: "0.4s",
    projected: "42 KiB",
  };
  assert.equal(
    rendered(renderBootTextPage(view, TEXT_CARD)),
    await readFixture("boot-40x12.txt"),
  );
});

for (const study of [
  {
    name: "comfort",
    card: COMFORT_CARD,
    renderCard: renderComfortCard,
    artAt: brandedHeroHorseFrame,
    artWidth: 56,
    headingRows: 0,
    interiorCells: 62,
    interiorRows: 14,
  },
  {
    name: "sub",
    card: SUB_CARD,
    renderCard: renderSubCard,
    artAt: (frameIndex: number) =>
      horseFrame(frameIndex, "compact", "riderless"),
    artWidth: 36,
    headingRows: 1,
    interiorCells: 54,
    interiorRows: 10,
  },
] as const) {
  test(`lifecycle traversal keeps the ${study.name} card persistent`, () => {
    const caption = "Checking the store before reporting.";
    const keyLine = "Esc request cancel · q quit";
    const bench = [
      "Revision · 4",
      "ID · ws_44c26310af3c86a04eadf62453776f80",
    ];
    const at = (progress: number, frameIndex = 6): string[] =>
      study.renderCard({
        location: "Lifecycle",
        truth: caption,
        frame: {
          kind: "traversal",
          title: "Complete workstream",
          frameIndex,
          progress,
        },
        bench,
        keyLine,
      });
    const first = at(0);
    const middle = at(0.5);
    const last = at(1);
    const frameTop = 3;
    const interiorTop = frameTop + 1;
    const frameBottom = interiorTop + study.interiorRows;
    const artTop = interiorTop + study.headingRows;
    const midpointArt = study.artAt(6);
    const artBottom = artTop + midpointArt.length;
    const blankArt = Array<string>(midpointArt.length).fill(
      " ".repeat(study.interiorCells),
    );
    const artRows = (lines: readonly string[]): string[] =>
      lines.slice(artTop, artBottom).map((row) => row.slice(1, -1));
    const assertPersistentCard = (lines: readonly string[]): void => {
      assert.equal(lines.length, study.card.height);
      assert.ok(lines.every((line) => measureCells(line) === study.card.width));
      assert.match(lines[0]!, /^Barbaro\s+Lifecycle$/u);
      assert.equal(lines[1]!.trimEnd(), caption);
      assert.equal(lines[2]!.trim(), "");
      assert.match(lines[frameTop]!, /^┌─ Complete workstream .*┐$/u);
      for (const row of lines.slice(interiorTop, frameBottom)) {
        assert.match(row, /^│.*│$/u);
      }
      assert.match(lines[frameBottom]!, /^└.*┘$/u);
      assert.equal(lines[frameBottom + 1]!.trim(), "");
      assert.equal(lines[frameBottom + 2]!.trimEnd(), bench[0]);
      assert.equal(lines[frameBottom + 3]!.trimEnd(), bench[1]);
      assert.equal(lines.at(-1)!.trimEnd(), keyLine);
    };

    for (const lines of [first, middle, last]) {
      assertPersistentCard(lines);
    }
    assert.deepEqual(artRows(first), blankArt);
    assert.deepEqual(
      artRows(middle),
      midpointArt.map((row) => centerCells(row, study.interiorCells)),
    );
    assert.deepEqual(artRows(last), blankArt);

    const stride = Array.from({ length: HORSE_FRAME_COUNT }, (_unused, tick) =>
      at(tick / (HORSE_FRAME_COUNT - 1), tick),
    );
    for (const [tick, lines] of stride.entries()) {
      assertPersistentCard(lines);
      const progress = tick / (HORSE_FRAME_COUNT - 1);
      const left = Math.round(
        -study.artWidth +
          progress * (study.interiorCells + study.artWidth),
      );
      assert.deepEqual(
        artRows(lines),
        translatedFixtureRows(
          study.artAt(tick),
          left,
          study.interiorCells,
        ),
      );
    }
    const leftEdge = artRows(stride[1]!);
    const rightEdge = artRows(stride.at(-2)!);
    assert.ok(leftEdge.some((row) => row.trim().length > 0));
    assert.ok(rightEdge.some((row) => row.trim().length > 0));
    assert.ok(
      leftEdge.every((row) => {
        const lastCell = row.search(/\s*$/u);
        return row.trim().length === 0 || lastCell < study.interiorCells / 2;
      }),
    );
    assert.ok(
      rightEdge.every((row) => {
        const firstCell = row.search(/\S/u);
        return firstCell === -1 || firstCell >= study.interiorCells / 2;
      }),
    );
    if (study.card.tier === "sub") {
      for (const lines of stride) {
        assert.equal(lines[interiorTop]!.slice(1, -1).trim(), "B A R B A R O");
      }
    }
  });
}

const HUB_VIEW: CardView = {
  location: "Home · Open",
  truth: "News 1/1 · tui-reboot/Codex · 13 unread · working",
  frame: {
    kind: "hub",
    title: "Open workstreams · / completed",
    entries: [
      {
        selected: true,
        position: 1,
        name: "tui-reboot",
        detail: "Working now",
      },
      {
        selected: false,
        position: 2,
        name: "coordination",
        detail: "Last shown · 1d22h",
      },
    ],
    bottomTitle: "1 of 2 open · 10 completed",
  },
  bench: [
    "tui-reboot · open · 3 sessions",
    "TUI ground-up redesign: the motion study",
    "Working now · latest shown exposure 2 minutes ago",
    "ID · ws_44c26310af3c86a04eadf62453776f80",
    "/barbaro join tui-reboot",
    "Project · barbaro · root /Users/davidkim/Developer/barbaro",
  ],
  keyLine:
    "j/k · Enter · / completed · x complete · n new · r refresh · ? help · q quit",
};

const COMPLETED_HUB_VIEW: CardView = {
  location: "Home · Completed",
  truth: "10 completed · 2 open",
  frame: {
    kind: "hub",
    title: "Completed workstreams · / open",
    entries: [
      ["tui-design", "Completed · 12m"],
      ["tui-build", "Completed · 15h12m"],
      ["tui-reboot", "Completed · 1d11h"],
      ["alpha3-release", "Completed · 1d16h"],
      ["nudge-gate", "Completed · 1d16h"],
      ["alpha-audit", "Completed · 2d13h"],
      ["public-alpha", "Completed · 2d14h"],
      ["ingest-reliability", "Completed · 2d16h"],
      ["wake-nudge", "Completed · 2d20h"],
      ["codex-wake", "Completed · 3d11h"],
    ].map(([name, detail], index) => ({
      selected: index === 0,
      position: index + 1,
      name: name!,
      detail: detail!,
    })),
    bottomTitle: "1 of 10 completed · 2 open",
  },
  bench: [
    "tui-design · completed · 0 sessions",
    "TUI interface design",
    "No shown work · latest shown exposure 12 minutes ago",
    "ID · ws_74cb1f1a74bb4cbfb57c3c9d8c0ab2f0",
    "Completed · x reopens after confirmation",
    "Project · barbaro · root /Users/davidkim/Developer/barbaro",
  ],
  keyLine:
    "j/k · Enter · / open · x reopen · n new · r refresh · ? help · q quit",
};

test("hub-64x28 renders byte-identically", async () => {
  const lines = renderComfortCard(HUB_VIEW);
  assert.equal(rendered(lines), await readFixture("hub-64x28.txt"));
  const frameTop = lines.findIndex((line) => line.includes("Open workstreams"));
  const firstEntry = lines.findIndex((line) => line.includes("> tui-reboot"));
  assert.equal(firstEntry - frameTop, 2);
});

test("hub-56x22 keeps complete key promises byte-identically", async () => {
  const lines = renderSubCard(HUB_VIEW);
  assert.equal(rendered(lines), await readFixture("hub-56x22.txt"));
  const footer = lines.at(-1)!.trimEnd();
  assert.equal(
    footer,
    "j/k · Enter · / completed · x complete · ? help · q quit",
  );
  assert.doesNotMatch(footer, /·\s*$|q q$|q qui$/u);
});

test("completed-hub-64x28 renders byte-identically", async () => {
  assert.equal(
    rendered(renderComfortCard(COMPLETED_HUB_VIEW)),
    await readFixture("hub-completed-64x28.txt"),
  );
});

test("completed-hub-56x22 keeps reopen reachable byte-identically", async () => {
  const lines = renderSubCard(COMPLETED_HUB_VIEW);
  assert.equal(
    rendered(lines),
    await readFixture("hub-completed-56x22.txt"),
  );
  assert.equal(
    lines.at(-1)!.trimEnd(),
    "j/k · Enter · / open · x reopen · ? help · q quit",
  );
});

test("the compact hub spends its reclaimed row on one more entry", () => {
  const entries = Array.from({ length: 14 }, (_unused, index) => ({
    selected: index === 0,
    position: index + 1,
    name: `stream-${`${index + 1}`.padStart(2, "0")}`,
    detail: "Attention",
  }));
  const view: CardView = {
    location: "Home",
    truth: "14 workstreams",
    frame: {
      kind: "hub",
      title: "Workstreams",
      entries,
      bottomTitle: `1 of ${entries.length}`,
    },
    bench: [],
    keyLine: "q quit",
  };
  const comfort = rendered(renderComfortCard(view));
  assert.match(comfort, /stream-13/u);
  assert.doesNotMatch(comfort, /stream-14/u);

  const sub = rendered(renderSubCard(view));
  assert.match(sub, /stream-09/u);
  assert.doesNotMatch(sub, /stream-10/u);
});

test("the sub-card hub distinguishes bounded history from a recent gap", () => {
  const view: CardView = {
    location: "Home",
    truth: "All workstreams are accounted for",
    frame: {
      kind: "hub",
      title: "Workstreams",
      entries: [
        {
          selected: true,
          position: 1,
          name: "bounded",
          detail: "Last shown · 1d22h",
        },
        {
          selected: false,
          position: 2,
          name: "gap",
          detail: "Data incomplete",
        },
      ],
      bottomTitle: "1 of 2",
    },
    bench: [],
    keyLine: "q quit",
  };
  const output = rendered(renderSubCard(view));
  assert.match(output, /Last shown · 1d22h/u);
  assert.match(output, /Data incomplete/u);
  assert.doesNotMatch(output, /Data incomplete ·/u);
});

test("dashboard-working-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "tui-reboot",
    truth: "1 working · 1 waiting · News 13 for codex/58d65273",
    frame: {
      kind: "working",
      title: "Motion study",
      horse: { kind: "gallop", frameIndex: HORSE_STANDARD_FRAME_INDEX },
      telemetry: "Refresh age 0.4s · 23 shown turns · 284 KiB projected",
      rolls: [
        { selected: true, identity: "codex/58d65273", detail: "Working..." },
        {
          selected: false,
          identity: "claude/460d4a94",
          detail: "Waiting · target unknown",
        },
        {
          selected: false,
          identity: "claude/969a63de",
          detail: "No shown lease",
        },
      ],
    },
    bench: WORKING_BENCH_64,
    keyLine:
      "j/k · x complete · Esc home · Space pause · r refresh · ? help · q quit",
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("dashboard-working-64x28.txt"),
  );
});

test("dashboard-once-still-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "tui-reboot · snapshot",
    truth: "News 13 for codex/58d65273 · 1 working · 1 waiting",
    frame: {
      kind: "working",
      title: "Motion study · snapshot",
      horse: {
        kind: "gallop",
        frameIndex: HORSE_STANDARD_FRAME_INDEX,
      },
      rolls: [
        { selected: true, identity: "codex/58d65273", detail: "Working" },
        {
          selected: false,
          identity: "claude/460d4a94",
          detail: "Waiting · target unknown",
        },
        {
          selected: false,
          identity: "claude/969a63de",
          detail: "No shown lease",
        },
      ],
    },
    bench: [
      "codex/58d65273 · working at snapshot",
      "Latest shown exposure · #23 · succeeded · 02:07",
      "News 13 for codex/58d65273",
      "Publication clear",
      "Snapshot · 2026-08-25 02:07:00Z",
      "Project · barbaro · root /Users/davidkim/Developer/barbaro",
    ],
    keyLine: "Snapshot · tui-reboot · captured 2026-08-25 02:07:00Z",
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("dashboard-once-still-64x28.txt"),
  );
});

test("a full five-row comfort roster reclaims the optional breathing row", () => {
  const identities = Array.from(
    { length: 5 },
    (_unused, index) => `codex/row-0${index + 1}`,
  );
  const lines = renderComfortCard({
    location: "tui-reboot",
    truth: "5 working",
    frame: {
      kind: "working",
      title: "Motion study",
      horse: { kind: "gallop", frameIndex: 6 },
      telemetry: "Refresh pending",
      rolls: identities.map((identity, index) => ({
        selected: index === 4,
        identity,
        detail: "Working...",
      })),
    },
    bench: [],
    keyLine: "q quit",
  });
  for (const identity of identities) {
    assert.match(lines.join("\n"), new RegExp(identity, "u"));
  }
  const telemetry = lines.findIndex((line) => /Refresh pending/u.test(line));
  assert.ok(telemetry !== -1);
  assert.match(lines[telemetry + 1]!, /codex\/row-01/u);
});

test("a one-row sub roster receives the optional breathing row", () => {
  const identity = "codex/only-row";
  const lines = renderSubCard({
    location: "tui-reboot",
    truth: "1 working",
    frame: {
      kind: "working",
      title: "Motion study",
      horse: { kind: "gallop", frameIndex: 6 },
      rolls: [{ selected: true, identity, detail: "Working..." }],
    },
    bench: [],
    keyLine: "q quit",
  });
  const rosterRow = lines.findIndex((line) => line.includes(identity));
  assert.ok(rosterRow > 0);
  assert.match(lines[rosterRow - 1]!, /^│\s+│$/u);
});

test("dashboard-working-56x22 renders byte-identically", async () => {
  const view: CardView = {
    location: "tui-reboot",
    truth: "News 13 for codex/58d65273 · 1 working · 1 more session",
    frame: {
      kind: "working",
      title: "Motion study",
      horse: { kind: "gallop", frameIndex: 6 },
      rolls: [
        { selected: true, identity: "codex/58d65273", detail: "Working..." },
        {
          selected: false,
          identity: "claude/460d4a94",
          detail: "Waiting · target unknown",
        },
      ],
    },
    bench: [
      "codex/58d65273 · working",
      "Intent · Approved: contact-print idle...",
      "Action · apply_patch",
      "News 13 for codex/58d65273 · publication clear",
    ],
    keyLine:
      "j/k · x complete · Esc home · r refresh · ? help · q quit",
  };
  assert.equal(
    rendered(renderSubCard(view)),
    await readFixture("dashboard-working-56x22.txt"),
  );
});

const IDLE_LEDGER_VIEW: CardView = {
  location: "tui-reboot",
  truth: "No work is shown. 10 recent exposures are complete.",
  frame: {
    kind: "idle",
    title: "The study so far",
    exposures: [
      { selected: false, sequence: 65, time: "00:52", excerpt: "PLAN APPROVED — reshape the view", excerptTruncated: false },
      { selected: false, sequence: 66, time: "01:03", excerpt: "Mapped the response preview seam", excerptTruncated: false },
      { selected: false, sequence: 67, time: "01:12", excerpt: "The vertical ledger is ready", excerptTruncated: false },
      { selected: false, sequence: 68, time: "01:21", excerpt: "Kept session navigation unchanged", excerptTruncated: false },
      { selected: false, sequence: 69, exception: "Failed", time: "01:29", excerpt: "First fixture pass exposed a gap", excerptTruncated: false },
      { selected: false, sequence: 70, time: "01:40", excerpt: "Capacity now follows card height", excerptTruncated: false },
      { selected: false, sequence: 71, time: "01:48", excerpt: "Success stays silent in the ledger", excerptTruncated: false },
      { selected: false, sequence: 72, exception: "Unknown", time: "01:55", excerpt: "Projection ended before the verdict", excerptTruncated: true },
      { selected: false, sequence: 73, time: "02:01", excerpt: "CHECKPOINT 12 is nearly ready", excerptTruncated: false },
      { selected: true, sequence: 74, time: "02:06", excerpt: "Done — the workstream story reads clearly", excerptTruncated: false },
    ],
    summaryLine: "Oldest to newest · 3 sessions · 15 turns shown",
    rolls: [
      {
        selected: false,
        identity: "codex/58d65273",
        detail: "Last shown #23",
      },
      {
        selected: false,
        identity: "claude/969a63de",
        detail: "Last shown #74",
      },
      {
        selected: true,
        identity: "claude/460d4a94",
        detail: "Last shown #10",
      },
    ],
  },
  bench: [
    "#10 · succeeded · claude/460d4a94",
    "Request · earlier session detail...",
    "Ended · 00:48 · 2 actions · response present",
    "Selected session exposure",
    "Publication clear",
  ],
  keyLine: "x complete · Esc home · r refresh · ? help · q quit",
};

test("dashboard-idle-64x28 renders the full ledger byte-identically", async () => {
  assert.equal(
    rendered(renderComfortCard(IDLE_LEDGER_VIEW)),
    await readFixture("dashboard-idle-64x28.txt"),
  );
});

test("dashboard-idle-56x22 keeps the newest ledger and selected roll", async () => {
  const result = rendered(renderSubCard(IDLE_LEDGER_VIEW));
  assert.equal(result, await readFixture("dashboard-idle-56x22.txt"));
  assert.doesNotMatch(result, /#65|#66|#67/u);
  assert.match(result, /#68/u);
  assert.match(result, /#74/u);
  assert.doesNotMatch(result, /Succeeded/u);
  assert.match(result, /! Failed ·/u);
  assert.match(result, /! Unknown ·/u);
  assert.doesNotMatch(result, /codex\/58d65273/u);
  assert.match(result, /> claude\/460d4a94/u);
});

test("an upstream-truncated response keeps an explicit ledger ellipsis", () => {
  const result = rendered(
    renderComfortCard({
      ...IDLE_LEDGER_VIEW,
      frame: {
        kind: "idle",
        title: "The study so far",
        exposures: [
          {
            selected: true,
            sequence: 1,
            time: "02:06",
            excerpt: "Short projected response",
            excerptTruncated: true,
          },
        ],
        summaryLine: "Oldest to newest · 1 session · 1 turn shown",
        rolls: [],
      },
    }),
  );
  assert.match(result, /> #1\s+02:06\s+Short projected response\.\.\./u);
});

test("help-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "Help",
    truth: "Help is read-only. Esc returns to the current selection.",
    frame: {
      kind: "help",
      title: "Words and keys",
      keyRows: [
        { term: "j/k · Enter/Esc", meaning: "Move / open / back" },
        {
          term: "n / on Home",
          meaning: "Create / switch Open or Completed",
        },
        {
          term: "x on selection",
          meaning: "Complete / reopen after confirmation",
        },
        {
          term: "r · ? · Space",
          meaning: "Refresh / help / pause-resume",
        },
      ],
      wordRows: [
        { term: "Working now", meaning: "A shown lease is working" },
        {
          term: "Waiting/Blocked",
          meaning: "A shown lease is waiting or blocked",
        },
        { term: "Needs input", meaning: "Input is needed from the user" },
        {
          term: "Quiet",
          meaning: "Complete proof: no work or attention",
        },
        {
          term: "Last shown",
          meaning: "Recent proof; older history is bounded",
        },
        {
          term: "Activity unknown",
          meaning: "Activity evidence is incomplete",
        },
        { term: "News", meaning: "Unread peer turns waiting for a session" },
        {
          term: "Publish blocked",
          meaning: "A complete publish check found a jam",
        },
        {
          term: "Data incomplete",
          meaning: "Required evidence was unavailable",
        },
      ],
    },
    bench: [
      "Home opens on Open; / switches to Completed.",
      "Completion does not stop joined sessions.",
      "Claims are advisory path evidence, not locks.",
      "Opening help never reads, acknowledges, or writes data.",
    ],
    keyLine: "Esc close · q quit",
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("help-64x28.txt"),
  );
});

const LIFECYCLE_PROJECT_LINES = [
  "2 open · 10 completed",
  "ID · ws_44c26310af3c86a04eadf62453776f80",
  "Project · barbaro · root /Users/davidkim/Developer/barbaro",
];

const LIFECYCLE_CONFIRM_VIEW: CardView = {
  location: "Confirm",
  truth: "No change has been made.",
  frame: {
    kind: "intertitle",
    title: "Complete tui-reboot?",
    lines: [
      "Enter · Yes",
      "Esc · No",
      "",
      "● Waiting on you",
    ],
  },
  bench: [
    "tui-reboot · open · Codex 2 · Claude 1",
    "TUI ground-up redesign: the motion study",
    "13 unread · latest activity 2m",
    "ID · ws_44c26310af3c86a04eadf62453776f80",
    "Revision · 3",
    "Project · barbaro · root /Users/davidkim/Developer/barbaro",
  ],
  keyLine: "Enter yes · Esc no · q quit",
};

const LIFECYCLE_PENDING_VIEW: CardView = {
  location: "Lifecycle",
  truth: "Completing tui-reboot…",
  frame: {
    kind: "intertitle",
    title: "Complete workstream",
    lines: [
      "Completing tui-reboot…",
      "Running the public workstream command.",
      "Checking the store before reporting.",
    ],
  },
  bench: LIFECYCLE_PROJECT_LINES,
  keyLine: "Esc request cancel · q quit",
};

const LIFECYCLE_CONFIRMED_VIEW: CardView = {
  location: "Lifecycle",
  truth: "tui-reboot is completed.",
  frame: {
    kind: "intertitle",
    title: "Completed",
    lines: [
      "tui-reboot is completed.",
      "The status was confirmed by a fresh store read.",
    ],
  },
  bench: [
    "Revision · 4",
    "1 open · 11 completed",
    "ID · ws_44c26310af3c86a04eadf62453776f80",
    "Project · barbaro · root /Users/davidkim/Developer/barbaro",
  ],
  keyLine: "Esc Open · / completed · ? help · q quit",
};

for (const [name, view] of [
  ["lifecycle-confirm", LIFECYCLE_CONFIRM_VIEW],
  ["lifecycle-pending", LIFECYCLE_PENDING_VIEW],
  ["lifecycle-confirmed", LIFECYCLE_CONFIRMED_VIEW],
] as const) {
  test(`${name}-64x28 renders byte-identically`, async () => {
    assert.equal(
      rendered(renderComfortCard(view)),
      await readFixture(`${name}-64x28.txt`),
    );
  });

  test(`${name}-56x22 renders byte-identically`, async () => {
    assert.equal(
      rendered(renderSubCard(view)),
      await readFixture(`${name}-56x22.txt`),
    );
  });
}

const CREATED_SUBTITLE =
  "Explore the motion-study interface for every adventurous visitor";
const CREATED_FRAME = {
  kind: "created" as const,
  title: "Created",
  name: "motion-study",
  subtitle: CREATED_SUBTITLE,
  idLine: "ws_d3c1a9e4 \u00b7 open",
  commands: [
    {
      heading: "Join from Claude Code",
      text: "/barbaro join motion-study",
      selected: true,
      manualHighlight: false,
    },
    {
      heading: "Join from Codex",
      text: "$barbaro join motion-study",
      selected: false,
      manualHighlight: false,
    },
  ],
};
const CREATED_TRUTH =
  "motion-study was created. Creation itself enrolled no sessions.";
const CREATED_KEY =
  "j/k \u00b7 c copy \u00b7 r refresh \u00b7 Esc home \u00b7 ? help \u00b7 q quit";
const PROJECT_LINES = [
  "Project \u00b7 barbaro",
  "Root \u00b7 /Users/davidkim/Developer/barbaro",
];

test("bench and created subtitle prose clips with an explicit boundary", () => {
  const created = renderComfortCard({
    location: "New workstream",
    truth: CREATED_TRUTH,
    frame: CREATED_FRAME,
    bench: [],
    keyLine: "q quit",
  }).join("\n");
  assert.match(
    created,
    /Explore the motion-study interface for every adventurous\.\.\./u,
  );
  assert.doesNotMatch(created, /adventurous visitor/u);

  const bench = renderSubCard({
    location: "Home",
    truth: "Prose study",
    frame: {
      kind: "intertitle",
      title: "Prose",
      lines: ["Word-safe clipping"],
    },
    bench: [
      "A concise beginning followed by spectacularlylongword and more",
    ],
    keyLine: "q quit",
  }).join("\n");
  assert.match(
    bench,
    /A concise beginning followed by spectacularlylongword\.\.\./u,
  );
  assert.doesNotMatch(bench, /spectacularlylongword an/u);
});

test("create-form-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "New workstream",
    truth: "Name and title are ready.",
    frame: {
      kind: "form",
      title: "Create",
      fields: [
        { label: "Name", value: "motion-study", focused: true },
        {
          label: "Title",
          value: CREATED_SUBTITLE,
          focused: false,
        },
      ],
      hints: [
        "Use 1-64 lowercase letters, numbers, or hyphens.",
        "Start and end with a letter or number.",
      ],
      status: "Ready to create",
      showCursor: true,
    },
    bench: [
      ...PROJECT_LINES,
      "Name \u00b7 motion-study",
      `Title \u00b7 ${CREATED_SUBTITLE}`,
      "Sessions joined by creation \u00b7 none",
    ],
    keyLine:
      "Tab/Shift-Tab \u00b7 Ctrl-S create \u00b7 Esc cancel",
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("create-form-64x28.txt"),
  );
});

test("create-success-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "New workstream",
    truth: CREATED_TRUTH,
    frame: CREATED_FRAME,
    bench: [
      "motion-study \u00b7 open",
      "Selected \u00b7 /barbaro join motion-study",
      "ID \u00b7 ws_d3c1a9e4b72f54a0c86120e2f7d9aa15",
      "Creation itself enrolled no sessions",
      ...PROJECT_LINES,
    ],
    keyLine: CREATED_KEY,
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("create-success-64x28.txt"),
  );
});

test("create-success-punched-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "New workstream",
    truth: CREATED_TRUTH,
    frame: CREATED_FRAME,
    bench: [
      "Claude Code join command \u00b7 selected",
      "Punched \u00b7 /barbaro join motion-study",
      "Clipboard updated. The command was not run.",
      "ID \u00b7 ws_d3c1a9e4b72f54a0c86120e2f7d9aa15",
      ...PROJECT_LINES,
    ],
    keyLine: CREATED_KEY,
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("create-success-punched-64x28.txt"),
  );
});

test("create-success-no-clipboard-64x28 renders byte-identically", async () => {
  const view: CardView = {
    location: "New workstream",
    truth: CREATED_TRUTH,
    frame: {
      ...CREATED_FRAME,
      commands: [
        { ...CREATED_FRAME.commands[0]!, manualHighlight: true },
        CREATED_FRAME.commands[1]!,
      ],
    },
    bench: [
      "Claude Code join command \u00b7 selected",
      "/barbaro join motion-study",
      "Clipboard unavailable. Copy the selected line manually.",
      "The command was not run.",
      ...PROJECT_LINES,
    ],
    keyLine:
      "j/k \u00b7 c retry \u00b7 r refresh \u00b7 Esc home \u00b7 ? help \u00b7 q quit",
  };
  assert.equal(
    rendered(renderComfortCard(view)),
    await readFixture("create-success-no-clipboard-64x28.txt"),
  );
});
