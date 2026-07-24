import { request, type ClientRequest, type IncomingMessage } from "node:http";

export const VISUAL_HEALTH_MAX_HEADER_BYTES = 8 * 1024;
export const VISUAL_HEALTH_MAX_BODY_BYTES = 8 * 1024;

export type VisualHealthProbeErrorCode =
  | "visual_health_probe_invalid"
  | "visual_health_probe_already_used"
  | "visual_health_listener_before_failed"
  | "visual_health_deadline_exceeded"
  | "visual_health_redirect_rejected"
  | "visual_health_status_rejected"
  | "visual_health_headers_too_large"
  | "visual_health_body_too_large"
  | "visual_health_transport_failed"
  | "visual_health_listener_after_failed";

export type VisualHealthProbeOptions = Readonly<{
  host: "127.0.0.1";
  assignedPort: number;
  healthPath: string;
  deadlineAtMs: number;
  assertListenerBefore: () => Promise<void>;
  assertListenerAfter: () => Promise<void>;
}>;

export class VisualHealthProbeError extends Error {
  readonly code: VisualHealthProbeErrorCode;

  constructor(code: VisualHealthProbeErrorCode, message: string) {
    super(message);
    this.name = "VisualHealthProbeError";
    this.code = code;
  }
}

/**
 * One instance represents the only health request authorized for one visual
 * process identity. The instance is consumed before any callback or socket
 * work, so concurrent and repeated calls cannot create another request.
 */
export class VisualHealthProbe {
  readonly #options: VisualHealthProbeOptions;
  #used = false;

  constructor(options: VisualHealthProbeOptions) {
    validateOptions(options);
    this.#options = Object.freeze({ ...options });
  }

  async probe(): Promise<void> {
    if (this.#used) {
      throw probeError(
        "visual_health_probe_already_used",
        "The visual health probe is single-use.",
      );
    }
    this.#used = true;

    try {
      await this.#options.assertListenerBefore();
    } catch {
      throw probeError(
        "visual_health_listener_before_failed",
        "The pre-probe listener assertion failed.",
      );
    }

    const remainingMs = this.#options.deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw probeError(
        "visual_health_deadline_exceeded",
        "The visual health response deadline expired.",
      );
    }
    const responseError = await requestHealth(this.#options, remainingMs);

    try {
      await this.#options.assertListenerAfter();
    } catch {
      throw probeError(
        "visual_health_listener_after_failed",
        "The post-probe listener assertion failed.",
      );
    }
    if (responseError) throw responseError;
  }
}

const requestHealth = async (
  options: VisualHealthProbeOptions,
  remainingMs: number,
): Promise<VisualHealthProbeError | null> => await new Promise((resolve, reject) => {
  let settled = false;
  let clientRequest: ClientRequest | null = null;
  let response: IncomingMessage | null = null;

  const finish = (
    error?: VisualHealthProbeError,
    destroy = false,
    completedResponseError: VisualHealthProbeError | null = null,
  ): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineTimer);
    if (destroy) {
      response?.destroy();
      clientRequest?.destroy();
    }
    if (error) reject(error);
    else resolve(completedResponseError);
  };

  const deadlineTimer = setTimeout(() => finish(probeError(
    "visual_health_deadline_exceeded",
    "The visual health response deadline expired.",
  ), true), remainingMs);

  clientRequest = request({
    method: "GET",
    host: options.host,
    port: options.assignedPort,
    path: options.healthPath,
    agent: false,
    maxHeaderSize: VISUAL_HEALTH_MAX_HEADER_BYTES,
    headers: Object.freeze({
      accept: "application/json",
      connection: "close",
    }),
  }, (incoming) => {
    response = incoming;
    const statusCode = incoming.statusCode;
    const statusError = statusCode !== undefined && statusCode >= 300 && statusCode < 400
      ? probeError(
        "visual_health_redirect_rejected",
        "The visual health response redirected.",
      )
      : statusCode !== 200
        ? probeError(
          "visual_health_status_rejected",
          "The visual health response status was rejected.",
        )
        : null;
    const declaredLength = parseDeclaredLength(incoming.headers["content-length"]);
    if (declaredLength !== null && declaredLength > VISUAL_HEALTH_MAX_BODY_BYTES) {
      finish(probeError(
        "visual_health_body_too_large",
        "The visual health response body exceeded its limit.",
      ), true);
      return;
    }

    let receivedBytes = 0;
    incoming.on("data", (chunk: Buffer | string) => {
      receivedBytes += typeof chunk === "string"
        ? Buffer.byteLength(chunk)
        : chunk.byteLength;
      if (receivedBytes > VISUAL_HEALTH_MAX_BODY_BYTES) {
        finish(probeError(
          "visual_health_body_too_large",
          "The visual health response body exceeded its limit.",
        ), true);
      }
    });
    incoming.once("aborted", () => finish(probeError(
      "visual_health_transport_failed",
      "The visual health response was incomplete.",
    )));
    incoming.once("error", () => finish(probeError(
      "visual_health_transport_failed",
      "The visual health response failed.",
    )));
    incoming.once("end", () => finish(undefined, false, statusError));
  });

  clientRequest.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "HPE_HEADER_OVERFLOW") {
      finish(probeError(
        "visual_health_headers_too_large",
        "The visual health response headers exceeded their limit.",
      ));
      return;
    }
    finish(probeError(
      "visual_health_transport_failed",
      "The visual health request failed.",
    ));
  });
  clientRequest.end();
});

const parseDeclaredLength = (value: string | undefined): number | null => {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const validateOptions = (options: VisualHealthProbeOptions): void => {
  if (options.host !== "127.0.0.1"
    || !Number.isSafeInteger(options.assignedPort)
    || options.assignedPort < 1
    || options.assignedPort > 65_535
    || !isExactOriginPath(options.healthPath)
    || !Number.isSafeInteger(options.deadlineAtMs)
    || typeof options.assertListenerBefore !== "function"
    || typeof options.assertListenerAfter !== "function") {
    throw probeError(
      "visual_health_probe_invalid",
      "The visual health probe configuration is invalid.",
    );
  }
};

const isExactOriginPath = (value: string): boolean => {
  if (value.length < 1 || value.length > 1_024
    || !value.startsWith("/") || value.startsWith("//")
    || /[\\?#\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const parsed = new URL(value, "http://127.0.0.1");
    return parsed.origin === "http://127.0.0.1"
      && `${parsed.pathname}${parsed.search}` === value;
  } catch {
    return false;
  }
};

const probeError = (
  code: VisualHealthProbeErrorCode,
  message: string,
): VisualHealthProbeError => new VisualHealthProbeError(code, message);
