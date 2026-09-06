import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readDiagnosticBytes } from "./diagnostic-files.js";
import type { HookProvider } from "./hooks.js";

export async function inspectEffectiveSkills(projectRoot: string, provider: HookProvider, packageRoots: readonly string[], env: Readonly<Record<string, string | undefined>>) {
  const home = env["HOME"] ?? homedir();
  const user = provider === "codex" ? join(home, ".agents/skills") : join(resolve(env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude")), "skills");
  const relative = provider === "codex" ? ".agents/skills" : ".claude/skills";
  const result = [];
  for (const name of provider === "codex" ? ["barbaro"] : ["barbaro", "barbaro-watch"]) {
    const references = [];
    for (const root of packageRoots.slice(0, 8)) {
      const path = join(root, relative, name, "SKILL.md");
      const read = await readDiagnosticBytes(path, 256 * 1024);
      references.push({ path, state: read.state, ...(read.state === "ok" ? { sha256: read.identity.sha256 } : {}) });
    }
    const copies = [];
    for (const [scope, directory] of [["user", user], ["project", join(projectRoot, relative)]] as const) {
      const path = join(directory, name, "SKILL.md");
      const read = await readDiagnosticBytes(path, 256 * 1024);
      copies.push({ scope, path, state: read.state, ...(read.state === "ok" ? { sha256: read.identity.sha256 } : {}) });
    }
    const present = copies.filter((copy) => copy.state === "ok");
    const effective = present.at(-1);
    const uncertain = copies.some((copy) => !["ok", "missing"].includes(copy.state)) || references.some((copy) => copy.state !== "ok") || references.length === 0 || packageRoots.length > 8;
    const hashes = new Set(references.map((copy) => copy.sha256));
    const mismatch = hashes.size > 1 || present.some((copy) => !hashes.has(copy.sha256));
    result.push({ name, state: effective === undefined ? "missing" : uncertain ? "unverified" : mismatch ? "mismatch" : "matching",
      ...(effective === undefined ? {} : { selected_path: effective.path }), copies, references,
      selection: "project_before_user; launch, plugin and administrator overrides require live provider confirmation" });
  }
  return result;
}
