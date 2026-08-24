const RESET_STYLE = "\u001b[0m";
const DEFAULT_ELLIPSIS = "…";

const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

const markPattern = /^\p{Mark}$/u;
const emojiPresentationPattern = /\p{Emoji_Presentation}/u;
const regionalIndicatorPattern = /\p{Regional_Indicator}/u;
const defaultIgnorablePattern = /^\p{Default_Ignorable_Code_Point}$/u;
const sgrResetCategories = new Map<number, string>([
  [10, "font"],
  [22, "intensity"],
  [23, "italic"],
  [24, "underline"],
  [25, "blink"],
  [27, "inverse"],
  [28, "conceal"],
  [29, "strike"],
  [39, "foreground"],
  [49, "background"],
  [54, "frame"],
  [55, "overline"],
  [59, "underline-color"],
  [65, "ideogram"],
  [75, "script"],
]);

export interface ClipTerminalTextOptions {
  readonly ellipsis?: string;
}

interface TextToken {
  readonly kind: "text";
  readonly value: string;
  readonly width: number;
}

interface SgrToken {
  readonly kind: "sgr";
  readonly value: string;
}

type TerminalToken = TextToken | SgrToken;

/**
 * Make untrusted text inert when printed in a terminal.
 *
 * Terminal control strings and control-character runs become one ordinary
 * space. Existing ordinary whitespace is otherwise retained. Call this before
 * adding generated SGR styling.
 */
export function sanitizeTerminalText(text: string): string {
  let result = "";
  let cursor = 0;
  let controlBoundary = false;

  const appendSafe = (value: string): void => {
    if (controlBoundary) {
      if (!result.endsWith(" ") && value !== " ") result += " ";
      controlBoundary = false;
    }
    result += value;
  };

  while (cursor < text.length) {
    const codePoint = text.codePointAt(cursor)!;
    if (codePoint === 0x1b) {
      cursor = consumeEscapeSequence(text, cursor);
      controlBoundary = true;
      continue;
    }
    if (codePoint === 0x9b) {
      cursor = consumeCsi(text, cursor + 1);
      controlBoundary = true;
      continue;
    }
    if (codePoint === 0x9d) {
      cursor = consumeControlString(text, cursor + 1, true);
      controlBoundary = true;
      continue;
    }
    if (
      codePoint === 0x90 ||
      codePoint === 0x98 ||
      codePoint === 0x9e ||
      codePoint === 0x9f
    ) {
      cursor = consumeControlString(text, cursor + 1, false);
      controlBoundary = true;
      continue;
    }
    if (isTerminalControl(codePoint)) {
      cursor += codePoint > 0xffff ? 2 : 1;
      controlBoundary = true;
      continue;
    }

    const character = String.fromCodePoint(codePoint);
    appendSafe(character);
    cursor += character.length;
  }

  if (controlBoundary && !result.endsWith(" ")) result += " ";
  return result;
}

/** Return the number of terminal cells occupied by text and trusted SGR. */
export function terminalCellWidth(text: string): number {
  return terminalTokens(text).reduce(
    (width, token) => width + (token.kind === "text" ? token.width : 0),
    0,
  );
}

/**
 * Clip text to a terminal-cell budget without splitting grapheme clusters or
 * SGR sequences. Clipped, active styling is reset before returning.
 */
export function clipTerminalText(
  text: string,
  width: number,
  options: ClipTerminalTextOptions = {},
): string {
  const limit = cellLimit(width);
  if (limit === 0) return "";

  const tokens = terminalTokens(text);
  const measured = tokenWidth(tokens);
  if (measured <= limit) return closeActiveStyle(tokens);

  const ellipsisTokens = terminalTokens(
    sanitizeTerminalText(options.ellipsis ?? DEFAULT_ELLIPSIS).trim(),
  ).filter((token): token is TextToken => token.kind === "text");
  const shownEllipsis = takeTextCells(ellipsisTokens, limit);
  const ellipsisWidth = tokenWidth(shownEllipsis);
  const contentLimit = limit - ellipsisWidth;
  if (contentLimit <= 0) return joinTokens(shownEllipsis);

  const shown: TerminalToken[] = [];
  const styles = new Set<string>();
  let used = 0;
  for (const token of tokens) {
    if (token.kind === "sgr") {
      shown.push(token);
      updateStyleState(styles, token.value);
      continue;
    }
    if (used + token.width > contentLimit) break;
    shown.push(token);
    used += token.width;
  }

  let result = `${joinTokens(shown)}${joinTokens(shownEllipsis)}`;
  if (styles.size > 0) result += RESET_STYLE;
  return result;
}

/**
 * Add ordinary spaces until text reaches the requested cell width. Longer text
 * is left intact; use clipTerminalText first when an exact bound is required.
 */
export function padTerminalText(text: string, width: number): string {
  const limit = cellLimit(width);
  const tokens = terminalTokens(text);
  const measured = tokenWidth(tokens);
  let result = joinTokens(tokens);
  const styles = styleState(tokens);
  if (styles.size > 0) result += RESET_STYLE;
  return `${result}${" ".repeat(Math.max(0, limit - measured))}`;
}

function terminalTokens(text: string): TerminalToken[] {
  const tokens: TerminalToken[] = [];
  let cursor = 0;
  let textStart = 0;

  const appendText = (value: string): void => {
    const safe = sanitizeTerminalText(value);
    for (const part of graphemeSegmenter.segment(safe)) {
      tokens.push({
        kind: "text",
        value: part.segment,
        width: graphemeCellWidth(part.segment),
      });
    }
  };

  while (cursor < text.length) {
    const sgr = sgrAt(text, cursor);
    if (sgr === undefined) {
      const codePoint = text.codePointAt(cursor)!;
      cursor += codePoint > 0xffff ? 2 : 1;
      continue;
    }
    appendText(text.slice(textStart, cursor));
    tokens.push({ kind: "sgr", value: sgr });
    cursor += sgr.length;
    textStart = cursor;
  }
  appendText(text.slice(textStart));
  return tokens;
}

function sgrAt(text: string, cursor: number): string | undefined {
  if (text.charCodeAt(cursor) !== 0x1b || text.charCodeAt(cursor + 1) !== 0x5b) {
    return undefined;
  }
  let end = cursor + 2;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (code === 0x6d) return text.slice(cursor, end + 1);
    if (
      (code < 0x30 || code > 0x39) &&
      code !== 0x3b &&
      code !== 0x3a
    ) {
      return undefined;
    }
    end += 1;
  }
  return undefined;
}

function consumeEscapeSequence(text: string, start: number): number {
  const introducer = text.charCodeAt(start + 1);
  switch (introducer) {
    case 0x5b:
      return consumeCsi(text, start + 2);
    case 0x5d:
      return consumeControlString(text, start + 2, true);
    case 0x50:
    case 0x58:
    case 0x5e:
    case 0x5f:
      return consumeControlString(text, start + 2, false);
    default:
      break;
  }

  let cursor = start + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code < 0x20 || code > 0x2f) return cursor;
  }
  return cursor;
}

function consumeCsi(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) return cursor;
  }
  return cursor;
}

function consumeControlString(
  text: string,
  start: number,
  bellTerminates: boolean,
): number {
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (bellTerminates && code === 0x07) return cursor + 1;
    if (code === 0x9c) return cursor + 1;
    if (
      code === 0x1b &&
      cursor + 1 < text.length &&
      text.charCodeAt(cursor + 1) === 0x5c
    ) {
      return cursor + 2;
    }
    cursor += 1;
  }
  return cursor;
}

function isTerminalControl(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0x2066 && codePoint <= 0x206f)
  );
}

function graphemeCellWidth(grapheme: string): number {
  if (
    emojiPresentationPattern.test(grapheme) ||
    regionalIndicatorPattern.test(grapheme) ||
    grapheme.includes("\ufe0f") ||
    grapheme.includes("\u20e3")
  ) {
    return 2;
  }

  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0)!;
    if (
      markPattern.test(character) ||
      defaultIgnorablePattern.test(character) ||
      isTerminalControl(codePoint) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    ) {
      continue;
    }
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function takeTextCells(tokens: readonly TextToken[], limit: number): TextToken[] {
  const shown: TextToken[] = [];
  let used = 0;
  for (const token of tokens) {
    if (used + token.width > limit) break;
    shown.push(token);
    used += token.width;
  }
  return shown;
}

function tokenWidth(tokens: readonly TerminalToken[]): number {
  return tokens.reduce(
    (width, token) => width + (token.kind === "text" ? token.width : 0),
    0,
  );
}

function joinTokens(tokens: readonly TerminalToken[]): string {
  return tokens.map((token) => token.value).join("");
}

function styleState(tokens: readonly TerminalToken[]): Set<string> {
  const styles = new Set<string>();
  for (const token of tokens) {
    if (token.kind === "sgr") updateStyleState(styles, token.value);
  }
  return styles;
}

function closeActiveStyle(tokens: readonly TerminalToken[]): string {
  const text = joinTokens(tokens);
  return styleState(tokens).size === 0 ? text : `${text}${RESET_STYLE}`;
}

function updateStyleState(styles: Set<string>, sgr: string): void {
  const body = sgr.slice(2, -1);
  const parameters = body.length === 0 ? ["0"] : body.split(";");
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]!;
    const code = Number.parseInt(parameter.split(":", 1)[0] ?? "", 10);
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      styles.clear();
      continue;
    }
    if (code === 38 || code === 48 || code === 58) {
      const category =
        code === 38
          ? "foreground"
          : code === 48
            ? "background"
            : "underline-color";
      styles.add(category);
      if (!parameter.includes(":")) {
        const mode = Number.parseInt(parameters[index + 1] ?? "", 10);
        if (mode === 5) index += 2;
        if (mode === 2) index += 4;
      }
      continue;
    }
    const category = styleCategory(code);
    if (category === undefined) {
      styles.add(`unknown-${code}`);
    } else if (category.startsWith("reset:")) {
      styles.delete(category.slice(6));
    } else {
      styles.add(category);
    }
  }
}

function styleCategory(code: number): string | undefined {
  if (code === 1 || code === 2) return "intensity";
  if (code === 3) return "italic";
  if (code === 4 || code === 21) return "underline";
  if (code === 5 || code === 6) return "blink";
  if (code === 7) return "inverse";
  if (code === 8) return "conceal";
  if (code === 9) return "strike";
  if (code >= 11 && code <= 19) return "font";
  if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
    return "foreground";
  }
  if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
    return "background";
  }
  if (code === 51 || code === 52) return "frame";
  if (code === 53) return "overline";
  if (code >= 60 && code <= 64) return "ideogram";
  if (code === 73 || code === 74) return "script";

  const reset = sgrResetCategories.get(code);
  return reset === undefined ? undefined : `reset:${reset}`;
}

function cellLimit(width: number): number {
  if (!Number.isFinite(width)) {
    throw new RangeError("terminal width must be finite");
  }
  return Math.max(0, Math.floor(width));
}
