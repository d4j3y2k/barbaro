import { lstatSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join as joinPath, relative, resolve } from "node:path";

import { writeJsonFileAtomically } from "../core/atomic-json.js";
import { createSessionId } from "../core/id.js";
import { SafeStoreBoundary } from "../core/safe-store.js";
import { compareUtf16CodeUnits } from "../core/stable-json.js";
import { withDirectoryLock } from "../output/directory-lock.js";
import {
  InvalidWorkstreamNameError,
  WorkstreamNameTakenError,
  WorkstreamStore,
  isWorkstreamId,
  isWorkstreamName,
  type WorkstreamV1,
} from "../workstreams/index.js";

export const BARBARO_JOIN_COMMAND = "/barbaro";
export const BARBARO_CODEX_SKILL = "$barbaro";
/** Pre-workstream consent: the session is enrolled but unscoped. */
export const SESSION_PARTICIPATION_SCHEMA =
  "barbaro.session-participation.v1";
/** Consent that names the workstream the session currently belongs to. */
export const SESSION_PARTICIPATION_SCHEMA_V2 =
  "barbaro.session-participation.v2";
export const SESSION_NOT_JOINED = "session has not joined Barbaro";
export const WORKSTREAM_SELECTION_PENDING = "workstream selection pending";

const MAX_PARTICIPATION_BYTES = 16 * 1024;
const SESSION_ID_PATTERN = /^ses_[0-9a-f]{32}$/;
const PARTICIPATION_FILENAME_PATTERN = /^(ses_[0-9a-f]{32})\.json$/;

export type ParticipatingProvider = "codex" | "claude";

export const PARTICIPATING_PROVIDERS: readonly ParticipatingProvider[] = [
  "claude",
  "codex",
];

export interface SessionParticipationV1 {
  readonly schema: typeof SESSION_PARTICIPATION_SCHEMA;
  readonly provider: ParticipatingProvider;
  readonly session_id: string;
  readonly joined_at: string;
  readonly initiated_by: "user_prompt";
  readonly workstream_id?: undefined;
  readonly memberships?: undefined;
}

export interface SessionWorkstreamMembership {
  readonly workstream_id: string;
  readonly from: string;
}

export interface SessionParticipationV2 {
  readonly schema: typeof SESSION_PARTICIPATION_SCHEMA_V2;
  readonly provider: ParticipatingProvider;
  readonly session_id: string;
  readonly joined_at: string;
  readonly initiated_by: "user_prompt";
  readonly workstream_id: string;
  /**
   * Append-only membership history. Older v2 records omit this and mean one
   * membership in `workstream_id` beginning at `joined_at`.
   */
  readonly memberships?: readonly SessionWorkstreamMembership[];
}

/** Either consent shape. A v1 record is unscoped until it moves forward. */
export type SessionParticipation =
  | SessionParticipationV1
  | SessionParticipationV2;

/**
 * Resolve the append-only log represented by a consent record. A v1 record
 * has no scoped history; an older v2 record has one synthetic entry at its
 * original join time.
 */
export function participationMemberships(
  participation: SessionParticipation,
): readonly SessionWorkstreamMembership[] {
  if (participation.schema === SESSION_PARTICIPATION_SCHEMA) return [];
  return (
    participation.memberships ?? [
      {
        workstream_id: participation.workstream_id,
        from: participation.joined_at,
      },
    ]
  );
}

/**
 * The first line of a prompt, as Barbaro reads it.
 *
 * - `bare`: the command alone, or followed by anything that is not
 *   `new <name>` / `join <name>`. Never enrolls.
 * - `new` / `join`: the two-phase enrollment verbs. `name` is lowercased but
 *   otherwise unvalidated here; `admit` refuses an invalid slug with a
 *   reason rather than silently treating the line as bare.
 */
export type BarbaroInvocation =
  | { readonly kind: "bare" }
  | { readonly kind: "new" | "join"; readonly name: string };

export interface HookSessionAdmission {
  readonly joined: boolean;
  readonly initiated: boolean;
  readonly participation?: SessionParticipation;
  /**
   * A bare invocation in a session that has not joined: the user asked for
   * Barbaro but has not yet chosen a workstream. Nothing was written.
   */
  readonly pending?: "workstream-selection";
  /** A `new`/`join` that was not honored, with the reason. */
  readonly refused?: string;
  /**
   * Human-readable outcome for the hook to surface on a join-related
   * invocation: the roster, a confirmation, or the refusal reason.
   */
  readonly message?: string;
}

interface StoreAdmissionOptions {
  readonly provider: ParticipatingProvider;
  readonly nativeSessionId: string;
  readonly event: string;
  readonly prompt?: string;
  readonly commandName?: string;
  readonly now?: Date;
}

/**
 * Parse the leading Barbaro invocation, if any. The command or skill token
 * must be the first token of the first line — intentionally narrower than
 * natural-language matching, so merely discussing Barbaro never enrolls a
 * session. Returns `undefined` when the prompt is not an invocation at all.
 *
 * Codex Desktop serializes a skill selected from the composer as a leading
 * Markdown attachment rather than the literal `$barbaro` token. That form is
 * accepted only when `projectRoot` is supplied and the link target is exactly
 * the Barbaro skill installed for the current project or the current user;
 * arbitrary Markdown links are not invocations.
 */
export function parseBarbaroInvocation(
  prompt: string,
  projectRoot?: string,
): BarbaroInvocation | undefined {
  const lines = prompt.replace(/^\uFEFF/, "").split(/\r?\n/);
  const line = (lines[0] ?? "").trimStart();
  let rest: string | undefined;
  const token = /^(?:\/|\$)barbaro(?=\s|$)/iu.exec(line);
  if (token !== null) {
    rest = line.slice(token[0].length);
  } else if (projectRoot !== undefined) {
    rest = recognizedBarbaroSkillAttachmentRest(line, projectRoot);
  }
  if (rest === undefined) return undefined;

  // Desktop renders the separator after a selected skill as the literal HTML
  // numeric entity `&#x20;`; treat any run of them as the space they encode.
  let argumentText = rest.replace(/^(?:&#x20;)+/iu, " ").trim();

  // A composer-selected skill is serialized as the attachment followed by a
  // newline, so what the user typed \u2014 `new <name> \u2026` \u2014 arrives on the next
  // line. The same holds for a bare `$barbaro` typed alone on its first line.
  // The invocation is the token or attachment; its arguments are the first
  // words that follow it, on that line or the next non-empty one.
  if (argumentText.length === 0) {
    argumentText =
      lines.slice(1).find((candidate) => candidate.trim().length > 0)?.trim() ??
      "";
  }
  // Typing the command token after selecting the skill (`[$barbaro](\u2026)
  // /barbaro new x`, or a pasted prompt that begins with it) is redundant,
  // not a different command.
  argumentText = argumentText.replace(/^(?:\/|\$)barbaro(?=\s|$)\s*/iu, "");

  const words = argumentText.split(/\s+/u).filter((word) => word.length > 0);
  const verb = words[0]?.toLocaleLowerCase("en-US");
  if ((verb === "new" || verb === "join") && words[1] !== undefined) {
    return { kind: verb, name: words[1].toLocaleLowerCase("en-US") };
  }
  return { kind: "bare" };
}

/**
 * Whether the prompt leads with a Barbaro invocation of any kind. Retained
 * for callers that only need to know "is this addressed to Barbaro"; note
 * that a bare invocation no longer enrolls — `admit` decides that.
 */
export function isBarbaroJoinPrompt(
  prompt: string,
  projectRoot?: string,
): boolean {
  return parseBarbaroInvocation(prompt, projectRoot) !== undefined;
}

export function isBarbaroExpansion(commandName: string | undefined): boolean {
  return commandName?.trim().toLocaleLowerCase("en-US") === "barbaro";
}

/**
 * Persistent, per-provider-session consent. Installed hooks consult this
 * store on every event but publish nothing until a user explicitly joins a
 * workstream with `new <name>` or `join <name>`.
 *
 * Lock order: a join takes the participation file's lock first and, for
 * `new`, the workstream store's lock inside it. Nothing takes those locks in
 * the opposite order.
 */
export class SessionParticipationStore {
  readonly projectRoot: string;
  readonly #boundary: SafeStoreBoundary;

  constructor(projectRoot: string) {
    if (projectRoot.length === 0) {
      throw new TypeError("projectRoot must not be empty");
    }
    this.projectRoot = resolve(projectRoot);
    this.#boundary = SafeStoreBoundary.forBarbaroProject(this.projectRoot);
  }

  async read(
    provider: ParticipatingProvider,
    nativeSessionId: string,
  ): Promise<SessionParticipation | undefined> {
    const sessionId = participationSessionId(provider, nativeSessionId);
    return this.#readComponents(
      participationComponents(provider, sessionId),
      provider,
      sessionId,
    );
  }

  /**
   * Read one exact stable session path without deriving or re-hashing its id.
   * Observer surfaces such as cursor-based await already carry the stable
   * `ses_…` identity; hooks continue to use `read()` with their native id.
   */
  async readStable(
    provider: ParticipatingProvider,
    sessionId: string,
  ): Promise<SessionParticipation | undefined> {
    return this.#readComponents(
      participationComponents(provider, sessionId),
      provider,
      sessionId,
    );
  }

  async hasJoined(
    provider: ParticipatingProvider,
    nativeSessionId: string,
  ): Promise<boolean> {
    return (await this.read(provider, nativeSessionId)) !== undefined;
  }

  /**
   * Every recorded join, across providers, in deterministic order. Consent is
   * per session and never revoked in place, so this is the project's full
   * enrollment roster — presence is the lease store's business, not this one.
   */
  async list(
    onInvalid?: (path: string, error: unknown) => void,
  ): Promise<SessionParticipation[]> {
    const sessions: SessionParticipation[] = [];
    for (const provider of PARTICIPATING_PROVIDERS) {
      const directory = await this.#boundary.verifyDirectory([
        "sessions",
        provider,
      ]);
      if (directory === undefined) continue;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) =>
        compareUtf16CodeUnits(left.name, right.name),
      );
      for (const entry of entries) {
        const match = PARTICIPATION_FILENAME_PATTERN.exec(entry.name);
        if (match === null || entry.isSymbolicLink() || !entry.isFile()) {
          continue;
        }
        const components = ["sessions", provider, entry.name];
        try {
          const text = await this.#boundary.readUtf8File(
            components,
            MAX_PARTICIPATION_BYTES,
          );
          if (text === undefined) continue;
          sessions.push(parseParticipation(text, provider, match[1]!));
        } catch (error) {
          onInvalid?.(this.#boundary.pathFor(components), error);
        }
      }
    }
    return sessions;
  }

  async admit(options: StoreAdmissionOptions): Promise<HookSessionAdmission> {
    const invocation = invocationFor(options, this.projectRoot);
    if (invocation === undefined) {
      const participation = await this.read(
        options.provider,
        options.nativeSessionId,
      );
      return participation === undefined
        ? { joined: false, initiated: false }
        : { joined: true, initiated: false, participation };
    }
    if (invocation.kind === "bare") {
      return this.#describe(options.provider, options.nativeSessionId);
    }
    return this.#enroll(
      options.provider,
      options.nativeSessionId,
      invocation,
      options.now ?? new Date(),
    );
  }

  /** A bare invocation: report where the session stands, write nothing. */
  async #describe(
    provider: ParticipatingProvider,
    nativeSessionId: string,
  ): Promise<HookSessionAdmission> {
    const participation = await this.read(provider, nativeSessionId);
    const workstreams = new WorkstreamStore(this.projectRoot);
    if (participation !== undefined) {
      return {
        joined: true,
        initiated: false,
        participation,
        message: await describeMembership(participation, workstreams),
      };
    }
    const open = (await workstreams.list()).filter(
      (workstream) => workstream.status === "open",
    );
    return {
      joined: false,
      initiated: false,
      pending: "workstream-selection",
      message: rosterMessage(provider, open),
    };
  }

  /**
   * The second phase. Read-compare-write under the participation lock so two
   * hook processes racing on one prompt, or a delayed hook racing a newer
   * prompt, cannot lose or reorder membership moves: the first writer wins,
   * a same-workstream repeat is idempotent, and a different open workstream
   * appends a forward-only membership.
   */
  async #enroll(
    provider: ParticipatingProvider,
    nativeSessionId: string,
    invocation: Extract<BarbaroInvocation, { kind: "new" | "join" }>,
    now: Date,
  ): Promise<HookSessionAdmission> {
    const joinedAt = now.getTime();
    if (!Number.isFinite(joinedAt)) {
      throw new TypeError("now must be a valid date");
    }
    const sessionId = participationSessionId(provider, nativeSessionId);
    const components = participationComponents(provider, sessionId);
    const name = invocation.name;
    const token = provider === "codex" ? BARBARO_CODEX_SKILL : BARBARO_JOIN_COMMAND;

    if (!isWorkstreamName(name)) {
      const existing = await this.#readComponents(components, provider, sessionId);
      return refusal(existing, new InvalidWorkstreamNameError(name).message);
    }

    const workstreams = new WorkstreamStore(this.projectRoot);
    // Read-only pre-check: a refusal must leave the store untouched, so the
    // consent record's parent directory is created only on the way to
    // writing one. The locked pass below re-derives the decision on fresh
    // reads; this one merely short-circuits outcomes that cannot improve.
    const preliminary = await this.#decide(
      components,
      provider,
      sessionId,
      invocation,
      workstreams,
      token,
    );
    if (preliminary.kind !== "proceed") return preliminary.admission;

    const target = await this.#boundary.ensureParentForFile(components);
    return withDirectoryLock(target, async () => {
      const decision = await this.#decide(
        components,
        provider,
        sessionId,
        invocation,
        workstreams,
        token,
      );
      if (decision.kind !== "proceed") return decision.admission;

      let workstream: WorkstreamV1;
      let created = false;
      if (decision.workstream !== undefined) {
        workstream = decision.workstream;
      } else {
        try {
          // Nested lock, participation → workstreams. Never the reverse. The
          // session's membership was checked first, so a refused join never
          // leaves an orphan workstream behind.
          workstream = await workstreams.create({
            name,
            createdBy: { provider, session_id: sessionId },
            now,
          });
          created = true;
        } catch (error) {
          if (error instanceof WorkstreamNameTakenError) {
            // A concurrent creator can make a target appear between the
            // locked decision and the nested workstream create. An existing
            // member may move to that newly-created open target; a first-time
            // enrollment retains `new`'s name-taken refusal semantics.
            if (
              decision.existing !== undefined &&
              error.existing.status === "open"
            ) {
              workstream = error.existing;
            } else {
              return refusal(
                decision.existing,
                existsMessage(error.existing, token),
              );
            }
          } else {
            throw error;
          }
        }
      }

      const previous = decision.existing;
      const priorMemberships =
        previous === undefined ? [] : participationMemberships(previous);
      const membershipFrom = nextMembershipFrom(priorMemberships, joinedAt);
      const participation: SessionParticipationV2 = {
        schema: SESSION_PARTICIPATION_SCHEMA_V2,
        provider,
        session_id: sessionId,
        joined_at:
          previous === undefined
            ? new Date(joinedAt).toISOString()
            : previous.joined_at,
        initiated_by: "user_prompt",
        workstream_id: workstream.workstream_id,
        memberships: [
          ...priorMemberships,
          { workstream_id: workstream.workstream_id, from: membershipFrom },
        ],
      };
      await writeJsonFileAtomically(this.#boundary, components, participation);
      const sessionVariable =
        provider === "codex" ? "CODEX_SESSION_ID" : "CLAUDE_CODE_SESSION_ID";
      if (previous !== undefined) {
        const from =
          previous.workstream_id === undefined
            ? "unscoped history"
            : decision.previousWorkstream === undefined
              ? previous.workstream_id
              : `"${decision.previousWorkstream.name}"`;
        return {
          joined: true,
          initiated: true,
          participation,
          message:
            `Barbaro: moved this session to workstream ` +
            `"${workstream.name}" (${workstream.workstream_id}) from ${from}; ` +
            `earlier turns stay where they were.`,
        };
      }
      return {
        joined: true,
        initiated: true,
        participation,
        // The one-line primer that lets a casual prompt work: peers read
        // completed turns, and this is how to read theirs back.
        message:
          `Barbaro: ${created ? "created and joined" : "joined"} workstream ` +
          `"${workstream.name}" (${workstream.workstream_id}). Peers in it see ` +
          `your completed turns; read theirs with \`barbaro context ` +
          `--provider ${provider} --session-id "$${sessionVariable}"\`.`,
      };
    });
  }

  /**
   * The join decision from the current consent record and name resolution.
   * `proceed` with a workstream means join or move to it; `proceed` without
   * one means the name is free and `new` may create it. Existing membership
   * is carried into the locked writer so it can only be extended, never
   * rewritten.
   */
  async #decide(
    components: readonly string[],
    provider: ParticipatingProvider,
    sessionId: string,
    invocation: Extract<BarbaroInvocation, { kind: "new" | "join" }>,
    workstreams: WorkstreamStore,
    token: string,
  ): Promise<
    | {
        readonly kind: "refuse" | "idempotent";
        readonly admission: HookSessionAdmission;
      }
    | {
        readonly kind: "proceed";
        readonly workstream?: WorkstreamV1;
        readonly existing?: SessionParticipation;
        readonly previousWorkstream?: WorkstreamV1;
      }
  > {
    const name = invocation.name;
    const existing = await this.#readComponents(components, provider, sessionId);
    const resolved = await workstreams.resolve(name);

    if (existing !== undefined) {
      if (
        resolved !== undefined &&
        resolved.workstream_id === existing.workstream_id
      ) {
        return {
          kind: "idempotent",
          admission: {
            joined: true,
            initiated: false,
            participation: existing,
            message:
              `Barbaro: this session already belongs to workstream ` +
              `"${resolved.name}" (${resolved.workstream_id}).`,
          },
        };
      }
      if (invocation.kind === "join" && resolved === undefined) {
        return {
          kind: "refuse",
          admission: refusal(
            existing,
            `no workstream named "${name}"; create it with ` +
              `\`${token} new ${name}\` or list them with ` +
              `\`barbaro workstream list\``,
          ),
        };
      }
      if (resolved !== undefined && resolved.status !== "open") {
        return {
          kind: "refuse",
          admission: refusal(
            existing,
            `workstream "${name}" is ${resolved.status}; reopen it first or ` +
              `start another`,
          ),
        };
      }
      const previousWorkstream =
        existing.workstream_id === undefined
          ? undefined
          : await workstreams.get(existing.workstream_id);
      return {
        kind: "proceed",
        ...(resolved === undefined ? {} : { workstream: resolved }),
        existing,
        ...(previousWorkstream === undefined ? {} : { previousWorkstream }),
      };
    }

    if (invocation.kind === "join") {
      if (resolved === undefined) {
        return {
          kind: "refuse",
          admission: refusal(
            undefined,
            `no workstream named "${name}"; create it with ` +
              `\`${token} new ${name}\` or list them with ` +
              `\`barbaro workstream list\``,
          ),
        };
      }
      if (resolved.status !== "open") {
        return {
          kind: "refuse",
          admission: refusal(
            undefined,
            `workstream "${name}" is ${resolved.status}; reopen it first or ` +
              `start another`,
          ),
        };
      }
      return { kind: "proceed", workstream: resolved };
    }
    if (resolved !== undefined) {
      return {
        kind: "refuse",
        admission: refusal(undefined, existsMessage(resolved, token)),
      };
    }
    return { kind: "proceed" };
  }

  async #readComponents(
    components: readonly string[],
    provider: ParticipatingProvider,
    sessionId: string,
  ): Promise<SessionParticipation | undefined> {
    const text = await this.#boundary.readUtf8File(
      components,
      MAX_PARTICIPATION_BYTES,
    );
    if (text === undefined) return undefined;
    return parseParticipation(text, provider, sessionId);
  }
}

export async function admitHookSession(options: {
  readonly projectRoot: string;
  readonly provider: ParticipatingProvider;
  readonly nativeSessionId: string;
  readonly event: string;
  readonly prompt?: string;
  readonly commandName?: string;
  readonly now?: Date;
}): Promise<HookSessionAdmission> {
  const store = new SessionParticipationStore(options.projectRoot);
  return store.admit(options);
}

function invocationFor(
  options: StoreAdmissionOptions,
  projectRoot: string,
): BarbaroInvocation | undefined {
  if (options.event === "UserPromptSubmit" && options.prompt !== undefined) {
    return parseBarbaroInvocation(
      options.prompt,
      options.provider === "codex" ? projectRoot : undefined,
    );
  }
  if (
    options.provider === "claude" &&
    options.event === "UserPromptExpansion" &&
    isBarbaroExpansion(options.commandName)
  ) {
    // The expansion event names the command; when it also carries the raw
    // line the verbs are read from it, otherwise it counts as bare. Bare
    // never undoes a join, so the paired UserPromptSubmit stays decisive.
    return options.prompt === undefined
      ? { kind: "bare" }
      : (parseBarbaroInvocation(options.prompt) ?? { kind: "bare" });
  }
  return undefined;
}

function refusal(
  existing: SessionParticipation | undefined,
  reason: string,
): HookSessionAdmission {
  return {
    joined: existing !== undefined,
    initiated: false,
    ...(existing === undefined ? {} : { participation: existing }),
    refused: reason,
    message: `Barbaro: ${reason}`,
  };
}

function existsMessage(existing: WorkstreamV1, token: string): string {
  return (
    `workstream "${existing.name}" already exists (${existing.status}); ` +
    (existing.status === "open"
      ? `join it with \`${token} join ${existing.name}\` or choose another name`
      : `reopen it first or choose another name`)
  );
}

function rosterMessage(
  provider: ParticipatingProvider,
  open: readonly WorkstreamV1[],
): string {
  const token = provider === "codex" ? BARBARO_CODEX_SKILL : BARBARO_JOIN_COMMAND;
  const head =
    "Barbaro: this session has not joined a workstream, so nothing is " +
    "published yet.";
  const roster =
    open.length === 0
      ? "No open workstreams exist in this project."
      : `Open workstreams: ${open.map((workstream) => workstream.name).join(", ")}.`;
  return (
    `${head} ${roster} Re-invoke as \`${token} join <name>\` or ` +
    `\`${token} new <name>\`; the task may follow on the same line.`
  );
}

async function describeMembership(
  participation: SessionParticipation,
  workstreams: WorkstreamStore,
): Promise<string> {
  if (participation.workstream_id === undefined) {
    return (
      "Barbaro: this session joined before workstreams existed and is " +
      "unscoped until it moves forward to a workstream."
    );
  }
  const workstream = await workstreams.get(participation.workstream_id);
  return workstream === undefined
    ? `Barbaro: this session belongs to workstream ${participation.workstream_id}.`
    : `Barbaro: this session belongs to workstream "${workstream.name}" ` +
        `(${workstream.workstream_id}, ${workstream.status}).`;
}

/**
 * Returns what follows a recognized Barbaro skill attachment on the line, or
 * `undefined` when the line does not start with one. The separator after the
 * attachment must be absent, whitespace, or Desktop's encoded `&#x20;` space;
 * any other adjacent text means this is not an invocation.
 */
function recognizedBarbaroSkillAttachmentRest(
  firstLine: string,
  projectRoot: string,
): string | undefined {
  const prefix = "[$barbaro](";
  if (
    firstLine.slice(0, prefix.length).toLocaleLowerCase("en-US") !== prefix
  ) {
    return undefined;
  }

  let depth = 1;
  let escaped = false;
  let closingIndex = -1;
  for (let index = prefix.length; index < firstLine.length; index += 1) {
    const character = firstLine[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
    }
  }
  if (closingIndex < 0) return undefined;
  const afterAttachment = firstLine.slice(closingIndex + 1);
  if (
    afterAttachment.length > 0 &&
    !/^\s/u.test(afterAttachment) &&
    !/^&#x20;/iu.test(afterAttachment)
  ) {
    return undefined;
  }

  let destination = firstLine.slice(prefix.length, closingIndex).trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  if (destination.length === 0 || destination.includes("\0")) return undefined;
  try {
    destination = decodeURI(destination);
  } catch {
    return undefined;
  }

  const resolvedDestination = resolve(projectRoot, destination);
  const canonicalDestination = canonicalSkillFile(resolvedDestination);
  if (canonicalDestination === undefined) return undefined;
  const recognized = recognizedBarbaroSkillPaths(projectRoot).some(
    (candidate) => {
      const canonicalCandidate = canonicalSkillFile(candidate);
      return (
        canonicalCandidate !== undefined &&
        (samePath(resolvedDestination, candidate) ||
          samePath(resolvedDestination, canonicalCandidate)) &&
        samePath(canonicalDestination, canonicalCandidate)
      );
    },
  );
  return recognized ? afterAttachment : undefined;
}

function barbaroSkillPath(root: string): string {
  return joinPath(
    resolve(root),
    ".agents",
    "skills",
    "barbaro",
    "SKILL.md",
  );
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function canonicalSkillFile(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function recognizedBarbaroSkillPaths(projectRoot: string): string[] {
  const start = resolve(projectRoot);
  const repositoryRoot = findRepositoryRoot(start);
  const roots = [start];
  if (repositoryRoot !== undefined) {
    let current = start;
    while (!samePath(current, repositoryRoot)) {
      current = dirname(current);
      roots.push(current);
    }
  }
  roots.push(homedir());
  return roots.map(barbaroSkillPath);
}

function findRepositoryRoot(start: string): string | undefined {
  let current = start;
  while (true) {
    try {
      const gitEntry = lstatSync(joinPath(current, ".git"));
      if (
        gitEntry.isDirectory() ||
        gitEntry.isFile() ||
        gitEntry.isSymbolicLink()
      ) {
        return current;
      }
    } catch (error) {
      if (!isMissingPathError(error)) return undefined;
    }
    const parent = dirname(current);
    if (samePath(parent, current)) return undefined;
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function participationSessionId(
  provider: ParticipatingProvider,
  nativeSessionId: string,
): string {
  if (nativeSessionId.length === 0) {
    throw new TypeError("nativeSessionId must not be empty");
  }
  return createSessionId(provider, nativeSessionId);
}

function participationComponents(
  provider: ParticipatingProvider,
  sessionId: string,
): readonly string[] {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError(`Invalid session_id: ${JSON.stringify(sessionId)}`);
  }
  return ["sessions", provider, `${sessionId}.json`];
}

function parseParticipation(
  text: string,
  expectedProvider: ParticipatingProvider,
  expectedSessionId: string,
): SessionParticipation {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) {
    throw new TypeError("Session participation must be a JSON object");
  }
  const schema = value.schema;
  if (
    schema !== SESSION_PARTICIPATION_SCHEMA &&
    schema !== SESSION_PARTICIPATION_SCHEMA_V2
  ) {
    throw new TypeError("Unsupported session participation schema");
  }
  if (
    value.provider !== expectedProvider ||
    value.session_id !== expectedSessionId ||
    value.initiated_by !== "user_prompt" ||
    typeof value.joined_at !== "string" ||
    !Number.isFinite(Date.parse(value.joined_at))
  ) {
    throw new TypeError("Session participation is structurally invalid");
  }
  // v1 is unscoped by definition; v2 always names its current workstream.
  if (schema === SESSION_PARTICIPATION_SCHEMA) {
    if (
      value.workstream_id !== undefined ||
      value.memberships !== undefined
    ) {
      throw new TypeError(
        "Session participation v1 must not name workstream memberships",
      );
    }
  } else if (!isWorkstreamId(value.workstream_id)) {
    throw new TypeError("Session participation v2 must name a valid workstream");
  } else if (value.memberships !== undefined) {
    validateMemberships(value.memberships, value.workstream_id);
  }
  return value as unknown as SessionParticipation;
}

function validateMemberships(value: unknown, currentWorkstreamId: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Session participation memberships must be non-empty");
  }
  let previousFrom = Number.NEGATIVE_INFINITY;
  for (const membership of value) {
    if (
      !isObject(membership) ||
      !isWorkstreamId(membership.workstream_id) ||
      typeof membership.from !== "string"
    ) {
      throw new TypeError("Session participation membership is invalid");
    }
    const from = Date.parse(membership.from);
    if (!Number.isFinite(from) || from <= previousFrom) {
      throw new TypeError(
        "Session participation membership times must be strictly increasing",
      );
    }
    previousFrom = from;
  }
  const last = value[value.length - 1] as Record<string, unknown>;
  if (last.workstream_id !== currentWorkstreamId) {
    throw new TypeError(
      "Session participation current workstream must equal its last membership",
    );
  }
}

function nextMembershipFrom(
  memberships: readonly SessionWorkstreamMembership[],
  requestedFrom: number,
): string {
  const previous = memberships.at(-1);
  const previousFrom = previous === undefined ? undefined : Date.parse(previous.from);
  const from =
    previousFrom === undefined || requestedFrom > previousFrom
      ? requestedFrom
      : previousFrom + 1;
  const date = new Date(from);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("membership time must be a valid date");
  }
  return date.toISOString();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
