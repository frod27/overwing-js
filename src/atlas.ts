import { Transport, env, query } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { AtlasAgentList, AtlasLookup, AtlasLookupLimit, AtlasRegistration, AtlasRegistrationCheck, AtlasRegistrationInput, AtlasSummary } from "./types.js";

export type AtlasOptions = TransportOptions & {
  /**
   * Optional. With no key, lookups use the keyless allowance (10 a day per client).
   * A key (ow_live_...) raises it to 100 a day, or to your Atlas plan's limit.
   * Defaults to process.env.OVERWING_API_KEY when set.
   */
  apiKey?: string;
};

export type AtlasAgentFilter = { q?: string; purpose?: string; operator?: string; verification?: string; limit?: number; offset?: number };

/**
 * Overwing Atlas: who the AI agents are, and whether a User-Agent's claim can be trusted.
 * Works with no API key.
 *
 *   const atlas = new Atlas();
 *   const who = await atlas.lookup(request.headers.get("user-agent") ?? "");
 *   if (who.claims?.verification !== "Web Bot Auth signature") { ...treat the claim as unverified }
 */
export class Atlas {
  /** True when no key is configured and calls use the keyless allowance. */
  readonly keyless: boolean;
  /** Lookup allowance from the most recent lookup call. */
  lastLookupLimit: AtlasLookupLimit | null = null;
  private readonly http: Transport;

  constructor(options: AtlasOptions = {}, transport?: Transport) {
    const apiKey = options.apiKey ?? env("OVERWING_API_KEY");
    this.keyless = transport ? false : !apiKey;
    this.http = transport ?? new Transport(apiKey, options);
  }

  /** Say what a User-Agent string claims to be and whether the claim can be trusted. Throws OverwingError with status 429 when the allowance is spent. */
  async lookup(userAgent: string): Promise<AtlasLookup> {
    return this.http.request<AtlasLookup>("GET", `/api/v1/atlas/lookup${query({ user_agent: userAgent })}`, {
      onHeaders: (h) => {
        const limit = h.get("x-atlas-lookup-limit"), remaining = h.get("x-atlas-lookup-remaining");
        this.lastLookupLimit = limit !== null && remaining !== null ? { limit: Number(limit), remaining: Number(remaining) } : null;
      },
    });
  }

  /** Browse or search the registry. Public fields for everyone; Atlas Pro and Team keys get the curated fields. */
  agents(filter: AtlasAgentFilter = {}): Promise<AtlasAgentList> {
    return this.http.request("GET", `/api/v1/atlas/agents${query(filter)}`);
  }

  /** Registry counts, browser-agent traffic shares, field-scan headlines, and the report summary. */
  summary(): Promise<AtlasSummary> {
    return this.http.request("GET", "/api/v1/atlas/summary");
  }

  /**
   * Add an agent you operate to the registry. Free; needs an API key.
   * The answer's `verification` holds one value to publish at the domain, as a DNS TXT record
   * or as a file. Publish it, then call `verifyRegistration(id)`.
   *
   * This proves control of the operator's domain, not that a given request is yours: the entry
   * is listed as user-agent only unless `keyDirectoryUrl` is a Web Bot Auth key directory there.
   */
  register(input: AtlasRegistrationInput): Promise<AtlasRegistration> {
    const body = {
      name: input.name,
      operator: input.operator,
      domain: input.domain,
      tokens: input.tokens,
      purpose: input.purpose,
      user_agent: input.userAgent,
      description: input.description,
      policy_url: input.policyUrl,
      key_directory_url: input.keyDirectoryUrl,
      follows_robots_txt: input.followsRobotsTxt,
    };
    return this.http.request("POST", "/api/v1/atlas/registrations", { body });
  }

  /**
   * Look for the proof at the domain. Found: the entry is published (or held for review when the
   * operator name already belongs to someone) and `verified` is true. Not found yet: `verified`
   * is false with what was looked for; DNS changes can take a few minutes, and asking again is safe.
   */
  async verifyRegistration(id: string): Promise<AtlasRegistrationCheck> {
    const body = await this.http.request<AtlasRegistration | { error: string; registration: AtlasRegistration }>("POST", `/api/v1/atlas/registrations/${encodeURIComponent(id)}/verify`, { acceptStatuses: [422] });
    return "registration" in body ? { verified: false, registration: body.registration, error: body.error } : { verified: true, registration: body };
  }

  /** Your registrations, newest first. */
  async registrations(): Promise<AtlasRegistration[]> {
    return (await this.http.request<{ registrations: AtlasRegistration[] }>("GET", "/api/v1/atlas/registrations")).registrations;
  }

  /** One registration, with the verification values while it is unverified. */
  registration(id: string): Promise<AtlasRegistration> {
    return this.http.request("GET", `/api/v1/atlas/registrations/${encodeURIComponent(id)}`);
  }

  /** Withdraw a registration. A published entry leaves the registry. */
  withdrawRegistration(id: string): Promise<{ id: string; status: "withdrawn" }> {
    return this.http.request("DELETE", `/api/v1/atlas/registrations/${encodeURIComponent(id)}`);
  }
}
