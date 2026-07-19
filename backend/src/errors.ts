export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const asApiError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  return new ApiError(500, "internal_error", "The local demo could not complete that request.");
};
