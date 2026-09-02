import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { analyzeHookCommand } from "../../src/setup/hooks.js";

const TEMPLATES = [
  { file: "examples/claude-hooks.json", provider: "claude" as const },
  { file: "examples/codex-hooks.json", provider: "codex" as const },
];

/** Every `command` string anywhere in a hook template, in document order. */
function templateCommands(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) templateCommands(item, into);
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.command === "string") into.push(record.command);
    for (const nested of Object.values(record)) templateCommands(nested, into);
  }
  return into;
}

/** The documented workflow: replace the placeholder in the JSON text. */
function renderTemplate(text: string, pastedPath: string): unknown {
  return JSON.parse(text.replaceAll("BARBARO_BIN", pastedPath));
}

/** What INSTALL.md asks for: the path escaped only as JSON requires. */
function jsonEscaped(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("hook templates single-quote the binary so a hostile install path runs literally", async () => {
  // The directory name carries spaces, a command substitution, backticks,
  // double quotes, a literal backslash sequence that JSON would decode into
  // a single quote if pasted raw, and a variable reference.
  const root = await mkdtemp(join(tmpdir(), "barbaro hook templates "));
  // The marker lives under a space-free path so a substituted `touch` would
  // receive it as one argument if the shell ever ran it.
  const plain = await mkdtemp(join(tmpdir(), "barbaro-hook-marker-"));
  try {
    const marker = join(plain, "expanded");
    const bin = join(
      root,
      `My $(touch ${marker}) \`tools\` "q" \\u0027 $HOME`,
      "barbaro",
    );
    const log = join(root, "calls.log");
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\ncat >/dev/null\nexit 0\n`,
      "utf8",
    );
    await chmod(bin, 0o755);

    const seen = new Set<string>();
    for (const { file, provider } of TEMPLATES) {
      const text = await readFile(file, "utf8");
      const placeholders = templateCommands(JSON.parse(text));
      assert.ok(placeholders.length > 0, file);
      for (const command of placeholders) {
        assert.match(
          command,
          /^'BARBARO_BIN' (?:claude|codex) hook(?:-ingest)?$/u,
          `${file}: ${command}`,
        );
      }
      const rendered = templateCommands(renderTemplate(text, jsonEscaped(bin)));
      assert.equal(rendered.length, placeholders.length);
      for (const command of rendered) {
        const analysis = analyzeHookCommand("UserPromptSubmit", command, provider);
        assert.equal(analysis.cliToken, bin, command);
        assert.equal(analysis.interpreterToken, undefined, command);
        assert.ok(analysis.subcommand?.startsWith(`${provider} hook`), command);
        execFileSync("sh", ["-c", command], { input: "{}", stdio: ["pipe", "pipe", "pipe"] });
        seen.add(command.slice(command.lastIndexOf("' ") + 2));
      }
    }
    assert.equal(await exists(marker), false, "the path must never be expanded");
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(new Set(calls), seen);
    assert.deepEqual(
      [...seen].sort(),
      ["claude hook", "claude hook-ingest", "codex hook", "codex hook-ingest"],
    );

    // Pasting the path raw instead of JSON-escaped is the documented mistake:
    // here JSON decodes `'` into a quote that ends the single-quoted
    // token early. Nothing prevents the hook runner from executing such a
    // command; what this shows is that the optional setup doctor would see a
    // CLI token that is not the binary and report the hook as unresolved.
    const text = await readFile(TEMPLATES[0]!.file, "utf8");
    const rawPath = join(root, "raw \\u0027 paste", "barbaro");
    const mispasted = templateCommands(renderTemplate(text, rawPath));
    for (const command of mispasted) {
      assert.match(command, /'/u);
      const analysis = analyzeHookCommand("UserPromptSubmit", command, "claude");
      assert.notEqual(analysis.cliToken, rawPath, command);
    }

    // The double-quoted form the templates used to ship expands the path.
    assert.throws(() =>
      execFileSync("sh", ["-c", `"${bin}" claude hook`], {
        input: "{}",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    assert.equal(await exists(marker), true, "double quotes let $(...) run");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});
