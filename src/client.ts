import { Atlas } from "./atlas.js";
import { Beacon } from "./beacon.js";
import { OverwingError } from "./errors.js";
import { Transport, env } from "./http.js";
import { Preflight } from "./preflight.js";
import { TowerSetup } from "./tower.js";
import type { AccountCreated, BatchItem, BatchResult, DomainCheck, DomainProof, DomainProofSteps, Evaluation, EvaluationDetail, EvaluationSummary, KeyRecovered, Me, RateLimitInfo, RecoveryStarted, RuleDefinition, RuleSet, Usage, Verdict } from "./types.js";

/** Where to send a call that needs no key: the base URL, timeout, retries and fetch of the caller's choosing. */
export type KeylessOptions = Omit<OverwingOptions, "apiKey">;

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
  /** Overwing Preflight: should the agent sign this Solana transaction? `preflight.check({ transaction, policy })` needs this client's key; the record and reports need none. */
  readonly preflight: Preflight;
  /** Overwing Tower setup: load the starter workflow, create and revoke agent identities. Agents operate through `new Tower({ agentKey })`. */
  readonly tower: TowerSetup;

  constructor(options: OverwingOptions = {}) {
    const apiKey = options.apiKey ?? env("OVERWING_API_KEY");
    this.keyless = !apiKey;
    this.http = new Transport(apiKey || undefined, options);
    this.baseUrl = this.http.baseUrl;
    this.atlas = new Atlas({}, this.http);
    this.beacon = new Beacon({}, this.http);
    this.preflight = new Preflight({}, this.http);
    this.tower = new TowerSetup(this.http);
  }

  /**
   * Create an account with no email, and a client that uses it. Nothing is sent to anyone.
   * The key is the account: store `account.api_key` at once, since with no email there is no reset link.
   * It starts at 50 evaluations a day; `client.account.proveDomain()` raises that and makes the key recoverable.
   *
   *   const { account, client } = await Overwing.signup();
   *   saveSomewhereSafe(account.api_key);
   */
  static async signup(options: KeylessOptions & { orgName?: string } = {}): Promise<{ account: AccountCreated; client: Overwing }> {
    const { orgName, ...rest } = options;
    const account = await new Transport(undefined, rest).request<AccountCreated>("POST", "/api/v1/signup", { body: orgName ? { org_name: orgName } : {} });
    return { account, client: new Overwing({ ...rest, apiKey: account.api_key }) };
  }

  /**
   * Key lost? Begin recovering an account made with no email, by the domain it proved. No key needed.
   * Publish `verification` at the domain, then call `Overwing.finishRecovery(domain)`.
   */
  static startRecovery(domain: string, options: KeylessOptions = {}): Promise<RecoveryStarted> {
    return new Transport(undefined, options).request("POST", "/api/v1/signup/recover", { body: { domain } });
  }

  /** Finish a recovery. With the proof at the domain, every old key is revoked and one new key is returned, once. Throws OverwingError (422) while the proof is not there. */
  static async finishRecovery(domain: string, options: KeylessOptions = {}): Promise<{ recovered: KeyRecovered; client: Overwing }> {
    const recovered = await new Transport(undefined, options).request<KeyRecovered>("POST", "/api/v1/signup/recover/verify", { body: { domain } });
    return { recovered, client: new Overwing({ ...options, apiKey: recovered.api_key }) };
  }

  /** The account itself: a domain in place of an email, and handing the account to a person. */
  readonly account = {
    /** Begin proving that the account controls a domain. Publish `verification` there, then call `verifyDomain()`. */
    proveDomain: (domain: string): Promise<DomainProof> => this.request("POST", "/api/v1/org/domain", { body: { domain } }),
    /** Look for the proof. Not there yet: `verified` is false with what was looked for; asking again is safe. */
    verifyDomain: async (): Promise<DomainCheck> => {
      const body = await this.request<{ domain?: string; status?: string; error?: string; verification?: DomainProofSteps }>("POST", "/api/v1/org/domain/verify", { acceptStatuses: [422] });
      return body.status === "verified" && body.domain ? { verified: true, domain: body.domain } : { verified: false, error: body.error ?? "No proof found", verification: body.verification };
    },
    /** A person takes charge of an account made with no email: attaches a login. They get a confirmation message. */
    claim: (email: string, password: string): Promise<{ org_id: string; account: "claimed"; email: string; next: string }> => this.request("POST", "/api/v1/org/claim", { body: { email, password } }),
  };

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
      return Promise.reject(new OverwingError("Overwing API key missing. Without a key only evaluate() works (10 a day). Pass { apiKey } or set OVERWING_API_KEY. Overwing.signup() makes an account with no email; POST https://overwing.ai/api/v1/signup issues a free key.", 0));
    }
    return this.http.request<T>(method, path, {
      ...init,
      onHeaders: path.startsWith("/api/v1/evaluate") ? (headers) => { this.lastRateLimit = parseRateHeaders(headers); } : undefined,
    });
  }
}
