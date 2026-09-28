/** Extra detail carried by Overwing Tower errors, which are typed for agents. */
export type OverwingErrorDetail = {
  /** Machine-readable code, e.g. "forbidden_scope", "invalid_input", "quota_exceeded". */
  code?: string;
  /** The request field at fault, when there is one. */
  field?: string;
  /** Whether repeating the same request can succeed. */
  retryable?: boolean;
  /** What to change. */
  suggestedFix?: string;
  /** The parsed response body. */
  body?: unknown;
};

/** Any non-2xx answer from the Overwing API, or a transport failure. */
export class OverwingError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly code: string | null;
  readonly field: string | null;
  readonly retryable: boolean | null;
  readonly suggestedFix: string | null;
  readonly body: unknown;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null, detail: OverwingErrorDetail = {}) {
    super(message);
    this.name = "OverwingError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = detail.code ?? null;
    this.field = detail.field ?? null;
    this.retryable = detail.retryable ?? null;
    this.suggestedFix = detail.suggestedFix ?? null;
    this.body = detail.body ?? null;
  }
}
