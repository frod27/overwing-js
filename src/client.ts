import { OverwingError } from "./errors.js";
import type { BatchItem, BatchResult, Evaluation, EvaluationDetail, EvaluationSummary, Me, RateLimitInfo, RuleDefinition, RuleSet, Usage, Verdict } from "./types.js";

export type OverwingOptions = {
  /** API key (ow_live_...). Defaults to process.env.OVERWING_API_KEY. */
  apiKey?: string;
  /** Defaults to https://overwing.ai, or process.env.OVERWING_BASE_URL. */
  baseUrl?: string;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Retries on 429 (honoring Retry-After up to 5 s) and 5xx. Default 2. */
  maxRetries?: number;
  /** Custom fetch, e.g. for tests or instrumented runtimes. */
  fetch?: typeof fetch;
};

export type EvaluateOptions = {
  /** Rule set slug. Default "content-safety". */
  ruleSet?: string;
  /** Opaque context stored with the evaluation and echoed in webhooks. Max 8 KB. */
  metadata?: Record<string, unknown>;
  /** Retrying with the same key within 24 h returns the stored result. */
  idempotencyKey?: string;
};

export type ListEvaluationsOptions = { limit?: number; cursor?: string; verdict?: Verdict; ruleSet?: string };

function env(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

function parseRateHeaders(headers: Headers): RateLimitInfo {
  const num = (k: string): number | null => {
    const v = headers.get(k);
    return v === null ? null : Number(v);
  };
  const dl = num("x-ratelimit-limit"), dr = num("x-ratelimit-remaining"), dt = num("x-ratelimit-reset");
  const bl = num("x-burst-limit"), br = num("x-burst-remaining"), bt = num("x-burst-reset");
  return {
    daily: dl !== null && dr !== null && dt !== null ? { limit: dl, remaining: dr, resetAt: new Date(dt * 1000) } : null,
    burst: bl !== null && br !== null && bt !== null ? { limit: bl, remaining: br, resetAt: new Date(bt * 1000) } : null,
  };
}

/** Typed client for the Overwing API. */
export class Overwing {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  /** Rate-limit headers from the most recent evaluate call. */
  lastRateLimit: RateLimitInfo = { daily: null, burst: null };

  constructor(options: OverwingOptions = {}) {
    const apiKey = options.apiKey ?? env("OVERWING_API_KEY");
    if (!apiKey) {
      throw new OverwingError("Overwing API key missing. Pass { apiKey } or set OVERWING_API_KEY. Get one at https://overwing.ai/login", 0);
    }
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? env("OVERWING_BASE_URL") ?? "https://overwing.ai").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Score one text. Throws OverwingError on any non-2xx. */
  async evaluate(input: string, options: EvaluateOptions = {}): Promise<Evaluation> {
    const res = await this.request<Evaluation>("POST", "/api/v1/evaluate", {
      body: { input, rule_set: options.ruleSet ?? "content-safety", metadata: options.metadata },
      idempotencyKey: options.idempotencyKey,
    });
    return res;
  }

  /** Score up to 50 texts in one call. Items succeed or fail independently. */
  async evaluateBatch(items: BatchItem[], options: Omit<EvaluateOptions, "metadata"> = {}): Promise<BatchResult> {
    return this.request<BatchResult>("POST", "/api/v1/evaluate/batch", {
      body: { rule_set: options.ruleSet ?? "content-safety", items },
      idempotencyKey: options.idempotencyKey,
      acceptStatuses: [502],
    });
  }

  readonly evaluations = {
    get: (id: string): Promise<EvaluationDetail> => this.request("GET", `/api/v1/evaluations/${encodeURIComponent(id)}`),
    list: (options: ListEvaluationsOptions = {}): Promise<{ evaluations: EvaluationSummary[]; next_cursor: string | null }> => {
      const q = new URLSearchParams();
      if (options.limit) q.set("limit", String(options.limit));
      if (options.cursor) q.set("cursor", options.cursor);
      if (options.verdict) q.set("verdict", options.verdict);
      if (options.ruleSet) q.set("rule_set", options.ruleSet);
      const qs = q.toString();
      return this.request("GET", `/api/v1/evaluations${qs ? `?${qs}` : ""}`);
    },
    delete: (id: string): Promise<{ id: string; deleted: boolean }> => this.request("DELETE", `/api/v1/evaluations/${encodeURIComponent(id)}`),
  };

  readonly ruleSets = {
    list: (includeInactive = false): Promise<{ rule_sets: RuleSet[] }> => this.request("GET", `/api/v1/rule-sets${includeInactive ? "?include_inactive=true" : ""}`),
    get: (slug: string): Promise<RuleSet> => this.request("GET", `/api/v1/rule-sets/${encodeURIComponent(slug)}`),
    create: (input: { name: string; slug: string; description?: string; rules: RuleDefinition[] }): Promise<RuleSet> => this.request("POST", "/api/v1/rule-sets", { body: input }),
    update: (slug: string, patch: { name?: string; description?: string | null; is_active?: boolean; rules?: RuleDefinition[] }): Promise<RuleSet> => this.request("PATCH", `/api/v1/rule-sets/${encodeURIComponent(slug)}`, { body: patch }),
    delete: (slug: string): Promise<{ id: string; slug: string; is_active: boolean }> => this.request("DELETE", `/api/v1/rule-sets/${encodeURIComponent(slug)}`),
  };

  usage(days?: number): Promise<Usage> {
    return this.request("GET", `/api/v1/usage${days ? `?days=${days}` : ""}`);
  }

  me(): Promise<Me> {
    return this.request("GET", "/api/v1/me");
  }

  private async request<T>(method: string, path: string, init: { body?: unknown; idempotencyKey?: string; acceptStatuses?: number[] } = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json", "User-Agent": "overwing-js/0.1.0" };
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

      if (path.startsWith("/api/v1/evaluate")) this.lastRateLimit = parseRateHeaders(res.headers);

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
        const message = typeof data === "object" && data !== null && "error" in data ? String((data as { error: unknown }).error) : `HTTP ${res.status}`;
        throw new OverwingError(message, res.status, retryAfterSeconds);
      }
      return data as T;
    }
  }
}
