import { canonicalJsonV2 } from "./canonical-json-v2.ts";
import { ApiError } from "./errors.ts";

export const MAX_COMMAND_BYTES = 262_144;
export const MAX_COLLECTION_ITEMS = 256;
const CREDENTIAL = /(?:api[_-]?key|access[_-]?token|password|secret|authorization|bearer)\s*[:=]\s*\S+/iu;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const ABSOLUTE_PATH = /(?:^|[\s"'=:{(\[,])(?:\/(?!\/)[A-Za-z0-9._~-]+(?:\/[^\s"'<>]*)?|[A-Za-z]:[\\/][^\s"'<>]+|~[\\/][^\s"'<>]+)/u;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const assertSafeText = (value: unknown, field: string, maximum = 16_384, forbiddenOccurrences: string[] = []): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new ApiError(422, "invalid_request", `${field} must be non-empty.`);
  if (value.length > maximum) throw new ApiError(413, "payload_too_large", `${field} is too large.`);
  if (UNSAFE_CONTROL.test(value) || CREDENTIAL.test(value) || PRIVATE_KEY.test(value) || ABSOLUTE_PATH.test(value) || forbiddenOccurrences.some((item) => item.length > 0 && value.includes(item))) throw new ApiError(422, "sensitive_text_rejected", `${field} contains unsafe or sensitive text.`);
  return value;
};

export const assertBoundedCommand = (command: unknown, forbiddenOccurrences: string[] = []): void => {
  let bytes: Buffer;
  try { bytes = canonicalJsonV2(command); } catch { throw new ApiError(422, "validation_error", "The command is not valid canonical JSON."); }
  if (bytes.byteLength > MAX_COMMAND_BYTES) throw new ApiError(413, "payload_too_large", "The command is too large.");
  const visit = (value: unknown): void => {
    if (typeof value === "string") { if (UNSAFE_CONTROL.test(value) || CREDENTIAL.test(value) || PRIVATE_KEY.test(value) || ABSOLUTE_PATH.test(value) || forbiddenOccurrences.some((item) => item.length > 0 && value.includes(item))) throw new ApiError(422, "sensitive_text_rejected", "The command contains unsafe or sensitive text."); return; }
    if (!value || typeof value !== "object") return;
    const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_ITEMS) throw new ApiError(413, "payload_too_large", "A command collection is too large.");
    entries.forEach(visit);
  };
  visit(command);
};

export const safeFailure = (failure: { code: unknown; safe_message: unknown }, forbiddenOccurrences: string[] = []): { code: string; safe_message: string } => ({
  code: assertSafeText(failure.code, "failure.code", 128).replace(/[^a-z0-9_.-]/giu, "_"),
  safe_message: assertSafeText(failure.safe_message, "failure.safe_message", 512, forbiddenOccurrences),
});
