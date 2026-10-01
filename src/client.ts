import { Atlas } from "./atlas.js";
import { Beacon } from "./beacon.js";
import { OverwingError } from "./errors.js";
import { Transport, env } from "./http.js";
import { TowerSetup } from "./tower.js";
import type { BatchItem, BatchResult, Evaluation, EvaluationDetail, EvaluationSummary, Me, RateLimitInfo, RuleDefinition, RuleSet, Usage, Verdict } from "./types.js";

export type OverwingOptions = {
  /**
   * API key (ow_live_...). Defaults to process.env.OVERWING_API_KEY.
   * Optional: with no key, `evaluate` uses the free allowance (10 a day, inputs up to 2,000 characters,
   * the prebuilt rule sets, text not stored). Everything else needs a key.
   */
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
  /** Facts the rules may reference (recipient, channel, ownership), sent to the model as state next to the text. Max 8 KB. */
  context?: Record<string, unknown>;
  /** False runs the check without keeping the input text or the context; the verdict and metadata are still recorded. */
  store?: boolean;
  /** Retrying with the same key within 24 h returns the stored result. */
  idempotencyKey?: string;
};

export type ListEvaluationsOptions = { limit?: number; cursor?: string; verdict?: Verdict; ruleSet?: string };

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
  private readonly http: Transport;
  /** True when no key is configured. `evaluate` then uses the free allowance; every other method throws. */
  readonly keyless: boolean;
  /** Rate-limit headers from the most recent evaluate call. */
  lastRateLimit: RateLimitInfo = { daily: null, burst: null };
  /** Overwing Atlas with this key's allowance. For keyless use, construct `new Atlas()` instead. */
  readonly atlas: Atlas;
  /** Overwing Beacon: is a site reachable by agents? Free. With this client's key the report is the full one; `new Beacon()` with no key gets the summary. */
  readonly beacon: Beacon;
  /** Overwing Tower setup: load the starter workflow, create and revoke agent identities. Agents operate through `new Tower({ agentKey })`. */
  readonly tower: TowerSetup;

  constructor(options: OverwingOptions = {}) {
    const apiKey = options.apiKey ?? env("OVERWING_API_KEY");
    this.keyless = !apiKey;
    this.http = new Transport(apiKey || undefined, options);
    this.baseUrl = this.http.baseUrl;
    this.atlas = new Atlas({}, this.http);
    this.beacon = new Beacon({}, this.http);
    this.tower = new TowerSetup(this.http);
  }

  /** Score one text. Throws OverwingError on any non-2xx. */
  async evaluate(input: string, options: EvaluateOptions = {}): Promise<Evaluation> {
    const res = await this.request<Evaluation>("POST", "/api/v1/evaluate", {
      // With no key the API keeps nothing and has nothing to replay, so metadata and the idempotency key are left out.
      body: { input, rule_set: options.ruleSet ?? "content-safety", metadata: this.keyless ? undefined : options.metadata, context: options.context, store: options.store },
      idempotencyKey: this.keyless ? undefined : options.idempotencyKey,
    });
    return res;
  }

  /** Score up to 50 texts in one call. Items succeed or fail independently. */
  async evaluateBatch(items: BatchItem[], options: Omit<EvaluateOptions, "metadata"> = {}): Promise<BatchResult> {
    return this.request<BatchResult>("POST", "/api/v1/evaluate/batch", {
      body: { rule_set: options.ruleSet ?? "content-safety", items, context: options.context, store: options.store },
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

  private request<T>(method: string, path: string, init: { body?: unknown; idempotencyKey?: string; acceptStatuses?: number[] } = {}): Promise<T> {
    // Only a single evaluation works without a key. Say so here, before a request that would come back 401.
    if (this.keyless && !(method === "POST" && path === "/api/v1/evaluate")) {
      return Promise.reject(new OverwingError("Overwing API key missing. Without a key only evaluate() works (10 a day). Pass { apiKey } or set OVERWING_API_KEY. POST https://overwing.ai/api/v1/signup issues a free key.", 0));
    }
    return this.http.request<T>(method, path, {
      ...init,
      onHeaders: path.startsWith("/api/v1/evaluate") ? (headers) => { this.lastRateLimit = parseRateHeaders(headers); } : undefined,
    });
  }
}
