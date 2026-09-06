import { dirname, join, resolve } from "node:path";
import { readDiagnosticBytes, readDiagnosticJson, type DiagnosticFileIdentity } from "./diagnostic-files.js";
import { walkFiles } from "./fs-facts.js";

export interface DoctorRuntimeIdentity {
  readonly cli_path: string;
  readonly state: "verified" | "unverified" | "mismatch" | "unavailable";
  readonly cli?: DiagnosticFileIdentity;
  readonly package_root?: string;
  readonly package_version?: string;
  readonly build_version?: string;
  readonly build_identity_sha256?: string;
  readonly build_files?: number;
  readonly reason?: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function version(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value);
}

/** Check all JS files against the build-time version and hashes, never execute. */
export async function inspectRuntimeIdentity(cliPath: string): Promise<DoctorRuntimeIdentity> {
  const path = resolve(cliPath);
  const read = await readDiagnosticBytes(path, 8 * 1024 * 1024);
  if (read.state !== "ok") return { cli_path: path, state: "unavailable", reason: read.state };
  const cli = read.identity;
  const directory = dirname(cli.real_path);
  // The packaged public CLI is dist/src/cli.js and reads this same manifest.
  const packageRoot = resolve(directory, "../..");
  const manifestRead = await readDiagnosticJson(join(packageRoot, "package.json"), 1024 * 1024);
  const manifest = manifestRead.state === "ok" ? object(manifestRead.value) : undefined;
  if (manifest?.["name"] !== "barbaro" || !version(manifest["version"])) {
    return { cli_path: path, cli, state: "unverified", reason: "barbaro_package_manifest_unavailable" };
  }
  const base = { cli_path: path, cli, package_root: packageRoot, package_version: manifest["version"] };
  const identityRead = await readDiagnosticJson(join(directory, "build-identity.json"), 256 * 1024);
  if (identityRead.state !== "ok") return { ...base, state: "unverified", reason: `build_identity_${identityRead.state}` };
  const identity = object(identityRead.value);
  const files = object(identity?.["files"]);
  if (identity?.["schema"] !== "barbaro.build.v1" || !version(identity["package_version"]) || files === undefined ||
      Object.keys(identity).sort().join(",") !== "files,package_version,schema") {
    return { ...base, state: "unverified", reason: "build_identity_invalid" };
  }
  const build = { ...base, build_version: identity["package_version"], build_identity_sha256: identityRead.identity.sha256, build_files: Object.keys(files).length };
  if (build.build_version !== build.package_version) return { ...build, state: "mismatch", reason: "package_build_version_mismatch" };
  if (build.build_files < 1 || build.build_files > 1024) return { ...build, state: "unverified", reason: "build_identity_file_limit" };
  if (files["cli.js"] !== cli.sha256) return { ...build, state: "mismatch", reason: "cli_hash_mismatch" };
  const listed = await walkFiles(directory, { limits: { maxEntries: 4096, maxDepth: 16 }, include: (file) => file.endsWith(".js") });
  if (listed === undefined || listed.truncated) return { ...build, state: "unverified", reason: "build_scan_incomplete" };
  if (listed.files.map((file) => file.relativePath).sort().join("\n") !== Object.keys(files).sort().join("\n")) {
    return { ...build, state: "mismatch", reason: "build_file_set_mismatch" };
  }
  let bytes = 0;
  for (const [relative, hash] of Object.entries(files)) {
    if (!/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/u.test(relative) || relative.split("/").some((part) => part === "..") ||
        typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
      return { ...build, state: "unverified", reason: "build_identity_invalid_path_or_hash" };
    }
    const file = await readDiagnosticBytes(join(directory, relative), 8 * 1024 * 1024);
    if (file.state !== "ok") return { ...build, state: "unavailable", reason: `build_file_${file.state}` };
    if (file.identity.sha256 !== hash) return { ...build, state: "mismatch", reason: "build_file_hash_mismatch" };
    bytes += file.bytes.length;
    if (bytes > 64 * 1024 * 1024) return { ...build, state: "unverified", reason: "build_total_byte_limit" };
  }
  return { ...build, state: "verified" };
}
