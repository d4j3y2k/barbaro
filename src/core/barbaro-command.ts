export const DEFAULT_AWAIT_TIMEOUT_MS = 600_000;
export const MAX_AWAIT_TIMEOUT_MS = 3_600_000;
export const AWAIT_LEASE_GRACE_MS = 60_000;

export interface AwaitCommandClassification {
  /** Timeout used for lease lifetime purposes, capped at the CLI maximum. */
  readonly timeoutMs: number;
  /** Long enough for the wait and its bounded completion grace. */
  readonly leaseTtlMs: number;
}

/**
 * Generated Barbaro reads are bookkeeping, not work performed by the agent.
 * Suppress them from digests only when the entire shell command is one simple
 * invocation. The check is intentionally conservative: shell composition,
 * redirection, command substitution, or a newline keeps the action visible.
 */
export function isDigestExcludedBarbaroCommand(command: string): boolean {
  if (hasDigestUnsafeShellSyntax(command)) return false;

  const scanned = leadingSimpleCommandTokens(command);
  if (!scanned.valid || !scanned.consumedAll) return false;
  const { tokens } = scanned;
  if (tokens[0] !== "barbaro") return false;
  if (tokens[1] === "read") {
    return tokens[2] === "context" || (tokens[2] === "turn" && tokens[3] === "show");
  }
  if (tokens[1] === "await" || tokens[1] === "context") return true;
  if (tokens[1] === "turn") {
    return tokens[2] === "list" || tokens[2] === "show";
  }
  return tokens[1] === "evidence" && tokens[2] === "show";
}

/**
 * Recognize the exact leading shell tokens `barbaro await` without expanding
 * or executing any part of the command. Later chained commands do not affect
 * recognition or timeout parsing: they run only after the await completes.
 */
export function classifyAwaitCommand(
  command: string,
): AwaitCommandClassification | undefined {
  const scanned = leadingSimpleCommandTokens(command);
  if (!scanned.valid) return undefined;
  const { tokens } = scanned;
  if (tokens[0] !== "barbaro" || tokens[1] !== "await") return undefined;

  const timeoutMs = awaitTimeoutFromTokens(tokens);
  return {
    timeoutMs,
    leaseTtlMs: timeoutMs + AWAIT_LEASE_GRACE_MS,
  };
}

/**
 * Recognize a leading `barbaro context` simple command without evaluating the
 * shell. A following pipe or other control operator is deliberately allowed:
 * the context command still ran, even when its output is subsequently shaped.
 */
export function isLeadingBarbaroContextCommand(command: string): boolean {
  const scanned = leadingSimpleCommandTokens(command);
  return (
    scanned.valid &&
    scanned.tokens[0] === "barbaro" &&
    scanned.tokens[1] === "context"
  );
}

function awaitTimeoutFromTokens(tokens: readonly string[]): number {
  const timeoutIndexes: number[] = [];
  for (let index = 2; index < tokens.length; index += 1) {
    if (tokens[index] === "--timeout-ms") timeoutIndexes.push(index);
  }
  if (timeoutIndexes.length !== 1) return DEFAULT_AWAIT_TIMEOUT_MS;

  const raw = tokens[timeoutIndexes[0]! + 1];
  if (raw === undefined) return DEFAULT_AWAIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return DEFAULT_AWAIT_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_AWAIT_TIMEOUT_MS);
}

/**
 * Tokenize only the first simple shell command. Quotes and backslash escapes
 * group characters, while an unquoted shell control operator ends the scan.
 */
function leadingSimpleCommandTokens(command: string): {
  readonly tokens: string[];
  readonly valid: boolean;
  readonly consumedAll: boolean;
} {
  const source = trimLeadingShellSpacing(command);
  const tokens: string[] = [];
  let index = 0;

  while (index < source.length) {
    while (index < source.length && isHorizontalWhitespace(source[index]!)) {
      index += 1;
    }
    if (index >= source.length || isShellControl(source[index]!)) break;
    if (source[index] === "#") break;

    let token = "";
    let started = false;
    let danglingEscape = false;
    let quote: "'" | '"' | undefined;
    while (index < source.length) {
      const character = source[index]!;
      if (quote !== undefined) {
        if (character === quote) {
          quote = undefined;
          started = true;
          index += 1;
          continue;
        }
        if (quote === '"' && character === "\\" && index + 1 < source.length) {
          const escaped = source[index + 1]!;
          if (escaped === "\n") {
            index += 2;
            continue;
          }
          token +=
            escaped === "$" ||
            escaped === "`" ||
            escaped === '"' ||
            escaped === "\\"
              ? escaped
              : `\\${escaped}`;
          started = true;
          index += 2;
          continue;
        }
        token += character;
        started = true;
        index += 1;
        continue;
      }

      if (character === "'" || character === '"') {
        quote = character;
        started = true;
        index += 1;
        continue;
      }
      if (character === "\\" && index + 1 < source.length) {
        const escaped = source[index + 1]!;
        if (escaped !== "\n") {
          token += escaped;
          started = true;
        }
        index += 2;
        continue;
      }
      if (character === "\\") {
        danglingEscape = true;
        break;
      }
      if (isHorizontalWhitespace(character) || isShellControl(character)) break;
      token += character;
      started = true;
      index += 1;
    }

    if (quote !== undefined || danglingEscape) {
      return { tokens, valid: false, consumedAll: false };
    }
    if (started) tokens.push(token);
    if (index < source.length && isShellControl(source[index]!)) break;
  }

  return {
    tokens,
    valid: true,
    consumedAll:
      index >= source.length ||
      // A trailing shell comment cannot execute another command. Newlines and
      // substitutions inside it were already rejected by the strict guard.
      source[index] === "#",
  };
}

function hasDigestUnsafeShellSyntax(command: string): boolean {
  return (
    command.includes("\r") ||
    command.includes("\n") ||
    command.includes(";") ||
    command.includes("&") ||
    command.includes("|") ||
    command.includes("<") ||
    command.includes(">") ||
    command.includes("$(") ||
    command.includes("`")
  );
}

function trimLeadingShellSpacing(command: string): string {
  let index = 0;
  while (
    index < command.length &&
    (isHorizontalWhitespace(command[index]!) ||
      command[index] === "\r" ||
      command[index] === "\n")
  ) {
    index += 1;
  }
  return command.slice(index);
}

function isHorizontalWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}

function isShellControl(character: string): boolean {
  return (
    character === ";" ||
    character === "&" ||
    character === "|" ||
    character === "<" ||
    character === ">" ||
    character === "\r" ||
    character === "\n"
  );
}
