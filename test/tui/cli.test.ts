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
import type { TuiOptions } from "../../src/tui/app.js";
import { dashboardBrandingRows } from "../../src/tui/branding.js";
import {
  DASHBOARD_MIN_HEIGHT,
  DASHBOARD_MIN_WIDTH,
} from "../../src/tui/render.js";
import { terminalCellWidth } from "../../src/tui/terminal-text.js";
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
    lines.every((line) => terminalCellWidth(line) === width),
    `expected ${width} cells per row; got ${JSON.stringify(
      lines.map((line) => terminalCellWidth(line)),
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
    response: intent(`${options.request}-response`),
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
      assert.ok(
        rendered.includes(
          `Scope tui-design (${shortWorkstreamId(lane.workstream_id)})`,
        ),
      );
      assert.match(rendered, /selected-lane-intent/u);
      assert.match(rendered, /selected-lane-turn/u);
      assert.doesNotMatch(rendered, /foreign-track-intent/u);
      assert.doesNotMatch(rendered, /foreign-track-turn/u);
    }
  });
});

test("tui defaults to the whole project and --all-workstreams is explicit", async () => {
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

    for (const flags of [[], ["--all-workstreams"]] as const) {
      const rendered = await snapshot(project, flags);
      assert.match(rendered, /Scope whole project/u);
      assert.match(rendered, /first-project-intent/u);
      assert.match(rendered, /second-project-intent/u);
    }
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
        flags: ["--once", "--width", "1"],
        message: /--width must be at least 12/u,
      },
      {
        flags: [
          "--once",
          "--width",
          String(DASHBOARD_MIN_WIDTH - 1),
          "--workstream",
          "missing-lane",
        ],
        message: /--width must be at least 12/u,
      },
      {
        flags: ["--once", "--height", "1"],
        message: /--height must be at least 6/u,
      },
      {
        flags: [
          "--once",
          "--height",
          String(DASHBOARD_MIN_HEIGHT - 1),
        ],
        message: /--height must be at least 6/u,
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

test("tui --once dimensions have independent 100x30 fallbacks", async () => {
  await withProject(async (project) => {
    const cases: readonly {
      readonly flags: readonly string[];
      readonly width: number;
      readonly height: number;
    }[] = [
      { flags: [], width: 100, height: 30 },
      { flags: ["--width", "73"], width: 73, height: 30 },
      { flags: ["--height", "18"], width: 100, height: 18 },
      {
        flags: ["--width", "84", "--height", "21"],
        width: 84,
        height: 21,
      },
      {
        flags: [
          "--width",
          String(DASHBOARD_MIN_WIDTH),
          "--height",
          String(DASHBOARD_MIN_HEIGHT),
        ],
        width: DASHBOARD_MIN_WIDTH,
        height: DASHBOARD_MIN_HEIGHT,
      },
    ];

    await withOwnProperties(
      process.stdout,
      { columns: 177, rows: 61 },
      async () => {
        for (const { flags, width, height } of cases) {
          assertFrame(await snapshot(project, flags), width, height);
        }
      },
    );
  });
});

test("wide tui snapshots are deterministic plain frame-zero renders", async () => {
  await withProject(async (project) => {
    const flags = ["--width", "150", "--height", "28"] as const;
    const first = await snapshot(project, flags);
    const second = await snapshot(project, flags);

    assert.equal(second, first);
    assert.match(first, /BARBARO · STATIC/u);
    assert.doesNotMatch(first, /\u001b\[/u);
    assert.ok(
      dashboardBrandingRows(0)
        .filter((row) => row.trim().length > 0)
        .every((row) => first.includes(row)),
      "snapshot must render the exact static riderless frame zero",
    );
    assertFrame(first, 150, 28);
  });
});

test("tui --once is always plain, noninteractive, and accepts styling controls", async () => {
  await withProject(async (project) => {
    const rendered = await snapshot(project, ["--no-color", "--no-motion"]);
    assert.match(rendered, /snapshot/u);
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
        { timeout: 10_000 },
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

test("live tui translates --no-color, --no-motion, and NO_COLOR coherently", async () => {
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
        motion: false,
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
        motion: false,
      },
    ] as const;

    await withOwnProperties(process.stdin, { isTTY: true }, async () => {
      await withOwnProperties(process.stdout, { isTTY: true }, async () => {
        for (const scenario of scenarios) {
          await withNoColor(scenario.noColor, async () => {
            const captured = capture();
            const calls: TuiOptions[] = [];
            assert.equal(
              await main(
                ["tui", "--project-root", project, ...scenario.flags],
                captured.io,
                async (options) => {
                  calls.push(options);
                },
              ),
              0,
              scenario.label,
            );
            assert.deepEqual(captured.output, [], scenario.label);
            assert.deepEqual(captured.errors, [], scenario.label);
            assert.equal(calls.length, 1, scenario.label);
            assert.equal(calls[0]!.color, scenario.color, scenario.label);
            assert.equal(calls[0]!.motion, scenario.motion, scenario.label);
          });
        }
      });
    });
  });
});

test("help documents TUI scope, display, motion, and snapshot flags", async () => {
  const captured = capture();
  assert.equal(await main(["tui", "--help"], captured.io), 0);
  assert.deepEqual(captured.errors, []);
  const help = captured.output.join("");
  assert.match(help, /--workstream <name\|ws_id> \| --all-workstreams/u);
  assert.match(help, /--no-color/u);
  assert.match(help, /--no-motion/u);
  assert.match(help, /--once \[--width <n>\] \[--height <n>\]/u);
  assert.match(help, /read-only, bounded control panel/u);
  assert.match(help, /q\/Ctrl-C quit, r refresh; Left\/Right or/u);
  assert.match(help, /Tab\/Shift-Tab switch panes; Up\/Down or j\/k/u);
  assert.match(help, /move; Enter detail, Esc back/u);
  assert.match(help, /defaults to whole project/u);
  assert.match(help, /least 12x6 and otherwise default to 100x30/u);
});

test("README documents the complete TUI scope, input, and snapshot contract", async () => {
  const readme = await readFile(
    fileURLToPath(new URL("../../../README.md", import.meta.url)),
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
    assert.ok(readme.includes(option), `README must document ${option}`);
  }
  assert.match(readme, /With no scope flag it shows and labels\s+the whole project/u);
  assert.match(readme, /name and short ID/u);
  assert.match(readme, /Left\/Right or `Tab`\/Shift-Tab to switch/u);
  assert.match(readme, /Up\/Down or `j`\/`k` to move the selection/u);
  assert.match(readme, /`q` or Ctrl-C to exit/u);
  assert.match(readme, /widths must be at least 12 columns/u);
  assert.match(readme, /heights at\s+least 6 rows/u);
  assert.match(readme, /default independently to 100 and 30/u);
});
