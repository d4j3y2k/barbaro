// Provider-neutral derived-content helpers now live in core so every provider
// adapter shares one redactor and one repo-path rule. Re-exported here so
// existing Codex imports keep working unchanged.
export {
  excerptContent,
  isGeneratedBarbaroPath,
  normalizeRepoPath,
  redactedExcerptContent,
  verbatimContent,
} from "../../core/content.js";

export function isCodexInjectedText(text: string): boolean {
  const leftTrimmed = text.trimStart();
  if (leftTrimmed.startsWith("# AGENTS.md instructions for ")) return true;

  const trimmed = text.trim();
  const injectedTags = [
    "environment_context",
    "recommended_plugins",
    "skills_instructions",
    "permissions instructions",
    "collaboration_mode",
    "apps_instructions",
    "plugins_instructions",
  ];
  return injectedTags.some(
    (tag) =>
      trimmed.startsWith(`<${tag}>`) && trimmed.endsWith(`</${tag}>`),
  );
}

export function extractCodexMessageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (
      (record.type === "input_text" || record.type === "output_text") &&
      typeof record.text === "string" &&
      !isCodexInjectedText(record.text)
    ) {
      parts.push(record.text);
    }
  }
  const text = parts.join("\n");
  return text.length > 0 ? text : undefined;
}
