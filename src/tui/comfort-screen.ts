import { SGR_RESET } from "./style.js";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const HIDE_CURSOR = "\u001b[?25l";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const CURSOR_HOME = "\u001b[H";
const CLEAR_SCREEN = "\u001b[2J";
const ERASE_BELOW = "\u001b[J";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const SHOW_CURSOR = "\u001b[?25h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";

const ENTER_SEQUENCE =
  `${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${ENABLE_BRACKETED_PASTE}` +
  `${CURSOR_HOME}${CLEAR_SCREEN}`;
/**
 * The terminal cleanup invariant carried from Appendix C: styling is reset
 * with SGR 0 strictly before the alternate screen is left, so no attribute
 * ever leaks onto the shell that resumes underneath.
 */
const LEAVE_SEQUENCE =
  `${SGR_RESET}${DISABLE_BRACKETED_PASTE}${SHOW_CURSOR}` +
  `${LEAVE_ALTERNATE_SCREEN}`;

export interface ComfortScreenWriter {
  write(chunk: string): unknown;
}

type ComfortScreenState = "idle" | "active" | "left";

/** One alternate-screen lifecycle: enter at most once, leave at most once. */
export class ComfortScreen {
  #state: ComfortScreenState = "idle";
  readonly #writer: ComfortScreenWriter;

  constructor(writer: ComfortScreenWriter) {
    this.#writer = writer;
  }

  enter(): void {
    if (this.#state !== "idle") return;
    this.#state = "active";
    this.#writer.write(ENTER_SEQUENCE);
  }

  draw(frame: string): void {
    if (this.#state !== "active") {
      throw new Error("cannot draw outside the active screen lifecycle");
    }
    this.#writer.write(`${CURSOR_HOME}${frame}${ERASE_BELOW}`);
  }

  leave(): void {
    if (this.#state !== "active") return;
    this.#state = "left";
    this.#writer.write(LEAVE_SEQUENCE);
  }
}

export const COMFORT_SCREEN_SEQUENCES = {
  enter: ENTER_SEQUENCE,
  leave: LEAVE_SEQUENCE,
  sgrReset: SGR_RESET,
  leaveAlternate: LEAVE_ALTERNATE_SCREEN,
} as const;
