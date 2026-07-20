import { createHash } from "node:crypto";

export const CANONICAL_JSON_V2 = "riff-canonical-json-v2" as const;
export type CanonicalJsonScalar = null | boolean | number | string;
export type CanonicalJson = CanonicalJsonScalar | CanonicalJson[] | { [key: string]: CanonicalJson };
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const assertString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("lone surrogate is not canonical JSON");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("lone surrogate is not canonical JSON");
    }
  }
};

const encodeString = (value: string): string => {
  assertString(value);
  return JSON.stringify(value);
};

const encode = (value: unknown, seen: Set<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return typeof value === "string" ? encodeString(value) : String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number is not canonical JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object" || value === undefined) throw new TypeError("unsupported canonical JSON value");
  if (seen.has(value)) throw new TypeError("cyclic value is not canonical JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, seen)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON requires plain objects");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(); // ECMAScript compares UTF-16 code units.
    if (keys.some((key) => DANGEROUS_KEYS.has(key))) throw new TypeError("dangerous object key is not canonical JSON");
    return `{${keys.map((key) => `${encodeString(key)}:${encode(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

export const canonicalJsonV2 = (value: unknown): Buffer => Buffer.from(encode(value, new Set()), "utf8");
export const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export const canonicalDigest = (value: unknown): string => sha256Hex(canonicalJsonV2(value));

export const digestRecord = <T extends Record<string, unknown>>(prefix: string, field: keyof T & string, record: T): string => {
  const unsigned = { ...record };
  delete unsigned[field];
  return `${prefix}${canonicalDigest(unsigned)}`;
};

export const contentId = <T extends Record<string, unknown>>(prefix: string, idField: keyof T & string, record: T): string =>
  digestRecord(prefix, idField, record);

/** Parse JSON while rejecting duplicate object keys before canonicalization. */
export const parseCanonicalJsonV2 = (text: string): CanonicalJson => {
  let cursor = 0;
  const fail = (): never => { throw new SyntaxError("invalid canonical JSON input"); };
  const ws = (): void => { while (/^[\u0009\u000a\u000d\u0020]$/u.test(text[cursor] ?? "")) cursor += 1; };
  const parseString = (): string => {
    if (text[cursor] !== '"') fail();
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '"') {
        const value = JSON.parse(text.slice(start, cursor)) as string;
        assertString(value);
        return value;
      }
      if (char === "\\") {
        if (cursor >= text.length) fail();
        const escaped = text[cursor++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(cursor, cursor + 4))) fail();
          cursor += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) fail();
      } else if (char.charCodeAt(0) < 0x20) fail();
    }
    return fail();
  };
  const value = (): CanonicalJson => {
    ws();
    if (text[cursor] === '"') return parseString();
    if (text[cursor] === "[") {
      cursor += 1; ws();
      const result: CanonicalJson[] = [];
      if (text[cursor] === "]") { cursor += 1; return result; }
      while (true) {
        result.push(value()); ws();
        if (text[cursor] === "]") { cursor += 1; return result; }
        if (text[cursor++] !== ",") fail();
      }
    }
    if (text[cursor] === "{") {
      cursor += 1; ws();
      const result: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
      const keys = new Set<string>();
      if (text[cursor] === "}") { cursor += 1; return result; }
      while (true) {
        ws(); const key = parseString();
        if (keys.has(key) || DANGEROUS_KEYS.has(key)) fail();
        keys.add(key); ws();
        if (text[cursor++] !== ":") fail();
        result[key] = value(); ws();
        if (text[cursor] === "}") { cursor += 1; return result; }
        if (text[cursor++] !== ",") fail();
      }
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(token, cursor)) { cursor += token.length; return result; }
    }
    const match = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (!match) return fail();
    cursor += match[0].length;
    const numeric = Number(match[0]);
    if (!Number.isFinite(numeric) || (!/[.eE]/u.test(match[0]) && !Number.isSafeInteger(numeric))) fail();
    return numeric;
  };
  const result = value(); ws();
  if (cursor !== text.length) fail();
  canonicalJsonV2(result);
  return result;
};
