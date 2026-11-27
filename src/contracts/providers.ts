/** Provider identities with session enrollment and scoped reads. Feed records may use other names. */
export const PARTICIPATING_PROVIDERS = ["claude", "codex", "agy"] as const;

export type ParticipatingProvider = (typeof PARTICIPATING_PROVIDERS)[number];

export function isParticipatingProvider(value: unknown): value is ParticipatingProvider {
  return PARTICIPATING_PROVIDERS.some(provider => provider === value);
}

export const SESSION_VARIABLES = {
  claude: "CLAUDE_CODE_SESSION_ID",
  codex: "CODEX_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
} as const satisfies Record<ParticipatingProvider, string>;

/** Agy exports the native ID to command tools as well as hooks. Keep unscoped reads in observer mode. */
export function scopedSessionId(
  provider: string | undefined,
  explicitId: string | undefined,
  agyConversationId = process.env.ANTIGRAVITY_CONVERSATION_ID,
): string | undefined {
  return explicitId ?? (provider === "agy" && agyConversationId ? agyConversationId : undefined);
}
