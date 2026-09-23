/** Any non-2xx answer from the Overwing API, or a transport failure. */
export class OverwingError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "OverwingError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
