import { OverwingError } from "./errors.js";
import type { OverwingErrorDetail } from "./errors.js";

export const SDK_VERSION = "0.11.0";

export type TransportOptions = {
  /** Defaults to https://overwing.ai, or process.env.OVERWING_BASE_URL. */
  baseUrl?: string;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Retries on 429 (honoring Retry-After up to 5 s) and 5xx. Default 2. */
  maxRetries?: number;
  /** Custom fetch, e.g. for tests or instrumented runtimes. */
  fetch?: typeof fetch;
};

export type RequestInitLite = {
  body?: unknown;
  idempotencyKey?: string;
  /** Non-2xx statuses whose body is an answer rather than an error. */
  acceptStatuses?: number[];
  /** Called with the response headers of the final attempt. */
  onHeaders?: (headers: Headers) => void;
};

export function env(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

/** Turn an error body into a message and typed detail. Handles both `{error: "text"}` and Tower's `{error: {code, message, ...}}`. */
export function readError(data: unknown, status: number): { message: string; detail: OverwingErrorDetail } {
  if (typeof data !== "object" || data === null || !("error" in data)) return { message: `HTTP ${status}`, detail: { body: data } };
  const e = (data as { error: unknown }).error;
  if (typeof e === "object" && e !== null) {
    const t = e as { code?: unknown; field?: unknown; message?: unknown; retryable?: unknown; suggested_fix?: unknown };
    return {
      message: typeof t.message === "string" && t.message ? t.message : `HTTP ${status}`,
      detail: {
        code: typeof t.code === "string" ? t.code : undefined,
        field: typeof t.field === "string" ? t.field : undefined,
        retryable: typeof t.retryable === "boolean" ? t.retryable : undefined,
        suggestedFix: typeof t.suggested_fix === "string" ? t.suggested_fix : undefined,
        body: data,
      },
    };
  }
  return { message: String(e), detail: { body: data } };
}

/** One HTTP client shared by the Overwing, Atlas, Beacon, Preflight and Tower clients. `token` may be absent for keyless calls. */
export class Transport {
  readonly baseUrl: string;
  /** The options this transport was built with, so a derived client behaves the same way. */
  readonly options: TransportOptions;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string | undefined, options: TransportOptions = {}) {
    this.token = token;
    this.options = options;
    this.baseUrl = (options.baseUrl ?? env("OVERWING_BASE_URL") ?? "https://overwing.ai").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, init: RequestInitLite = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": `overwing-js/${SDK_VERSION}` };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        throw new OverwingError(`Overwing API unreachable: ${err instanceof Error ? err.message : String(err)}`, 0);
      }
      clearTimeout(timer);
      init.onHeaders?.(res.headers);

      const retryAfter = res.headers.get("retry-after");
      const retryAfterSeconds = retryAfter ? Number(retryAfter) : null;
      const retryable = res.status === 429 || res.status >= 500;
      const accepted = init.acceptStatuses?.includes(res.status) ?? false;
      if (retryable && !accepted && attempt < this.maxRetries && (retryAfterSeconds === null || retryAfterSeconds <= 5)) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 300 * attempt));
        continue;
      }

      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
      if (!res.ok && !accepted) {
        const { message, detail } = readError(data, res.status);
        throw new OverwingError(message, res.status, retryAfterSeconds, detail);
      }
      return data as T;
    }
  }
}

export function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
