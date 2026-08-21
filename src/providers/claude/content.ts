import type { BarbaroContent } from "../../contracts/v1.js";
import { normalizedContent, verbatimContent } from "../../core/content.js";

/**
 * Claude Code wraps user text in harness-injected blocks before it reaches the
 * trace. Stripping them is a deterministic transformation, so the copied text
 * is `normalized` rather than `verbatim`, and original_utf8_bytes always
 * reports the pre-strip size.
 */

const INJECTED_BLOCK_PATTERN =
  /<(system-reminder|command-name|command-message|command-args|local-command-stdout)>[\s\S]*?<\/\1>/g;

/** A self-closing or unterminated reminder at the tail of a prompt. */
const TRAILING_OPEN_REMINDER = /<system-reminder>[\s\S]*$/;

export interface StrippedText {
  readonly text: string;
  readonly changed: boolean;
  readonly originalUtf8Bytes: number;
}

export function stripClaudeInjectedText(text: string): StrippedText {
  const originalUtf8Bytes = Buffer.byteLength(text, "utf8");
  let stripped = text.replace(INJECTED_BLOCK_PATTERN, "");
  stripped = stripped.replace(TRAILING_OPEN_REMINDER, "");
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: stripped,
    changed: stripped !== text,
    originalUtf8Bytes,
  };
}

/**
 * Build the digest `request` content from raw user text. Returns undefined
 * when nothing survives stripping (a prompt that was purely harness
 * injection).
 *
 * Canonical content is copied in full. Stripping harness-injected wrappers
 * makes the copy `normalized` rather than `verbatim`, and original_utf8_bytes
 * always reports the pre-strip size, but nothing is truncated.
 */
export function claudeRequestContent(text: string): BarbaroContent | undefined {
  const stripped = stripClaudeInjectedText(text);
  if (stripped.text.length === 0) return undefined;
  if (!stripped.changed) return verbatimContent(stripped.text);
  return normalizedContent(stripped.text, stripped.originalUtf8Bytes);
}

export function claudeResponseContent(text: string): BarbaroContent | undefined {
  if (text.length === 0) return undefined;
  return verbatimContent(text);
}

/**
 * Deterministic test-command classifier. It never asserts an outcome — it only
 * decides whether an action is reported as `test` rather than `command`.
 */
export function isClaudeTestCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return false;
  const prefixes = [
    "npm test",
    "npm run test",
    "pnpm test",
    "yarn test",
    "bun test",
    "pytest",
    "python -m pytest",
    "cargo test",
    "go test",
    "jest",
    "vitest",
    "mocha",
    "rspec",
    "phpunit",
    "dotnet test",
    "mvn test",
    "gradle test",
  ];
  return prefixes.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

/**
 * Tools whose results never mutate the workspace. They become `tool` actions
 * carrying only a name, never copied payloads.
 */
export const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "NotebookRead",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
]);

export const CLAUDE_FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "NotebookEdit",
]);

export const CLAUDE_SUBAGENT_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);
