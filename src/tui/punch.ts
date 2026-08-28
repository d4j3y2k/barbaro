import { execFile } from "node:child_process";

import { utf8Bytes } from "../reader/budget.js";

export const MAX_PUNCH_BYTES = 8 * 1024;
const HELPER_TIMEOUT_MS = 2_000;

/**
 * Punch Out (§5.1): an explicit local clipboard side effect for immutable
 * canonical strings. OSC 52 has no portable acknowledgement, so a terminal
 * write alone is only `sent_unconfirmed`; only the platform helper's exit 0
 * after stdin closes is `reported_success`. Every other path stays honest:
 * unconfirmed or unavailable, with the raw string left for manual copy.
 * Nothing here reads or mutates the store, logs, or persists the payload.
 */

export type PunchOutcome =
  | { readonly kind: "reported_success"; readonly value: string }
  | { readonly kind: "sent_unconfirmed"; readonly value: string }
  | { readonly kind: "unavailable"; readonly value: string }
  | { readonly kind: "refused"; readonly reason: string };

export type HelperResult = "ok" | "failed" | "missing";

export interface PunchTransports {
  /** Writes the OSC 52 sequence to the owning terminal; absent when none. */
  readonly oscWrite?: (sequence: string) => void;
  /** Confirmation-capable platform helper; resolves how it ended. */
  readonly runHelper?: (payload: string) => Promise<HelperResult>;
}

/** A payload must be exact, single-line, control-free, and bounded. */
export function refusePunchPayload(value: string): string | undefined {
  if (value.length === 0) return "the payload is empty";
  if (utf8Bytes(value) > MAX_PUNCH_BYTES) {
    return "the payload is larger than 8 KiB";
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x200b ||
      code === 0x200c ||
      code === 0x200d ||
      (code >= 0x200e && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return "the payload contains control or format characters";
    }
  }
  return undefined;
}

export function osc52Sequence(value: string): string {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  return `\u001b]52;c;${encoded}\u001b\\`;
}

export async function punchOut(
  value: string,
  transports: PunchTransports,
): Promise<PunchOutcome> {
  const refusal = refusePunchPayload(value);
  if (refusal !== undefined) return { kind: "refused", reason: refusal };

  let oscSent = false;
  if (transports.oscWrite !== undefined) {
    transports.oscWrite(osc52Sequence(value));
    oscSent = true;
  }
  if (transports.runHelper !== undefined) {
    const helper = await transports.runHelper(value);
    if (helper === "ok") return { kind: "reported_success", value };
    if (helper === "failed" && oscSent) {
      return { kind: "sent_unconfirmed", value };
    }
    if (helper === "failed") return { kind: "unavailable", value };
    // missing: fall through to what the OSC write alone can honestly claim.
  }
  return oscSent
    ? { kind: "sent_unconfirmed", value }
    : { kind: "unavailable", value };
}

/**
 * The macOS helper: fixed argv, exact bytes on stdin, no shell, no appended
 * newline, and a bounded wait. A missing binary degrades honestly instead
 * of erroring — the spec's promise holds on every platform.
 */
export function pbcopyHelper(): (payload: string) => Promise<HelperResult> {
  return (payload) =>
    new Promise((resolveHelper) => {
      let child: ReturnType<typeof execFile>;
      try {
        child = execFile(
          "/usr/bin/pbcopy",
          [],
          { timeout: HELPER_TIMEOUT_MS },
          (error) => {
            if (error === null) resolveHelper("ok");
            else if (
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              resolveHelper("missing");
            } else resolveHelper("failed");
          },
        );
      } catch {
        resolveHelper("missing");
        return;
      }
      child.stdin?.end(Buffer.from(payload, "utf8"));
    });
}
