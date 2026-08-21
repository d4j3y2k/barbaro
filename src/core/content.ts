import { relative, resolve, sep } from "node:path";

import type { BarbaroContent } from "../contracts/v1.js";
import { compareUtf16CodeUnits } from "./stable-json.js";

/**
 * Provider-neutral derived-content helpers.
 *
 * Every function here copies text *out of* a provider trace into a Barbaro
 * record. The trace itself is never modified; callers retain a source_ref so
 * the untouched original stays reachable. Any alteration made while copying is
 * declared on the returned BarbaroContent.
 */

export function verbatimContent(text: string): BarbaroContent {
  return {
    text,
    fidelity: "verbatim",
    truncated: false,
    original_utf8_bytes: Buffer.byteLength(text, "utf8"),
    redactions: [],
  };
}

/**
 * Copy text that was derived from, but is not byte-identical to, the source —
 * for example after stripping harness-injected wrappers.
 */
export function normalizedContent(
  text: string,
  originalUtf8Bytes: number,
  maxUtf8Bytes?: number,
): BarbaroContent {
  if (
    originalUtf8Bytes !== undefined &&
    (!Number.isSafeInteger(originalUtf8Bytes) || originalUtf8Bytes < 0)
  ) {
    throw new RangeError("originalUtf8Bytes must be a non-negative safe integer");
  }
  if (maxUtf8Bytes === undefined) {
    return {
      text,
      fidelity: "normalized",
      truncated: false,
      original_utf8_bytes: originalUtf8Bytes,
      redactions: [],
    };
  }
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new RangeError("maxUtf8Bytes must be a non-negative safe integer");
  }
  const copiedBytes = Buffer.byteLength(text, "utf8");
  if (copiedBytes <= maxUtf8Bytes) {
    return {
      text,
      fidelity: "normalized",
      truncated: false,
      original_utf8_bytes: originalUtf8Bytes,
      redactions: [],
    };
  }
  return {
    text: truncateUtf8(text, maxUtf8Bytes),
    fidelity: "normalized",
    truncated: true,
    original_utf8_bytes: originalUtf8Bytes,
    redactions: [],
  };
}

export function excerptContent(
  text: string,
  maxUtf8Bytes: number,
): BarbaroContent {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new RangeError("maxUtf8Bytes must be a non-negative safe integer");
  }
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxUtf8Bytes) {
    return {
      text,
      fidelity: "excerpt",
      truncated: false,
      original_utf8_bytes: originalBytes,
      redactions: [],
    };
  }

  const excerpt = truncateUtf8(text, maxUtf8Bytes);
  return {
    text: excerpt,
    fidelity: "excerpt",
    truncated: true,
    original_utf8_bytes: originalBytes,
    redactions: [],
  };
}

/**
 * Copy a bounded failure excerpt while scrubbing a deliberately small,
 * deterministic set of high-confidence credential shapes. The source trace is
 * never changed; callers retain its source_ref.
 */
export function redactedExcerptContent(
  text: string,
  maxUtf8Bytes: number,
): BarbaroContent {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new RangeError("maxUtf8Bytes must be a non-negative safe integer");
  }
  const originalBytes = Buffer.byteLength(text, "utf8");
  const counts = new Map<string, number>();
  let redacted = text;
  const replace = (
    pattern: RegExp,
    kind: string,
    replacement: string | ((match: string, ...groups: string[]) => string),
  ) => {
    redacted = redacted.replace(pattern, (...args: unknown[]) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      if (typeof replacement === "string") return replacement;
      const [match, ...rest] = args;
      // String.replace appends offset and input after capture groups.
      return replacement(String(match), ...rest.slice(0, -2).map(String));
    });
  };

  replace(
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
    "private_key",
    "[REDACTED PRIVATE KEY]",
  );
  replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    "bearer_token",
    (_match, prefix) => `${prefix}[REDACTED]`,
  );
  replace(
    /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)(\s*[:=]\s*)(["']?)([^\s"',;}\]]+)(["']?)/gi,
    "credential_assignment",
    (_match, name, separator, quote) => `${name}${separator}${quote}[REDACTED]${quote}`,
  );
  replace(
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g,
    "credential_token",
    "[REDACTED TOKEN]",
  );

  const copied = truncateUtf8(redacted, maxUtf8Bytes);
  return {
    text: copied,
    fidelity: counts.size > 0 ? "redacted" : "excerpt",
    truncated: Buffer.byteLength(redacted, "utf8") > maxUtf8Bytes,
    original_utf8_bytes: originalBytes,
    redactions: [...counts.entries()]
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([kind, count]) => ({ kind, count })),
  };
}

/** Return a workspace-relative POSIX path, or undefined for outside/unsafe paths. */
export function normalizeRepoPath(
  workspaceRoot: string | undefined,
  candidate: string,
): string | undefined {
  if (!workspaceRoot) return undefined;
  // The wire contract is POSIX and rejects backslashes, Windows drive paths,
  // traversal, and NUL. On POSIX those spellings are otherwise ordinary file
  // names, so host-native `path.resolve` alone would incorrectly let them
  // through and the runtime would emit a schema-invalid record.
  if (
    candidate.includes("\0") ||
    (sep !== "\\" &&
      (candidate.includes("\\") || /^[A-Za-z]:\//u.test(candidate)))
  ) {
    return undefined;
  }
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
    return undefined;
  }
  const normalized = rel.split(sep).join("/");
  if (
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    /^(?:\/|[A-Za-z]:\/)/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}

export function isGeneratedBarbaroPath(path: string): boolean {
  return (
    path === ".barbaro/feed" ||
    path.startsWith(".barbaro/feed/") ||
    path === ".barbaro/evidence" ||
    path.startsWith(".barbaro/evidence/") ||
    path === ".barbaro/active" ||
    path.startsWith(".barbaro/active/")
  );
}

export function truncateUtf8(value: string, maxUtf8Bytes: number): string {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxUtf8Bytes) break;
    result += character;
    bytes += width;
  }
  return result;
}
