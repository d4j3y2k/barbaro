import { spawn } from "node:child_process";
import { Diagnostic, facts } from "./types.js";

/** Ask Git for its effective rules, including global/info/exclude and negations. */
export async function checkEffectiveIgnore(projectRoot: string, env: Readonly<Record<string, string | undefined>>): Promise<Diagnostic> {
  const result = await git(projectRoot, ["check-ignore", "--no-index", "-z", "-v", "--non-matching", "--stdin"], ".barbaro/\0", env);
  const parts = result.stdout.split("\0");
  const matched = parts.length === 5 && parts[3] === ".barbaro/" && parts[2] !== "" && !parts[2]!.startsWith("!");
  const tracked = await git(projectRoot, ["ls-files", "-z", "--", ".barbaro"], "", env);
  const known = [0, 1].includes(result.code) && parts.length === 5 && tracked.code === 0;
  const ignored = known && matched && tracked.stdout.length === 0;
  return {
    id: "store.ignore", title: "Effective Git ignore coverage", status: ignored ? "pass" : "warn",
    summary: ignored ? "Git ignores the entire .barbaro directory and tracks no store files." : known ? "The store directory is not fully ignored, or store files are already tracked." : "Effective Git ignore coverage is unverified (not a Git checkout, Git unavailable, or bounded query refused).",
    facts: facts({ checked_path: ".barbaro/", method: "git_check_ignore", covered: ignored,
      ...(known ? { rule_source: parts[0], rule_line: parts[1], tracked_store_files: tracked.stdout.length > 0 } : {}) }),
    remediation: ignored ? [] : ["Ignore .barbaro/ at the repository root, then check for already tracked store files. Doctor does not edit rules or the index."],
  };
}

function git(cwd: string, args: string[], input: string, environment: Readonly<Record<string, string | undefined>>): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && !key.startsWith("GIT_"))) as Record<string, string>;
    const child = spawn("/usr/bin/git", ["-c", "core.fsmonitor=false", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let bytes = 0; let exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill(); }, 3000);
    const done = (code: number) => { clearTimeout(timer); resolve({ code: exceeded ? -1 : code, stdout: exceeded ? "" : stdout }); };
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 131072) { exceeded = true; child.kill(); } else stdout += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? -1));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
