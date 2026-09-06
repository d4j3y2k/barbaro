/** Commands are scoped to the cursor owner; these ids are validated by the stores. */
export function readScopeFlags(provider: string, sessionId: string, workstreamId: string): string {
  return `--provider ${provider} --session-id ${sessionId} --workstream ${workstreamId} --project-root "$PWD"`;
}

export function readContextGuidance(provider: string, sessionId: string, workstreamId: string): string {
  return `run barbaro read context ${readScopeFlags(provider, sessionId, workstreamId)}`;
}

export function readGapGuidance(provider: string, sessionId: string, workstreamId: string): string {
  const scope = readScopeFlags(provider, sessionId, workstreamId);
  return `run barbaro turn list ${scope}; then barbaro read turn show <turn_id> --field response ${scope}; use --field request when no response exists; follow every next_cursor`;
}
