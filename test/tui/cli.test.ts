import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ActiveLeaseStore } from "../../src/active/store.js";
import { main } from "../../src/cli.js";
import type { BarbaroTurnV1 } from "../../src/contracts/v1.js";
import { stableJsonLine } from "../../src/core/stable-json.js";
import type { ComfortAppOptions } from "../../src/tui/comfort-app.js";
import { measureCells } from "../../src/tui/cells.js";
import {
  horseFrame,
  HORSE_STANDARD_FRAME_INDEX,
} from "../../src/tui/horse.js";
import { WorkstreamStore } from "../../src/workstreams/store.js";

const execFileAsync = promisify(execFile);

interface CapturedIo {
  readonly io: {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
  };
  readonly output: string[];
  readonly errors: string[];
}

function capture(): CapturedIo {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    },
    output,
    errors,
  };
}

async function withProject(
  run: (project: string) => Promise<void>,
): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), "barbaro-tui-cli-"));
  try {
    await run(project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

async function snapshot(
  project: string,
  flags: readonly string[] = [],
): Promise<string> {
  const captured = capture();
  assert.equal(
    await main(
      ["tui", "--once", "--project-root", project, ...flags],
      captured.io,
    ),
    0,
  );
  assert.deepEqual(captured.errors, []);
  assert.equal(captured.output.length, 1);
  return captured.output[0]!;
}

function shortWorkstreamId(workstreamId: string): string {
  return workstreamId.slice(0, 11);
}

function assertFrame(output: string, width: number, height: number): void {
  assert.ok(output.endsWith("\n"), "CLI snapshots end with one newline");
  const lines = output.slice(0, -1).split("\n");
  assert.equal(lines.length, height);
  assert.ok(
    lines.every((line) => measureCells(line) === width),
    `expected ${width} cells per row; got ${JSON.stringify(
      lines.map((line) => measureCells(line)),
    )}`,
  );
}

function intent(text: string) {
  return {
    text,
    fidelity: "verbatim" as const,
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

function completedTurn(options: {
  readonly id: string;
  readonly sessionId: string;
  readonly workstreamId: string;
  readonly request: string;
  readonly response?: string;
}): BarbaroTurnV1 {
  return {
    schema: "barbaro.turn.v1",
    turn_id: `turn_${options.id.repeat(32)}`,
    provider: "codex",
    session_id: options.sessionId,
    workstream_id: options.workstreamId,
    sequence: 1,
    agent_id: "root",
    started_at: "2026-08-22T12:00:00.000Z",
    ended_at: "2026-08-22T12:00:05.000Z",
    outcome: "success",
    request: intent(options.request),
    response: intent(options.response ?? `${options.request}-response`),
    actions: [],
    subagents: {
      total: 0,
      by_role: [],
      outcomes: {},
      changed_paths: [],
      evidence_refs: [],
    },
    evidence_refs: [],
    source_refs: [{ trace_id: `fixture:tui-cli:${options.id}` }],
  };
}

async function withOwnProperties<T>(
  target: object,
  properties: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(properties)) {
    previous.set(name, Object.getOwnPropertyDescriptor(target, name));
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  }
  try {
    return await run();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(target, name);
      } else {
        Object.defineProperty(target, name, descriptor);
      }
    }
  }
}

async function withNoColor<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const existed = Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR");
  const previous = process.env["NO_COLOR"];
  if (value === undefined) {
    delete process.env["NO_COLOR"];
  } else {
    process.env["NO_COLOR"] = value;
  }
  try {
    return await run();
  } finally {
    if (existed && previous !== undefined) {
      process.env["NO_COLOR"] = previous;
    } else {
      delete process.env["NO_COLOR"];
    }
  }
}

test("tui --once resolves workstream names and IDs and scopes the reader", async () => {
  await withProject(async (project) => {
    const workstreams = new WorkstreamStore(project);
    const lane = await workstreams.create({
      name: "tui-design",
      createdBy: { kind: "cli" },
    });
    const foreign = await workstreams.create({
      name: "release-track",
      createdBy: { kind: "cli" },
    });
    const active = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    await active.write(
      {
        lease_id: "lease_11111111111111111111111111111111",
        provider: "codex",
        session_id: "ses_11111111111111111111111111111111",
        workstream_id: lane.workstream_id,
        agent_id: "root",
        state: "working",
        intent: intent("selected-lane-intent"),
        claims: [],
        unknown_write_scope: false,
      },
      { ttlMs: 3_600_000 },
    );
    await active.write(
      {
        lease_id: "lease_22222222222222222222222222222222",
        provider: "claude",
        session_id: "ses_22222222222222222222222222222222",
        workstream_id: foreign.workstream_id,
        agent_id: "main",
        state: "working",
        intent: intent("foreign-track-intent"),
        claims: [],
        unknown_write_scope: false,
      },
      { ttlMs: 3_600_000 },
    );
    const feedDirectory = join(project, ".barbaro", "feed", "codex");
    await mkdir(feedDirectory, { recursive: true });
    await writeFile(
      join(
        feedDirectory,
        "ses_11111111111111111111111111111111.jsonl",
      ),
      stableJsonLine(
        completedTurn({
          id: "1",
          sessionId: "ses_11111111111111111111111111111111",
          workstreamId: lane.workstream_id,
          request: "selected-lane-turn",
        }),
      ),
      "utf8",
    );
    await writeFile(
      join(
        feedDirectory,
        "ses_22222222222222222222222222222222.jsonl",
      ),
      stableJsonLine(
        completedTurn({
          id: "2",
          sessionId: "ses_22222222222222222222222222222222",
          workstreamId: foreign.workstream_id,
          request: "foreign-track-turn",
        }),
      ),
      "utf8",
    );

    for (const reference of ["tui-design", lane.workstream_id]) {
      const rendered = await snapshot(project, ["--workstream", reference]);
      assert.match(rendered, /tui-design \u00b7 snapshot/u);
      // A working snapshot carries the same complete horse pose every time.
      for (const row of horseFrame(
        HORSE_STANDARD_FRAME_INDEX,
        "compact",
        "riderless",
      )) {
        assert.ok(rendered.includes(row));
      }
      assert.doesNotMatch(rendered, /F01|F04|F07|F10/u);
      assert.match(rendered, /Motion study · snapshot/u);
      assert.match(rendered, /codex\/11111111/u);
      assert.doesNotMatch(rendered, /claude\/22222222/u);
      assert.doesNotMatch(rendered, /\u001b/u);
      assertFrame(rendered, 64, 28);
    }
    // --no-motion keeps the same still and states the disabled motion policy.
    const still = await snapshot(project, [
      "--workstream",
      "tui-design",
      "--no-motion",
    ]);
    for (const row of horseFrame(
      HORSE_STANDARD_FRAME_INDEX,
      "compact",
      "riderless",
    )) {
      assert.ok(still.includes(row));
    }
    assert.match(still, /Motion study \u00b7 snapshot \u00b7 motion off/u);
    assert.equal(
      await snapshot(project, ["--workstream", "tui-design"]),
      await snapshot(project, ["--workstream", "tui-design"]),
    );
  });
});

test("idle tui --once uses the same response-first exposure ledger", async () => {
  await withProject(async (project) => {
    const workstream = await new WorkstreamStore(project).create({
      name: "response-ledger",
      createdBy: { kind: "cli" },
    });
    const sessionId = "ses_66666666666666666666666666666666";
    const feedDirectory = join(project, ".barbaro", "feed", "codex");
    await mkdir(feedDirectory, { recursive: true });
    await writeFile(
      join(feedDirectory, `${sessionId}.jsonl`),
      stableJsonLine(
        completedTurn({
          id: "6",
          sessionId,
          workstreamId: workstream.workstream_id,
          request: "the request should not become the preview",
          response: "CHECKPOINT 12: response preview is shared",
        }),
      ),
      "utf8",
    );

    const rendered = await snapshot(project, [
      "--workstream",
      workstream.workstream_id,
    ]);
    assert.match(
      rendered,
      /> #1\s+12:00\s+CHECKPOINT 12: response preview is shared/u,
    );
    assert.doesNotMatch(rendered, /the request should not become the preview/u);
    assert.doesNotMatch(rendered, /\[#1 succeeded\]|#1\s+Succeeded/u);
    assert.doesNotMatch(rendered, /\u001b/u);
    assertFrame(rendered, 64, 28);
  });
});

test("tui snapshots default to the Open view and directly support completed scope", async () => {
  await withProject(async (project) => {
    const workstreams = new WorkstreamStore(project);
    const first = await workstreams.create({
      name: "first-lane",
      createdBy: { kind: "cli" },
    });
    const second = await workstreams.create({
      name: "second-lane",
      createdBy: { kind: "cli" },
    });
    const active = new ActiveLeaseStore(join(project, ".barbaro", "active"));
    await active.write(
      {
        lease_id: "lease_33333333333333333333333333333333",
        provider: "codex",
        session_id: "ses_33333333333333333333333333333333",
        workstream_id: first.workstream_id,
        agent_id: "root",
        state: "working",
        intent: intent("first-project-intent"),
        claims: [],
        unknown_write_scope: false,
      },
      { ttlMs: 3_600_000 },
    );
    await active.write(
      {
        lease_id: "lease_44444444444444444444444444444444",
        provider: "claude",
        session_id: "ses_44444444444444444444444444444444",
        workstream_id: second.workstream_id,
        agent_id: "main",
        state: "waiting",
        intent: intent("second-project-intent"),
        claims: [],
        unknown_write_scope: false,
      },
      { ttlMs: 3_600_000 },
    );
    await workstreams.complete(second.workstream_id);

    for (const flags of [[], ["--all-workstreams"]] as const) {
      const rendered = await snapshot(project, flags);
      assert.match(rendered, /Home \u00b7 Open \u00b7 snapshot/u);
      assert.match(rendered, /first-lane/u);
      assert.doesNotMatch(rendered, /second-lane/u);
      assert.match(rendered, /Snapshot \u00b7 open workstreams/u);
      assertFrame(rendered, 64, 28);
    }

    const completed = await snapshot(project, [
      "--workstream",
      second.workstream_id,
    ]);
    assert.match(completed, /second-lane \u00b7 completed \u00b7 snapshot/u);
    assert.match(completed, /claude\/44444444/u);
    assertFrame(completed, 64, 28);
  });
});

test("tui rejects invalid scope and snapshot dimension combinations before output", async () => {
  await withProject(async (project) => {
    const unknownId = "ws_ffffffffffffffffffffffffffffffff";
    const invalid: readonly {
      readonly flags: readonly string[];
      readonly message: RegExp;
    }[] = [
      {
        flags: ["--workstream", "missing-lane"],
        message: /no workstream named "missing-lane"/u,
      },
      {
        flags: ["--workstream", unknownId],
        message: /no workstream named "ws_ffffffffffffffffffffffffffffffff"/u,
      },
      {
        flags: ["--workstream", "missing-lane", "--all-workstreams"],
        message: /--all-workstreams is mutually exclusive with --workstream/u,
      },
      {
        flags: ["--width", "80"],
        message: /--width and --height are only valid with --once/u,
      },
      {
        flags: ["--height", "24"],
        message: /--width and --height are only valid with --once/u,
      },
      {
        flags: ["--once", "--width", "0"],
        message: /--width must be a positive integer/u,
      },
      {
        flags: ["--once", "--height", "not-a-number"],
        message: /--height must be a positive integer/u,
      },
      {
        flags: ["--unknown"],
        message: /Unknown flag: --unknown/u,
      },
    ];

    for (const { flags, message } of invalid) {
      const captured = capture();
      await assert.rejects(
        main(["tui", "--project-root", project, ...flags], captured.io),
        message,
      );
      assert.deepEqual(captured.output, []);
      assert.deepEqual(captured.errors, []);
    }
  });
});

test("tui --once composes the §8 ladder at exactly the requested size", async () => {
  await withProject(async (project) => {
    const cases: readonly {
      readonly flags: readonly string[];
      readonly width: number;
      readonly height: number;
      readonly expect?: RegExp;
    }[] = [
      { flags: [], width: 64, height: 28 },
      { flags: ["--width", "100", "--height", "40"], width: 100, height: 40 },
      {
        flags: ["--width", "120", "--height", "24"],
        width: 120,
        height: 24,
      },
      { flags: ["--width", "40", "--height", "12"], width: 40, height: 12 },
      { flags: ["--width", "12", "--height", "6"], width: 12, height: 6 },
      {
        flags: ["--width", "10", "--height", "4"],
        width: 10,
        height: 4,
        expect: /10x4/u,
      },
    ];

    await withOwnProperties(
      process.stdout,
      { columns: 177, rows: 61 },
      async () => {
        for (const { flags, width, height, expect } of cases) {
          const rendered = await snapshot(project, flags);
          assertFrame(rendered, width, height);
          if (expect !== undefined) assert.match(rendered, expect);
        }
      },
    );
  });
});

test("wide tui snapshots center the same card in deterministic matte", async () => {
  await withProject(async (project) => {
    const flags = ["--width", "150", "--height", "40"] as const;
    const first = await snapshot(project, flags);
    const second = await snapshot(project, flags);

    assert.equal(second, first);
    assert.doesNotMatch(first, /\u001b/u);
    assertFrame(first, 150, 40);
    const lines = first.slice(0, -1).split("\n");
    // Matte above and below; the 64-cell card centered at column 44.
    assert.equal(lines[0], " ".repeat(150));
    assert.equal(lines[39], " ".repeat(150));
    assert.match(lines[6]!.slice(43, 107), /^Barbaro/u);
  });
});

test("tui --once is always plain, noninteractive, and accepts styling controls", async () => {
  await withProject(async (project) => {
    const rendered = await snapshot(project, ["--no-color", "--no-motion"]);
    assert.match(rendered, /Snapshot/u);
    assert.doesNotMatch(rendered, /q quit/u);
    assert.doesNotMatch(rendered, /\u001b\[/u);
  });
});

test("live tui refuses a non-TTY without emitting terminal control sequences", async () => {
  await withProject(async (project) => {
    const builtCli = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          builtCli,
          "tui",
          "--project-root",
          project,
          "--no-color",
          "--no-motion",
        ],
        {
          timeout: 10_000,
          // Isolate the non-TTY refusal from the independently tested
          // TERM=dumb refusal. CI and agent shells may inherit TERM=dumb.
          env: { ...process.env, TERM: "xterm-256color" },
        },
      ),
      (error: unknown) => {
        const failure = error as Error & {
          readonly code?: number;
          readonly stdout?: string;
          readonly stderr?: string;
        };
        assert.equal(failure.code, 1);
        assert.equal(failure.stdout, "");
        assert.equal(
          failure.stderr,
          "barbaro tui requires an interactive terminal; use --once for a plain snapshot\n",
        );
        assert.doesNotMatch(failure.stderr ?? "", /\u001b\[/u);
        return true;
      },
    );
  });
});

test("interactive tui keeps motion independent of color and refuses TERM=dumb", async () => {
  await withProject(async (project) => {
    const scenarios = [
      {
        label: "default",
        flags: [] as readonly string[],
        noColor: undefined,
        color: true,
        motion: true,
      },
      {
        label: "--no-color",
        flags: ["--no-color"],
        noColor: undefined,
        color: false,
        motion: true,
      },
      {
        label: "--no-motion",
        flags: ["--no-motion"],
        noColor: undefined,
        color: true,
        motion: false,
      },
      {
        label: "NO_COLOR",
        flags: [] as readonly string[],
        noColor: "1",
        color: false,
        motion: true,
      },
    ] as const;

    await withOwnProperties(process.stdin, { isTTY: true }, async () => {
      await withOwnProperties(process.stdout, { isTTY: true }, async () => {
        await withTerm("xterm-256color", async () => {
          for (const scenario of scenarios) {
            await withNoColor(scenario.noColor, async () => {
              const captured = capture();
              const calls: ComfortAppOptions[] = [];
              assert.equal(
                await main(
                  ["tui", "--project-root", project, ...scenario.flags],
                  captured.io,
                  async (options) => {
                    calls.push(options);
                    return 0;
                  },
                ),
                0,
                scenario.label,
              );
              assert.deepEqual(captured.output, [], scenario.label);
              assert.deepEqual(captured.errors, [], scenario.label);
              assert.equal(calls.length, 1, scenario.label);
              // NO_COLOR and --no-color disable styling only (gate 19); the
              // motion switch is --no-motion alone.
              assert.equal(calls[0]!.color, scenario.color, scenario.label);
              assert.equal(calls[0]!.motion, scenario.motion, scenario.label);
              assert.equal(calls[0]!.projectRoot, project, scenario.label);
              assert.equal(calls[0]!.term, "xterm-256color", scenario.label);
            });
          }
        });

        // TERM is refused before terminal ownership: the launcher is never
        // reached and stderr carries the exact truthful lines.
        await withTerm("dumb", async () => {
          const captured = capture();
          const calls: ComfortAppOptions[] = [];
          assert.equal(
            await main(
              ["tui", "--project-root", project],
              captured.io,
              async (options) => {
                calls.push(options);
                return 0;
              },
            ),
            2,
          );
          assert.deepEqual(calls, []);
          assert.deepEqual(captured.errors, [
            "barbaro tui: TERM=dumb cannot support interactive mode.\n",
            "Use: barbaro tui --once [--width N --height N]\n",
            "No alternate-screen, cursor, raw-mode, color, or animation bytes were emitted.\n",
          ]);
          for (const line of captured.errors) {
            assert.doesNotMatch(line, /\u001b/u);
          }
        });
      });
    });
  });
});

async function withTerm<T>(
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const existed = Object.prototype.hasOwnProperty.call(process.env, "TERM");
  const previous = process.env["TERM"];
  if (value === undefined) {
    delete process.env["TERM"];
  } else {
    process.env["TERM"] = value;
  }
  try {
    return await run();
  } finally {
    if (existed && previous !== undefined) {
      process.env["TERM"] = previous;
    } else {
      delete process.env["TERM"];
    }
  }
}

test("help documents TUI scope, display, motion, and snapshot flags", async () => {
  const captured = capture();
  assert.equal(await main(["tui", "--help"], captured.io), 0);
  assert.deepEqual(captured.errors, []);
  const help = captured.output.join("");
  assert.match(help, /--workstream <name\|ws_id> \| --all-workstreams/u);
  assert.match(help, /--no-color/u);
  assert.match(help, /--no-motion/u);
  assert.match(help, /--once \[--width <n>\] \[--height <n>\]/u);
  assert.match(help, /bounded control panel; --once is read-only/u);
  assert.match(help, /q\/Ctrl-C quit, r refresh, j\/k or/u);
  assert.match(help, /Up\/Down move, Enter detail, Esc back/u);
  assert.match(help, /\/ Open\/Completed, n new, x complete\/reopen/u);
  assert.match(help, /interactive writes use only the public/u);
  assert.match(help, /workstream new\/complete\/reopen commands/u);
  assert.match(help, /defaults to project scope and Home \u00b7 Open/u);
  assert.match(help, /exact 64x28 card/u);
  assert.match(help, /true-size notice/u);
});

test("usage guide documents the comfort TUI, create flow, and snapshot contract", async () => {
  const guide = await readFile(
    fileURLToPath(new URL("../../../docs/usage.md", import.meta.url)),
    "utf8",
  );
  for (const option of [
    "--project-root",
    "--interval-ms",
    "--byte-budget",
    "--turns-per-session",
    "--workstream",
    "--all-workstreams",
    "--no-color",
    "--no-motion",
    "--once",
    "--width",
    "--height",
    "NO_COLOR",
  ]) {
    assert.ok(guide.includes(option), `usage guide must document ${option}`);
  }
  assert.match(guide, /centers one fixed comfort card/u);
  assert.match(guide, /With no scope flag the\s+TUI reads the project catalogue/u);
  assert.match(guide, /opens on `Home \u00b7 Open`/u);
  assert.match(guide, /`j`\/`k` or the arrow keys select a workstream/u);
  assert.match(guide, /`\/` switches between Open and Completed/u);
  assert.match(guide, /`n` opens the create form/u);
  assert.match(guide, /`x` completes an open workstream or reopens/u);
  assert.match(guide, /Ctrl-S\s+creates/u);
  assert.match(guide, /`c` performs Punch Out/u);
  assert.match(guide, /Punch Out does not\s+run the join command/u);
  assert.match(guide, /`q` or Ctrl-C exits/u);
  assert.match(guide, /bare snapshot is exactly 64×28/u);
  assert.match(guide, /below the 12×6 floor receives a true-size notice/u);
  assert.match(guide, /refuses `TERM=dumb` or an unset `TERM`/u);
  assert.match(guide, /interactive TUI changes project state only after an\s+explicit create submission or complete\/reopen confirmation/u);
  assert.match(guide, /Working, Waiting, and Blocked counts/u);
  assert.match(guide, /same full horse on one fixed,\s+representative pose/u);
  assert.match(guide, /prioritizes recent completed\s+responses/u);
  assert.match(guide, /highlights the selected session's completed-turn and detail\s+rows/u);
  assert.match(guide, /Enter confirms\s+and Escape refuses/u);
  assert.match(guide, /Home \u00b7 Open \u00b7 snapshot/u);
});
