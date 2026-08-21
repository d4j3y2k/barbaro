/** Values accepted without transformation by the stable JSON serializer. */
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * Compare strings by their UTF-16 code units, independent of host locale and
 * ICU data. This is the ordering used by JavaScript's default string sort, but
 * an explicit comparator keeps canonical record ordering deliberate.
 */
export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Serialize JSON with object keys sorted lexicographically at every depth.
 * Arrays retain source order. Undefined object properties are omitted and
 * undefined array elements become null, matching JSON.stringify.
 *
 * Non-finite numbers, BigInts, cycles, and non-plain objects are rejected so
 * they cannot silently produce unstable or lossy interchange records.
 */
export function stableStringify(value: unknown): string {
  const encoded = encodeJson(value, new Set<object>(), "$", false);
  if (encoded === undefined) {
    throw new TypeError("The top-level value is not JSON-serializable");
  }
  return encoded;
}

/** Serialize one deterministic, newline-terminated JSONL record. */
export function stableJsonLine(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

function encodeJson(
  value: unknown,
  ancestors: Set<object>,
  path: string,
  arrayElement: boolean,
): string | undefined {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${path}`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "undefined":
    case "function":
    case "symbol":
      return arrayElement ? "null" : undefined;
    case "bigint":
      throw new TypeError(`BigInt is not valid JSON at ${path}`);
    case "object":
      break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    throw new TypeError(`Circular JSON value at ${path}`);
  }

  ancestors.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      const items: string[] = [];
      for (let index = 0; index < objectValue.length; index += 1) {
        items.push(
          encodeJson(
            objectValue[index],
            ancestors,
            `${path}[${index}]`,
            true,
          ) ?? "null",
        );
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(objectValue) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object is not valid stable JSON at ${path}`);
    }

    const properties: string[] = [];
    for (const key of Object.keys(objectValue).sort(compareUtf16CodeUnits)) {
      const propertyValue = (objectValue as Record<string, unknown>)[key];
      const encodedValue = encodeJson(
        propertyValue,
        ancestors,
        `${path}.${key}`,
        false,
      );
      if (encodedValue !== undefined) {
        properties.push(`${JSON.stringify(key)}:${encodedValue}`);
      }
    }
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
}
