import { constants, type PathLike } from "node:fs";
import { InputLimitError } from "./input-limit.js";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  type CheckpointAnchor,
  type FileIdentity,
  readCheckpointAnchor,
  snapshotFromStats,
} from "./checkpoint.js";

export interface JsonlReadOptions<T> {
  /** First byte to read. It must point to the start of a physical line. */
  readonly startOffset?: number;
  /** One-based physical line number corresponding to startOffset. */
  readonly nextLineNumber?: number;
  /**
   * Last byte to consider present, exclusive.
   *
   * A live trace grows while it is read, so "read to EOF" is not a snapshot:
   * the bytes consumed depend on when the reader happened to finish. Pinning
   * the end to a size observed up front makes the read reproducible, and a
   * line straddling the boundary is reported as a partial final line rather
   * than half-consumed.
   */
  readonly endOffset?: number;
  /** Pin an omitted endOffset to the size observed on the opened handle. */
  readonly pinEnd?: boolean;
  /** Optional parser layered over JSON.parse. */
  readonly parse?: (raw: string) => T;
  readonly highWaterMark?: number;
  readonly signal?: AbortSignal;
  /** Refuse a final-path symbolic link at open time. */
  readonly noFollow?: boolean;
  /** Refuse files with another hard link. */
  readonly requireSingleLink?: boolean;
  /** Bound the whole physical file observed by this read. */
  readonly maxFileBytes?: number;
  /** Bound one physical line before allocation/decoding. */
  readonly maxLineBytes?: number;
}

export interface JsonlLineBase {
  readonly lineNumber: number;
  readonly byteStart: number;
  /** Offset immediately after the terminating LF byte. */
  readonly byteEndExclusive: number;
  /** Alias for byteEndExclusive, suitable for the next checkpoint. */
  readonly nextOffset: number;
  /** Decoded line content without LF or an optional preceding CR. */
  readonly raw: string;
}

export interface ParsedJsonlLine<T> extends JsonlLineBase {
  readonly kind: "record";
  readonly value: T;
}

export interface JsonlLineError {
  readonly name: string;
  readonly message: string;
}

export interface MalformedJsonlLine extends JsonlLineBase {
  readonly kind: "malformed";
  readonly error: JsonlLineError;
}

export type JsonlLine<T> = ParsedJsonlLine<T> | MalformedJsonlLine;

export interface PartialJsonlLine {
  readonly byteStart: number;
  readonly byteLength: number;
  readonly lineNumber: number;
}

export interface JsonlReadSummary {
  readonly fileIdentity: FileIdentity;
  readonly observedSize: number;
  readonly startOffset: number;
  /** First byte not committed; partial EOF bytes remain at this offset. */
  readonly checkpointOffset: number;
  readonly nextLineNumber: number;
  readonly checkpointAnchor: CheckpointAnchor;
  readonly bytesRead: number;
  readonly completeLines: number;
  readonly parsedLines: number;
  readonly malformedLines: number;
  readonly partialFinalLine?: PartialJsonlLine;
}

export type JsonlLineVisitor<T> = (
  line: JsonlLine<T>,
) => void | Promise<void>;

/**
 * Iterate complete physical JSONL lines from a byte offset. Malformed complete
 * lines are yielded as data rather than thrown. An unterminated final line is
 * reported in the summary and deliberately left outside the checkpoint.
 */
export async function* iterateJsonlForward<T = unknown>(
  filePath: PathLike,
  options: JsonlReadOptions<T> = {},
): AsyncGenerator<JsonlLine<T>, JsonlReadSummary, void> {
  const startOffset = options.startOffset ?? 0;
  const firstLineNumber = options.nextLineNumber ?? 1;
  assertSafeNonNegativeInteger(startOffset, "startOffset");
  assertSafePositiveInteger(firstLineNumber, "nextLineNumber");
  let endOffset = options.endOffset;
  if (endOffset !== undefined) {
    assertSafeNonNegativeInteger(endOffset, "endOffset");
    if (endOffset < startOffset) {
      throw new RangeError("endOffset must not precede startOffset");
    }
  }
  if (
    options.highWaterMark !== undefined &&
    (!Number.isSafeInteger(options.highWaterMark) || options.highWaterMark < 1)
  ) {
    throw new RangeError("highWaterMark must be a positive safe integer");
  }
  if (options.pinEnd !== undefined && typeof options.pinEnd !== "boolean") {
    throw new TypeError("pinEnd must be a boolean");
  }
  assertOptionalSafeNonNegativeInteger(
    options.maxFileBytes,
    "maxFileBytes",
  );
  assertOptionalSafeNonNegativeInteger(
    options.maxLineBytes,
    "maxLineBytes",
  );

  const handle = await open(filePath, readFlags(options.noFollow));
  try {
    const initialStats = await handle.stat({ bigint: true });
    if (options.requireSingleLink === true && initialStats.nlink !== 1n) {
      throw new TypeError("JSONL path has multiple hard links");
    }
    const initialSnapshot = snapshotFromStats(initialStats);
    if (
      options.maxFileBytes !== undefined &&
      initialSnapshot.size > options.maxFileBytes
    ) {
      throw new InputLimitError(`JSONL path exceeds ${options.maxFileBytes} bytes`, "file", options.maxFileBytes, initialSnapshot.size);
    }
    if (startOffset > initialSnapshot.size) {
      throw new RangeError("startOffset is beyond the current end of the file");
    }
    if (options.pinEnd === true && endOffset === undefined) {
      endOffset = initialSnapshot.size;
    }
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }

  let stream: ReturnType<typeof handle.createReadStream> | Readable;
  try {
    stream =
      endOffset === startOffset
        ? Readable.from([])
        : handle.createReadStream({
            autoClose: false,
            start: startOffset,
            ...(endOffset === undefined ? {} : { end: endOffset - 1 }),
            ...(options.highWaterMark === undefined
              ? {}
              : { highWaterMark: options.highWaterMark }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }

  const parser = options.parse ?? ((raw: string) => JSON.parse(raw) as T);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let bytesRead = 0;
  let checkpointOffset = startOffset;
  let nextLineNumber = firstLineNumber;
  let completeLines = 0;
  let parsedLines = 0;
  let malformedLines = 0;

  try {
    let reachedEnd = false;
    for await (const streamChunk of stream) {
      // Past the pinned boundary the remaining bytes are drained but ignored.
      // Breaking out of the iterator would destroy the stream and close the
      // handle the summary's anchor read still needs.
      if (reachedEnd) continue;
      const chunk = Buffer.isBuffer(streamChunk)
        ? streamChunk
        : Buffer.from(streamChunk);
      bytesRead += chunk.byteLength;
      let segmentStart = 0;
      let newlineIndex = chunk.indexOf(0x0a, segmentStart);

      while (newlineIndex !== -1) {
        const segment = chunk.subarray(segmentStart, newlineIndex);
        assertLineWithinLimit(
          fragmentBytes + segment.byteLength,
          options.maxLineBytes,
        );
        if (
          endOffset !== undefined &&
          checkpointOffset + fragmentBytes + segment.byteLength + 1 > endOffset
        ) {
          // This line ends past the pinned boundary: it is not part of the
          // snapshot. Whatever precedes it is reported as a partial tail.
          fragments.push(segment);
          fragmentBytes += segment.byteLength;
          segmentStart = chunk.byteLength;
          reachedEnd = true;
          break;
        }
        let lineBytes: Buffer;
        if (fragments.length === 0) {
          lineBytes = segment;
        } else {
          fragments.push(segment);
          lineBytes = Buffer.concat(fragments, fragmentBytes + segment.byteLength);
        }

        const lineNumber = nextLineNumber;
        const byteStart = checkpointOffset;
        const byteEndExclusive =
          byteStart + lineBytes.byteLength + 1;
        const contentBytes =
          lineBytes.at(-1) === 0x0d
            ? lineBytes.subarray(0, lineBytes.byteLength - 1)
            : lineBytes;

        fragments = [];
        fragmentBytes = 0;
        checkpointOffset = byteEndExclusive;
        nextLineNumber += 1;
        completeLines += 1;

        let raw: string;
        let event: JsonlLine<T>;
        try {
          raw = decoder.decode(contentBytes);
          const value = parser(raw);
          parsedLines += 1;
          event = {
            kind: "record",
            value,
            raw,
            lineNumber,
            byteStart,
            byteEndExclusive,
            nextOffset: byteEndExclusive,
          };
        } catch (error: unknown) {
          malformedLines += 1;
          raw = contentBytes.toString("utf8");
          event = {
            kind: "malformed",
            error: describeError(error),
            raw,
            lineNumber,
            byteStart,
            byteEndExclusive,
            nextOffset: byteEndExclusive,
          };
        }

        yield event;
        segmentStart = newlineIndex + 1;
        newlineIndex = chunk.indexOf(0x0a, segmentStart);
      }

      if (segmentStart < chunk.byteLength) {
        const remainder = chunk.subarray(segmentStart);
        assertLineWithinLimit(
          fragmentBytes + remainder.byteLength,
          options.maxLineBytes,
        );
        fragments.push(remainder);
        fragmentBytes += remainder.byteLength;
      }
      if (endOffset !== undefined && checkpointOffset >= endOffset) {
        reachedEnd = true;
      }
    }

    const finalStats = await handle.stat({ bigint: true });
    if (options.requireSingleLink === true && finalStats.nlink !== 1n) {
      throw new TypeError("JSONL path gained another hard link during read");
    }
    const finalSnapshot = snapshotFromStats(finalStats);
    if (
      options.maxFileBytes !== undefined &&
      finalSnapshot.size > options.maxFileBytes
    ) {
      throw new InputLimitError(`JSONL path exceeds ${options.maxFileBytes} bytes`, "file", options.maxFileBytes, finalSnapshot.size);
    }
    if (finalSnapshot.size < checkpointOffset) {
      throw new RangeError("JSONL file was truncated while it was being read");
    }
    const checkpointAnchor = await readCheckpointAnchor(
      handle,
      checkpointOffset,
    );
    const partialFinalLine =
      fragmentBytes === 0
        ? undefined
        : {
            byteStart: checkpointOffset,
            byteLength: fragmentBytes,
            lineNumber: nextLineNumber,
          };

    return {
      fileIdentity: finalSnapshot.identity,
      observedSize: finalSnapshot.size,
      startOffset,
      checkpointOffset,
      nextLineNumber,
      checkpointAnchor,
      bytesRead,
      completeLines,
      parsedLines,
      malformedLines,
      ...(partialFinalLine === undefined ? {} : { partialFinalLine }),
    };
  } finally {
    stream.destroy();
    await handle.close();
  }
}

function readFlags(noFollow: boolean | undefined): string | number {
  if (noFollow !== true) return "r";
  const flag = constants.O_NOFOLLOW;
  if (typeof flag !== "number") {
    throw new TypeError("This platform cannot refuse JSONL symlinks");
  }
  return constants.O_RDONLY | flag;
}

function assertLineWithinLimit(
  byteLength: number,
  maximumBytes: number | undefined,
): void {
  if (maximumBytes !== undefined && byteLength > maximumBytes) {
    throw new InputLimitError(`JSONL line exceeds ${maximumBytes} bytes`, "record", maximumBytes, byteLength);
  }
}

function assertOptionalSafeNonNegativeInteger(
  value: number | undefined,
  name: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

/** Callback facade for consumers that prefer a returned summary. */
export async function readJsonlForward<T = unknown>(
  filePath: PathLike,
  onLine: JsonlLineVisitor<T>,
  options: JsonlReadOptions<T> = {},
): Promise<JsonlReadSummary> {
  const iterator = iterateJsonlForward(filePath, options);
  let finished = false;
  try {
    while (true) {
      const result = await iterator.next();
      if (result.done) {
        finished = true;
        return result.value;
      }
      await onLine(result.value);
    }
  } finally {
    if (!finished) {
      await iterator.return(undefined as never);
    }
  }
}

function describeError(error: unknown): JsonlLineError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function assertSafeNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function assertSafePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
