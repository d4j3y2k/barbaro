import { BUILD_DIAGNOSTIC_ID } from "./build.js";
import { GITIGNORE_DIAGNOSTIC_ID } from "./gitignore.js";
import { hookDiagnosticId, type HookProvider } from "./hooks.js";
import { ISOLATION_DIAGNOSTIC_ID } from "./isolation.js";
import { VIEWS_DIAGNOSTIC_ID } from "./views.js";
import type {
  Diagnostic,
  GuidanceStep,
  PeerContextLimits,
  SetupGuidance,
} from "./types.js";

/**
 * Launch and peer-context guidance derived from the diagnostics.
 *
 * Guidance is data, not action: nothing here installs, edits, or repairs
 * anything. Steps carry stable ids so a CLI wrapper can render, filter, or
 * suppress them without pattern-matching prose.
 */

/** Total rendered peer context the setup preflight may put in one context. */
export const PEER_CONTEXT_RENDER_BUDGET_BYTES = 32 * 1024;

/** Newest records to read per provider session before the budget applies. */
export const PEER_CONTEXT_FEED_RECORDS_PER_SESSION = 5;

/** The only lease fields a preflight renders; everything else stays closed. */
export const COMPACT_LEASE_FIELDS: readonly string[] = [
  "agent_id",
  "claims",
  "current_action.kind",
  "current_action.tool_name",
  "expires_at",
  "provider",
  "session_id",
  "state",
  "unknown_write_scope",
  "updated_at",
];

/**
 * Kept under its original exported name for API compatibility. The bounded
 * reader is now the supported `barbaro context` command.
 */
export const PEER_CONTEXT_AUTOMATION_MILESTONE = "barbaro context";

export const PEER_CONTEXT_LIMITS: PeerContextLimits = {
  render_budget_bytes: PEER_CONTEXT_RENDER_BUDGET_BYTES,
  feed_records_per_session: PEER_CONTEXT_FEED_RECORDS_PER_SESSION,
  compact_lease_fields: COMPACT_LEASE_FIELDS,
};

/**
 * The supported bounded procedure to run before planning. Every step uses the
 * reader projection so a busy peer turn cannot flood a context.
 */
export function peerContextPreflight(): GuidanceStep[] {
  return [
    {
      id: "peer.read-supported-context",
      text:
        `Run \`barbaro context --byte-budget ${PEER_CONTEXT_RENDER_BUDGET_BYTES} --turns-per-session ${PEER_CONTEXT_FEED_RECORDS_PER_SESSION}\`; ` +
        "it filters expired leases and renders only supported compact projections.",
    },
    {
      id: "peer.bound-feed-reads",
      text: `Read the projected newest ${PEER_CONTEXT_FEED_RECORDS_PER_SESSION} feed records per provider session and honor every shown/total count.`,
    },
    {
      id: "peer.budget-render",
      text: `Cap all rendered peer context at ${PEER_CONTEXT_RENDER_BUDGET_BYTES} bytes total and report N-of-M when you truncate.`,
    },
    {
      id: "peer.never-print-canonical",
      text: "Never print a whole canonical JSONL record; canonical feed and evidence stay complete on disk and are projected, never copied wholesale.",
    },
    {
      id: "peer.evidence-on-demand",
      text: "Open evidence only through an evidence_ref you actually need; one child turn can exceed the entire budget.",
    },
    {
      id: "peer.state-observations",
      text: "State what peer activity you observed and your exact file scope before editing, then run `barbaro context` again immediately before each edit.",
    },
  ];
}

function statusOf(
  diagnostics: readonly Diagnostic[],
  id: string,
): Diagnostic | undefined {
  return diagnostics.find((diagnostic) => diagnostic.id === id);
}

/**
 * Ordered launch steps: blocking repairs first, then invariants that hold in
 * every configuration. Ordering is positional and deterministic.
 */
export function launchGuidance(
  diagnostics: readonly Diagnostic[],
  providers: readonly HookProvider[] = ["claude", "codex"],
): GuidanceStep[] {
  const steps: GuidanceStep[] = [];
  const build = statusOf(diagnostics, BUILD_DIAGNOSTIC_ID);
  if (build !== undefined && build.status !== "pass") {
    steps.push({
      id: "launch.build-first",
      text: "Run `npm run build` before starting any actor: hooks execute dist/, so unbuilt edits never reach a peer.",
    });
  }
  for (const provider of providers) {
    const hooks = statusOf(diagnostics, hookDiagnosticId(provider));
    if (hooks !== undefined && hooks.status !== "pass") {
      steps.push({
        id: `launch.fix-hooks-${provider}`,
        text: `Fix the project-local ${provider} hook config by hand before launching a ${provider} actor; Barbaro never installs or edits it for you.`,
      });
    }
  }
  const gitignore = statusOf(diagnostics, GITIGNORE_DIAGNOSTIC_ID);
  if (gitignore !== undefined && gitignore.status !== "pass") {
    steps.push({
      id: "launch.ignore-store",
      text: "Add `.barbaro/` to .gitignore before the next session: derived views carry request and response excerpts.",
    });
  }
  const views = statusOf(diagnostics, VIEWS_DIAGNOSTIC_ID);
  if (views !== undefined && views.status !== "pass") {
    steps.push({
      id: "launch.verify-publishing",
      text: "Verify hooks actually publish: a missing, empty, or stale view means you would launch with no live peer context.",
    });
  }
  const isolation = statusOf(diagnostics, ISOLATION_DIAGNOSTIC_ID);
  if (isolation !== undefined && !isolationAvailable(isolation)) {
    steps.push({
      id: "launch.disjoint-ownership",
      text: "There is no worktree isolation here: give each actor a disjoint file scope, and never let two actors own the same path.",
    });
  }

  steps.push(
    {
      id: "launch.join-session",
      text: "Explicitly invoke Barbaro in each participating session (`/barbaro` in Claude Code or the `$barbaro` skill in Codex); installed hooks stay dormant until that opt-in.",
    },
    {
      id: "launch.one-lane-per-actor",
      text: "Launch one lane per actor with its owned paths and forbidden paths stated in the prompt itself.",
    },
    {
      id: "launch.recheck-leases",
      text: "Run `barbaro context` immediately before editing a file; its non-expired leases are advisory snapshots, not locks.",
    },
    {
      id: "launch.read-only-store",
      text: "Treat .barbaro/ as generated, read-only coordination state; never edit or hand-repair it.",
    },
    {
      id: "launch.manual-config-only",
      text: "Apply hook and settings changes by hand, per project; the doctor never mutates project, user, or global settings, and hook installation never enrolls a session.",
    },
  );
  return steps;
}

function isolationAvailable(diagnostic: Diagnostic): boolean {
  return diagnostic.facts.some(
    (fact) => fact.key === "isolation_available" && fact.value === true,
  );
}

export function buildSetupGuidance(
  diagnostics: readonly Diagnostic[],
  providers?: readonly HookProvider[],
): SetupGuidance {
  return {
    launch: launchGuidance(diagnostics, providers),
    peer_context_preflight: peerContextPreflight(),
    peer_context_limits: PEER_CONTEXT_LIMITS,
    peer_context_automated_by: PEER_CONTEXT_AUTOMATION_MILESTONE,
  };
}
