import { isObject } from "./envelope.js";

export interface ExtractedCommand {
  readonly command: string;
  readonly occurrence: number;
}

/**
 * Current Codex Desktop custom tools encode nested calls as JavaScript source.
 * This intentionally supports only strict-JSON object arguments. If the source
 * uses variables, expressions, or any other JavaScript, Barbaro leaves it as
 * opaque evidence instead of evaluating code or guessing.
 */
export function extractExecCommands(input: string): readonly ExtractedCommand[] {
  const marker = "tools.exec_command(";
  const commands: ExtractedCommand[] = [];
  let searchFrom = 0;
  let occurrence = 0;

  while (searchFrom < input.length) {
    const markerIndex = input.indexOf(marker, searchFrom);
    if (markerIndex < 0) break;
    const valueStart = skipWhitespace(input, markerIndex + marker.length);
    const objectText = extractBalancedJsonObject(input, valueStart);
    searchFrom = objectText
      ? objectText.endExclusive
      : markerIndex + marker.length;
    if (!objectText) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(objectText.text);
    } catch {
      continue;
    }
    if (!isObject(parsed) || typeof parsed.cmd !== "string") continue;
    commands.push({ command: parsed.cmd, occurrence });
    occurrence += 1;
  }

  return commands;
}

export function extractDirectCommand(argumentsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  return isObject(parsed) && typeof parsed.cmd === "string"
    ? parsed.cmd
    : undefined;
}

export function isTestCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  return [
    /^(?:npm|pnpm|yarn|bun) (?:run )?test(?:\s|$)/,
    /^npx (?:vitest|jest|mocha)(?:\s|$)/,
    /^(?:cargo|swift|go) test(?:\s|$)/,
    /^(?:python(?:3)? -m )?pytest(?:\s|$)/,
    /^dotnet test(?:\s|$)/,
    /^mvn(?:w)? test(?:\s|$)/,
    /^gradle(?:w)? test(?:\s|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function skipWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) cursor += 1;
  return cursor;
}

function extractBalancedJsonObject(
  value: string,
  start: number,
): { readonly text: string; readonly endExclusive: number } | undefined {
  if (value[start] !== "{") return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          text: value.slice(start, cursor + 1),
          endExclusive: cursor + 1,
        };
      }
    }
  }
  return undefined;
}

