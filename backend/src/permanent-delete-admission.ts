import { randomBytes } from "node:crypto";
import type { ProductLifecycleKind } from "./product-domain.ts";

const TOKEN_TTL_MS = 5 * 60 * 1_000;

type ConfirmationBinding = Readonly<{
  generation: number;
  kind: ProductLifecycleKind;
  id: string;
  previewToken: string;
  stateToken: string;
  recordCount: number;
  fileCount: number;
  totalBytes: number;
  expiresAtMs: number;
}>;

export class PermanentDeleteAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentDeleteAdmissionError";
  }
}

export class PermanentDeleteAdmission {
  readonly #now: () => number;
  readonly #tokens = new Map<string, ConfirmationBinding>();

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  issue(binding: Omit<ConfirmationBinding, "expiresAtMs">): {
    confirmationToken: string;
    expiresAt: string;
  } {
    this.#purgeExpired();
    const confirmationToken = randomBytes(32).toString("base64url");
    const expiresAtMs = this.#now() + TOKEN_TTL_MS;
    this.#tokens.set(confirmationToken, Object.freeze({
      ...binding,
      expiresAtMs,
    }));
    return {
      confirmationToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consume(
    confirmationToken: string,
    expected: Omit<ConfirmationBinding, "expiresAtMs">,
  ): void {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(confirmationToken)) {
      throw new PermanentDeleteAdmissionError(
        "Permanent-delete confirmation is invalid.",
      );
    }
    const binding = this.#tokens.get(confirmationToken);
    if (binding) this.#tokens.delete(confirmationToken);
    if (!binding || binding.expiresAtMs <= this.#now()
      || binding.generation !== expected.generation
      || binding.kind !== expected.kind || binding.id !== expected.id
      || binding.previewToken !== expected.previewToken
      || binding.stateToken !== expected.stateToken
      || binding.recordCount !== expected.recordCount
      || binding.fileCount !== expected.fileCount
      || binding.totalBytes !== expected.totalBytes) {
      throw new PermanentDeleteAdmissionError(
        "Permanent-delete confirmation is invalid or expired.",
      );
    }
  }

  clear(): void {
    this.#tokens.clear();
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [token, binding] of this.#tokens) {
      if (binding.expiresAtMs <= now) this.#tokens.delete(token);
    }
  }
}
