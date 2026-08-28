const ESCAPE = "\u001b";
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export const COMFORT_ESCAPE_TIMEOUT_MS = 40;

export type ComfortCommand =
  | "quit"
  | "refresh"
  | "move-up"
  | "move-down"
  | "exposure-left"
  | "exposure-right"
  | "open"
  | "back"
  | "help"
  | "detail-next"
  | "detail-previous"
  | "copy"
  | "create"
  | "lifecycle"
  | "filter"
  | "sort"
  | "toggle-motion"
  | "submit"
  | "erase";

export interface ComfortInputEvents {
  readonly command: (command: ComfortCommand) => void;
  /** One complete bracketed paste; §12 makes it a single field payload. */
  readonly paste: (payload: string) => void;
  /** Typed editor text; emitted only while editor mode is on. */
  readonly text?: (text: string) => void;
}

export interface ComfortInputOptions {
  readonly events: ComfortInputEvents;
  readonly escapeTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

const DIRECT_COMMANDS = new Map<string, ComfortCommand>([
  ["q", "quit"],
  ["\u0003", "quit"],
  ["r", "refresh"],
  ["j", "move-down"],
  ["k", "move-up"],
  ["h", "exposure-left"],
  ["l", "exposure-right"],
  ["\r", "open"],
  ["\n", "open"],
  ["?", "help"],
  ["\t", "detail-next"],
  ["c", "copy"],
  ["n", "create"],
  ["x", "lifecycle"],
  ["/", "filter"],
  ["s", "sort"],
  [" ", "toggle-motion"],
]);

const ESCAPE_COMMANDS = new Map<string, ComfortCommand>([
  [`${ESCAPE}[Z`, "detail-previous"],
  [`${ESCAPE}[A`, "move-up"],
  [`${ESCAPE}[B`, "move-down"],
  [`${ESCAPE}[C`, "exposure-right"],
  [`${ESCAPE}[D`, "exposure-left"],
  [`${ESCAPE}OA`, "move-up"],
  [`${ESCAPE}OB`, "move-down"],
  [`${ESCAPE}OC`, "exposure-right"],
  [`${ESCAPE}OD`, "exposure-left"],
]);

/**
 * The comfort card's strict raw-input decoder. A plain command must be the
 * complete chunk, so pasted text never invokes command keys; a lone Escape
 * resolves as `back` only after the grace timeout proves it is not the
 * start of a sequence; a bracketed paste is delivered whole as one payload
 * and its bytes never re-enter command decoding.
 */
export class ComfortInputParser {
  #buffer = "";
  #editor = false;
  #pasting = false;
  #paste = "";
  #timer: unknown;
  readonly #events: ComfortInputEvents;
  readonly #escapeTimeoutMs: number;
  readonly #setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;

  constructor(options: ComfortInputOptions) {
    this.#events = options.events;
    this.#escapeTimeoutMs =
      options.escapeTimeoutMs ?? COMFORT_ESCAPE_TIMEOUT_MS;
    this.#setTimeout = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.#clearTimeout =
      options.clearTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  feed(chunk: Buffer | string): void {
    const text =
      typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.#cancelTimer();
    this.#buffer += text;
    this.#drain();
  }

  /** While editing, plain keys are text and only the chord submits. */
  setEditorMode(enabled: boolean): void {
    this.#editor = enabled;
  }

  dispose(): void {
    this.#cancelTimer();
    this.#buffer = "";
    this.#pasting = false;
    this.#paste = "";
  }

  #drain(): void {
    for (;;) {
      if (this.#pasting) {
        const end = this.#buffer.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          this.#paste += this.#buffer;
          this.#buffer = "";
          return;
        }
        this.#paste += this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + BRACKETED_PASTE_END.length);
        this.#pasting = false;
        this.#events.paste(this.#paste);
        this.#paste = "";
        continue;
      }
      if (this.#buffer.length === 0) return;
      if (this.#buffer.startsWith(BRACKETED_PASTE_START)) {
        this.#buffer = this.#buffer.slice(BRACKETED_PASTE_START.length);
        this.#pasting = true;
        continue;
      }
      if (this.#buffer.startsWith(ESCAPE)) {
        const match = this.#matchEscape();
        if (match === "incomplete") {
          this.#armTimer();
          return;
        }
        if (match !== undefined) continue;
        // A complete non-command sequence, or a lone Escape: back.
        this.#resolveEscape();
        continue;
      }
      if (this.#editor) {
        this.#drainEditorText();
        continue;
      }
      // Plain keys: the whole remaining chunk must be exactly one command,
      // otherwise it is pasted or typed text and is discarded here.
      const command = DIRECT_COMMANDS.get(this.#buffer);
      this.#buffer = "";
      if (command !== undefined) this.#events.command(command);
      return;
    }
  }

  /**
   * Editor text: control keys become their commands, CR and LF cannot
   * submit, and every other character is literal field text — q, n, r, and
   * c included.
   */
  #drainEditorText(): void {
    let text = "";
    let index = 0;
    for (; index < this.#buffer.length; index += 1) {
      const character = this.#buffer[index]!;
      if (character === "\u001b") break;
      if (character === "\u0013") {
        this.#flushEditorText(text);
        text = "";
        this.#events.command("submit");
        continue;
      }
      if (character === "\u007f" || character === "\u0008") {
        this.#flushEditorText(text);
        text = "";
        this.#events.command("erase");
        continue;
      }
      if (character === "\u0003") {
        this.#flushEditorText(text);
        text = "";
        this.#events.command("quit");
        continue;
      }
      if (character === "\t") {
        this.#flushEditorText(text);
        text = "";
        this.#events.command("detail-next");
        continue;
      }
      if (character === "\r" || character === "\n") continue;
      text += character;
    }
    this.#flushEditorText(text);
    this.#buffer = this.#buffer.slice(index);
    if (this.#buffer.length === 0) return;
  }

  #flushEditorText(text: string): void {
    if (text.length > 0) this.#events.text?.(text);
  }

  #matchEscape(): ComfortCommand | "incomplete" | undefined {
    for (const [sequence, command] of ESCAPE_COMMANDS) {
      if (this.#buffer === sequence) {
        this.#buffer = "";
        this.#events.command(command);
        return command;
      }
      if (sequence.startsWith(this.#buffer)) return "incomplete";
    }
    if (BRACKETED_PASTE_START.startsWith(this.#buffer)) return "incomplete";
    return undefined;
  }

  #resolveEscape(): void {
    if (this.#buffer === ESCAPE) {
      this.#buffer = "";
      this.#events.command("back");
      return;
    }
    // Discard the unrecognized sequence up to its final byte.
    this.#buffer = "";
  }

  #armTimer(): void {
    this.#timer = this.#setTimeout(() => {
      this.#timer = undefined;
      if (this.#buffer === ESCAPE) {
        this.#buffer = "";
        this.#events.command("back");
      } else {
        this.#buffer = "";
      }
    }, this.#escapeTimeoutMs);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
