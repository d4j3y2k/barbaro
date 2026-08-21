/**
 * Read-only setup diagnostics for dogfooding Barbaro in a project.
 *
 * The library observes; it never installs, edits, or repairs. It reads only
 * project-local configuration, plus metadata for the interpreter and CLI a
 * project hook config names, and it inspects `.barbaro/` through metadata
 * alone so canonical coordination records are never copied into a report.
 */

export {
  BUILD_DIAGNOSTIC_ID,
  MAX_REPORTED_PATHS,
  checkBuildFreshness,
  inspectBuildFreshness,
  type BuildFreshness,
  type BuildFreshnessOptions,
} from "./build.js";
export {
  formatSetupDoctorReport,
  runSetupDoctor,
  type RunSetupDoctorOptions,
} from "./doctor.js";
export {
  DEFAULT_SCAN_LIMITS,
  ageSeconds,
  inspectPath,
  inspectResolvedFile,
  isWithin,
  readJsonFile,
  readTextFile,
  resolveExecutable,
  resolveScanLimits,
  scanDirectory,
  toPosixRelative,
  walkFiles,
  type DirectoryScan,
  type FileWalk,
  type JsonFileRead,
  type PathFacts,
  type PathKind,
  type ResolvedFileFacts,
  type ScanLimits,
  type TextFileRead,
  type WalkedFile,
} from "./fs-facts.js";
export {
  GITIGNORE_DIAGNOSTIC_ID,
  MAX_GITIGNORE_BYTES,
  checkGitignore,
  inspectGitignore,
  type GitignoreInspection,
  type GitignoreOptions,
} from "./gitignore.js";
export {
  COMPACT_LEASE_FIELDS,
  PEER_CONTEXT_AUTOMATION_MILESTONE,
  PEER_CONTEXT_FEED_RECORDS_PER_SESSION,
  PEER_CONTEXT_LIMITS,
  PEER_CONTEXT_RENDER_BUDGET_BYTES,
  buildSetupGuidance,
  launchGuidance,
  peerContextPreflight,
} from "./guidance.js";
export {
  DEFAULT_HOOK_TARGETS,
  MAX_HOOK_CONFIG_BYTES,
  analyzeHookCommand,
  checkHookConfig,
  collectHookCommands,
  hookDiagnosticId,
  inspectHookConfig,
  tokenizeCommand,
  type HookCommandAnalysis,
  type HookConfigInspection,
  type HookInspectionOptions,
  type HookProvider,
  type HookProviderTarget,
} from "./hooks.js";
export {
  ISOLATION_DIAGNOSTIC_ID,
  checkWorkspaceIsolation,
  inspectWorkspaceIsolation,
  type GitKind,
  type IsolationInspection,
  type IsolationOptions,
} from "./isolation.js";
export {
  DIAGNOSTIC_STATUSES,
  SETUP_DOCTOR_SCHEMA,
  countStatuses,
  facts,
  statusSeverity,
  worstStatus,
  type Diagnostic,
  type DiagnosticFact,
  type DiagnosticStatus,
  type FreshnessThresholds,
  type GuidanceStep,
  type PeerContextLimits,
  type SetupDoctorOptions,
  type SetupDoctorReport,
  type SetupGuidance,
} from "./types.js";
export {
  DEFAULT_FRESHNESS,
  VIEWS_DIAGNOSTIC_ID,
  checkCoordinationViews,
  inspectCoordinationViews,
  type CoordinationView,
  type ViewSummary,
  type ViewsInspection,
  type ViewsOptions,
} from "./views.js";
