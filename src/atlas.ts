import { Transport, env, query } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { AtlasAgentList, AtlasLookup, AtlasLookupLimit, AtlasSummary } from "./types.js";

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
}
