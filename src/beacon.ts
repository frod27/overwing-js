import { Transport, env } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { BeaconReport, BeaconStarted, BeaconStatus } from "./types.js";

/**
 * Overwing Beacon: is a site reachable by agents? One lookup that says whether an agent
 * can find a product, read it, and use it, with the changes worth making first. Free.
 * With a key (`apiKey`, or OVERWING_API_KEY) the report is the full one and is saved to
 * that dashboard. With no key it is the summary: the score, the three answers and the
 * first fix (`access: "summary"`). A key is free: POST https://overwing.ai/api/v1/signup.
 *
 *   const beacon = new Beacon();
 *   const { id } = await beacon.start("example.com");
 *   const report = await beacon.waitForReport(id);   // the first read runs the check
 *   if (report.status === "complete") report.top_fixes;
 */
export class Beacon {
  private readonly http: Transport;

  constructor(options: TransportOptions & { apiKey?: string } = {}, transport?: Transport) {
    this.http = transport ?? new Transport(options.apiKey ?? env("OVERWING_API_KEY") ?? undefined, options);
  }

  /** Start a check. Free. It runs when its report is first read. */
  start(url: string): Promise<BeaconStarted> {
    return this.http.request("POST", "/api/v1/beacon/checks", { body: { url } });
  }

  /** Where a check stands: `running`, or `complete` with the report. `access` says whether it is the full report or the summary. */
  report(id: string): Promise<BeaconStatus> {
    return this.http.request("GET", `/api/v1/beacon/checks/${encodeURIComponent(id)}`);
  }

  /** Poll a check until its report is ready, or until the timeout passes. Returns the last state seen. */
  async waitForReport(id: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<BeaconStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const interval = Math.max(1_000, options.intervalMs ?? 3_000);
    for (;;) {
      const status = await this.report(id);
      if (status.status === "complete" || Date.now() + interval > deadline) return status;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** A real report in full: the check of overwing.ai itself. No key needed. */
  sample(): Promise<BeaconReport> {
    return this.http.request("GET", "/api/v1/beacon/sample");
  }

  /** What is checked, what it costs, and the endpoints. */
  overview(): Promise<Record<string, unknown>> {
    return this.http.request("GET", "/api/v1/beacon");
  }

  /**
   * The address an x402 client pays $1 at to get the full report in one call, for agents with a wallet and no account:
   *   const res = await fetchWithPayment(beacon.x402Url("example.com"));
   */
  x402Url(url: string): string {
    return `${this.http.baseUrl}/api/x402/beacon?url=${encodeURIComponent(url)}`;
  }
}
