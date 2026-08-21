import { randomBytes } from "node:crypto";
import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join as joinPath, relative, resolve } from "node:path";

import { createSessionId } from "../core/id.js";
import {
  SafeStoreBoundary,
  UnsafeStorePathError,
} from "../core/safe-store.js";
import {
  compareUtf16CodeUnits,
  stableStringify,
} from "../core/stable-json.js";

export const BARBARO_JOIN_COMMAND = "/barbaro";
export const BARBARO_CODEX_SKILL = "$barbaro";
export const SESSION_PARTICIPATION_SCHEMA =
  "barbaro.session-participation.v1";
export const SESSION_NOT_JOINED = "session has not joined Barbaro";

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
}

export interface HookSessionAdmission {
  readonly joined: boolean;
  readonly initiated: boolean;
  readonly participation?: SessionParticipationV1;
}

interface StoreAdmissionOptions {
  readonly provider: ParticipatingProvider;
  readonly nativeSessionId: string;
  readonly event: string;
  readonly prompt?: string;
  readonly commandName?: string;
}

/**
 * A join command or skill token must be the first token of the prompt. This is
 * intentionally narrower than natural-language matching: merely discussing
 * Barbaro must never enroll a session.
 *
 * The user may put the real task on following lines, so joining does not have
 * to consume a separate turn.
 */
export function isBarbaroJoinPrompt(
  prompt: string,
  projectRoot?: string,
): boolean {
  const firstLine = prompt.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const normalized = firstLine.trimStart().toLocaleLowerCase("en-US");
  if (/^(?:\/|\$)barbaro(?:\s|$)/u.test(normalized)) return true;

  // Codex Desktop serializes a skill selected from the composer as a leading
  // Markdown attachment rather than as the literal `$barbaro` token. Accept
  // only an exact Barbaro skill target from a recognized Codex discovery
  // location: the current project or the current user's machine-wide skill.
  // A generic link whose label happens to say `$barbaro` is not an invocation.
  return projectRoot === undefined
    ? false
    : isRecognizedBarbaroSkillAttachment(
        firstLine.trimStart(),
        projectRoot,
      );
}

export function isBarbaroExpansion(commandName: string | undefined): boolean {
  return commandName?.trim().toLocaleLowerCase("en-US") === "barbaro";
}

/**
 * Persistent, per-provider-session consent. Installed hooks consult this
 * store on every event but publish nothing until a user explicitly joins.
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
  ): Promise<SessionParticipationV1 | undefined> {
    const sessionId = participationSessionId(provider, nativeSessionId);
    const components = participationComponents(provider, sessionId);
    const text = await this.#boundary.readUtf8File(
      components,
      MAX_PARTICIPATION_BYTES,
    );
    if (text === undefined) return undefined;
    return parseParticipation(text, provider, sessionId);
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
  ): Promise<SessionParticipationV1[]> {
    const sessions: SessionParticipationV1[] = [];
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
    const isJoin =
      (options.event === "UserPromptSubmit" &&
        options.prompt !== undefined &&
        isBarbaroJoinPrompt(
          options.prompt,
          options.provider === "codex" ? this.projectRoot : undefined,
        )) ||
      (options.provider === "claude" &&
        options.event === "UserPromptExpansion" &&
        isBarbaroExpansion(options.commandName));

    if (isJoin) {
      const participation = await this.#join(
        options.provider,
        options.nativeSessionId,
      );
      return { joined: true, initiated: true, participation };
    }

    const participation = await this.read(
      options.provider,
      options.nativeSessionId,
    );
    return participation === undefined
      ? { joined: false, initiated: false }
      : { joined: true, initiated: false, participation };
  }

  async #join(
    provider: ParticipatingProvider,
    nativeSessionId: string,
    now: Date = new Date(),
  ): Promise<SessionParticipationV1> {
    const existing = await this.read(provider, nativeSessionId);
    if (existing !== undefined) return existing;
    const joinedAt = now.getTime();
    if (!Number.isFinite(joinedAt)) {
      throw new TypeError("now must be a valid date");
    }
    const sessionId = participationSessionId(provider, nativeSessionId);
    const participation: SessionParticipationV1 = {
      schema: SESSION_PARTICIPATION_SCHEMA,
      provider,
      session_id: sessionId,
      joined_at: new Date(joinedAt).toISOString(),
      initiated_by: "user_prompt",
    };
    await this.#atomicWrite(
      participationComponents(provider, sessionId),
      participation,
    );
    return participation;
  }

  async #atomicWrite(
    components: readonly string[],
    participation: SessionParticipationV1,
  ): Promise<void> {
    const target = await this.#boundary.ensureParentForFile(components);
    const temporaryComponents = [
      ...components.slice(0, -1),
      `.${components.at(-1)!}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
    ];
    const temporary = this.#boundary.pathFor(temporaryComponents);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${stableStringify(participation)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      const parent = await this.#boundary.verifyDirectory(
        components.slice(0, -1),
      );
      if (parent === undefined) {
        throw new UnsafeStorePathError(
          dirname(target),
          "participation parent disappeared",
        );
      }
      await rename(temporary, target);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export async function admitHookSession(options: {
  readonly projectRoot: string;
  readonly provider: ParticipatingProvider;
  readonly nativeSessionId: string;
  readonly event: string;
  readonly prompt?: string;
  readonly commandName?: string;
}): Promise<HookSessionAdmission> {
  const store = new SessionParticipationStore(options.projectRoot);
  return store.admit(options);
}

function isRecognizedBarbaroSkillAttachment(
  firstLine: string,
  projectRoot: string,
): boolean {
  const prefix = "[$barbaro](";
  if (
    firstLine.slice(0, prefix.length).toLocaleLowerCase("en-US") !== prefix
  ) {
    return false;
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
  if (closingIndex < 0) return false;
  const afterAttachment = firstLine.slice(closingIndex + 1);
  // Desktop currently renders the separator after a selected skill as the
  // literal HTML numeric entity `&#x20;` instead of a space in hook input.
  // Recognize only that exact encoded-space boundary; arbitrary entities or
  // adjacent text must not turn a Markdown link into consent.
  if (
    afterAttachment.length > 0 &&
    !/^\s/u.test(afterAttachment) &&
    !/^&#x20;/iu.test(afterAttachment)
  ) {
    return false;
  }

  let destination = firstLine.slice(prefix.length, closingIndex).trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  if (destination.length === 0 || destination.includes("\0")) return false;
  try {
    destination = decodeURI(destination);
  } catch {
    return false;
  }

  const resolvedDestination = resolve(projectRoot, destination);
  const canonicalDestination = canonicalSkillFile(resolvedDestination);
  if (canonicalDestination === undefined) return false;
  return recognizedBarbaroSkillPaths(projectRoot).some((candidate) => {
    const canonicalCandidate = canonicalSkillFile(candidate);
    return (
      canonicalCandidate !== undefined &&
      (samePath(resolvedDestination, candidate) ||
        samePath(resolvedDestination, canonicalCandidate)) &&
      samePath(canonicalDestination, canonicalCandidate)
    );
  });
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
): SessionParticipationV1 {
  const value = JSON.parse(text) as unknown;
  if (!isObject(value)) {
    throw new TypeError("Session participation must be a JSON object");
  }
  if (value.schema !== SESSION_PARTICIPATION_SCHEMA) {
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
  return value as unknown as SessionParticipationV1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
