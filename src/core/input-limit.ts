/** A physical input bound, distinct from bad options or corrupt state. */
export class InputLimitError extends RangeError {
  constructor(
    message: string,
    readonly kind: "file" | "record",
    readonly maximumBytes: number,
    /** Bytes actually observed at refusal; a record may continue beyond this count. */
    readonly observedBytes?: number,
  ) {
    super(message);
    this.name = "InputLimitError";
  }
}
