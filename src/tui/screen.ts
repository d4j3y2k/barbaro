const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const HIDE_CURSOR = "\u001b[?25l";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const CURSOR_HOME = "\u001b[H";
const CLEAR_SCREEN = "\u001b[2J";
const ERASE_BELOW = "\u001b[J";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
const SHOW_CURSOR = "\u001b[?25h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";

const ENTER_SEQUENCE = `${ENTER_ALTERNATE_SCREEN}${HIDE_CURSOR}${ENABLE_BRACKETED_PASTE}${CURSOR_HOME}${CLEAR_SCREEN}`;
const LEAVE_SEQUENCE = `${DISABLE_BRACKETED_PASTE}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`;

export interface TerminalScreenWriter {
  write(chunk: string): unknown;
}

type TerminalScreenState = "idle" | "active" | "left";

/**
 * Own the terminal control sequences for one alternate-screen lifecycle.
 *
 * Lifecycle transitions happen before the injected writer is called. If a
 * write throws, setup or cleanup is therefore never emitted a second time by
 * retrying the same lifecycle method. A failed draw leaves the screen active
 * so callers can still perform cleanup.
 */
export class TerminalScreen {
  private state: TerminalScreenState = "idle";

  public constructor(private readonly writer: TerminalScreenWriter) {}

  /** Enter the alternate screen at most once. Calls after entry or exit are no-ops. */
  public enter(): void {
    if (this.state !== "idle") return;
    this.state = "active";
    this.writer.write(ENTER_SEQUENCE);
  }

  /**
   * Redraw an already-padded frame without performing another full clear.
   *
   * Drawing outside the active lifecycle is a programming error. Repeated
   * draws are allowed and each one emits a complete redraw sequence.
   */
  public draw(frame: string): void {
    if (this.state === "idle") {
      throw new Error("cannot draw before entering the terminal screen");
    }
    if (this.state === "left") {
      throw new Error("cannot draw after leaving the terminal screen");
    }
    this.writer.write(`${CURSOR_HOME}${frame}${ERASE_BELOW}`);
  }

  /** Leave an entered screen at most once; leaving an idle screen is a no-op. */
  public leave(): void {
    if (this.state !== "active") return;
    this.state = "left";
    this.writer.write(LEAVE_SEQUENCE);
  }
}
