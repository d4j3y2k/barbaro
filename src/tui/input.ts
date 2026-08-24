const ESCAPE = "\u001b";
const BRACKETED_PASTE_START = `${ESCAPE}[200~`;
const BRACKETED_PASTE_END = `${ESCAPE}[201~`;

/** Maximum time spent deciding whether Escape begins a terminal sequence. */
export const DEFAULT_ESCAPE_TIMEOUT_MS = 40;
export const MAX_ESCAPE_TIMEOUT_MS = 50;

export type TuiCommand =
  | "next-pane"
  | "previous-pane"
  | "move-up"
  | "move-down"
  | "open-detail"
  | "close-detail"
  | "refresh"
  | "quit";

export interface TuiInputParserOptions {
  readonly emit: (command: TuiCommand) => void;
  readonly escapeTimeoutMs?: number;
  readonly setTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const DIRECT_COMMANDS = new Map<string, TuiCommand>([
  ["q", "quit"],
  ["\u0003", "quit"],
  ["r", "refresh"],
  ["j", "move-down"],
  ["k", "move-up"],
  ["\t", "next-pane"],
  ["\r", "open-detail"],
  ["\n", "open-detail"],
]);

const ESCAPE_COMMANDS = new Map<string, TuiCommand>([
  [`${ESCAPE}[Z`, "previous-pane"],
  [`${ESCAPE}[A`, "move-up"],
  [`${ESCAPE}[B`, "move-down"],
  [`${ESCAPE}[C`, "next-pane"],
  [`${ESCAPE}[D`, "previous-pane"],
  // Some terminals emit SS3 cursor sequences while in application mode.
  [`${ESCAPE}OA`, "move-up"],
  [`${ESCAPE}OB`, "move-down"],
  [`${ESCAPE}OC`, "next-pane"],
  [`${ESCAPE}OD`, "previous-pane"],
]);

const ESCAPE_PREFIXES = [
  ...ESCAPE_COMMANDS.keys(),
  BRACKETED_PASTE_START,
];

function isIncompleteCsi(candidate: string): boolean {
  if (!candidate.startsWith(`${ESCAPE}[`)) return false;
  const body = candidate.slice(2);
  return ![...body].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x40 && code <= 0x7e;
  });
}

function defaultSetTimeout(
  callback: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Strict raw-terminal input decoder.
 *
 * Each non-escape command must be the complete input chunk. Escape sequences
 * may span chunks, but trailing bytes invalidate the whole candidate so pasted
 * text cannot accidentally invoke a command.
 */
export class TuiInputParser {
  readonly #emit: (command: TuiCommand) => void;
  readonly #escapeTimeoutMs: number;
  readonly #setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  #pendingEscape: string | undefined;
  #timeoutHandle: unknown;
  #timeoutScheduled = false;
  #bracketedPaste = false;
  #pasteEndPrefix = "";
  #disposed = false;

  constructor(options: TuiInputParserOptions) {
    const timeout = options.escapeTimeoutMs ?? DEFAULT_ESCAPE_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_ESCAPE_TIMEOUT_MS) {
      throw new RangeError(
        `escapeTimeoutMs must be between 0 and ${MAX_ESCAPE_TIMEOUT_MS}`,
      );
    }
    if (
      (options.setTimeout === undefined) !==
      (options.clearTimeout === undefined)
    ) {
      throw new TypeError("setTimeout and clearTimeout must be provided together");
    }

    this.#emit = options.emit;
    this.#escapeTimeoutMs = timeout;
    this.#setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.#clearTimeout = options.clearTimeout ?? defaultClearTimeout;
  }

  /** Consume one raw-mode data event. */
  push(chunk: Buffer | string): void {
    if (this.#disposed) return;

    const input = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (input.length === 0) return;

    if (this.#bracketedPaste) {
      this.#consumeBracketedPaste(input);
      return;
    }

    if (this.#pendingEscape !== undefined) {
      const candidate = `${this.#pendingEscape}${input}`;
      this.#clearPendingTimeout();
      this.#pendingEscape = undefined;
      this.#consumeEscapeCandidate(candidate);
      return;
    }

    const direct = DIRECT_COMMANDS.get(input);
    if (direct !== undefined) {
      this.#emit(direct);
      return;
    }

    if (input.startsWith(ESCAPE)) {
      this.#consumeEscapeCandidate(input);
    }
  }

  /** Stop decoding and release any pending Escape timer. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingEscape = undefined;
    this.#bracketedPaste = false;
    this.#pasteEndPrefix = "";
    this.#clearPendingTimeout();
  }

  #consumeEscapeCandidate(candidate: string): void {
    if (candidate.startsWith(BRACKETED_PASTE_START)) {
      this.#bracketedPaste = true;
      this.#consumeBracketedPaste(candidate.slice(BRACKETED_PASTE_START.length));
      return;
    }

    const command = ESCAPE_COMMANDS.get(candidate);
    if (command !== undefined) {
      this.#emit(command);
      return;
    }

    if (
      candidate === ESCAPE ||
      isIncompleteCsi(candidate) ||
      ESCAPE_PREFIXES.some((sequence) => sequence.startsWith(candidate))
    ) {
      this.#pendingEscape = candidate;
      this.#schedulePendingTimeout();
    }
    // Any other ESC-prefixed chunk is one unsupported input event. Dropping
    // it whole prevents Alt/unknown sequence suffixes from becoming commands.
  }

  #consumeBracketedPaste(input: string): void {
    const candidate = `${this.#pasteEndPrefix}${input}`;
    const endIndex = candidate.indexOf(BRACKETED_PASTE_END);
    if (endIndex >= 0) {
      this.#bracketedPaste = false;
      this.#pasteEndPrefix = "";
      // Bytes following the terminator share a pasted input event. Ignore
      // them rather than risking a command hidden in a multi-byte chunk.
      return;
    }

    let keep = Math.min(candidate.length, BRACKETED_PASTE_END.length - 1);
    while (
      keep > 0 &&
      !BRACKETED_PASTE_END.startsWith(candidate.slice(candidate.length - keep))
    ) {
      keep -= 1;
    }
    this.#pasteEndPrefix = candidate.slice(candidate.length - keep);
  }

  #schedulePendingTimeout(): void {
    this.#timeoutScheduled = true;
    this.#timeoutHandle = this.#setTimeout(() => {
      if (!this.#timeoutScheduled || this.#disposed) return;
      this.#timeoutScheduled = false;
      this.#timeoutHandle = undefined;
      const pending = this.#pendingEscape;
      this.#pendingEscape = undefined;
      if (pending === ESCAPE) this.#emit("close-detail");
    }, this.#escapeTimeoutMs);
  }

  #clearPendingTimeout(): void {
    if (!this.#timeoutScheduled) return;
    this.#timeoutScheduled = false;
    this.#clearTimeout(this.#timeoutHandle);
    this.#timeoutHandle = undefined;
  }
}

export function createTuiInputParser(
  options: TuiInputParserOptions,
): TuiInputParser {
  return new TuiInputParser(options);
}
