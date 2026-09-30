import { Transport } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { BeaconReport, BeaconStarted, BeaconStatus } from "./types.js";

/**
 * Overwing Beacon: is a site reachable by agents? One paid lookup that says whether an
 * agent can find a product, read it, and use it, with the changes worth making first.
 * No API key: the check is paid for, by card ($5) or over x402 ($1).
 *
 *   const beacon = new Beacon();
 *   const { id, checkout_url } = await beacon.start("example.com"); // a person pays at checkout_url
 *   const report = await beacon.waitForReport(id);
 *   if (report.status === "complete") report.top_fixes;
 */
export class Beacon {
  private readonly http: Transport;

  constructor(options: TransportOptions = {}, transport?: Transport) {
    this.http = transport ?? new Transport(undefined, options);
  }

  /** Start a check paid by card. Returns the checkout link for a person to open and the id to read the report with. Nothing runs until payment completes. */
  start(url: string): Promise<BeaconStarted> {
    return this.http.request("POST", "/api/v1/beacon/checks", { body: { url } });
  }

  /** Where a check stands: `awaiting_payment` (with the checkout link), `running`, or `complete` with the report. */
  report(id: string): Promise<BeaconStatus> {
    return this.http.request("GET", `/api/v1/beacon/checks/${encodeURIComponent(id)}`, { acceptStatuses: [402] });
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

  /** A real report, free: the check of overwing.ai itself. The same shape a paid check returns. */
  sample(): Promise<BeaconReport> {
    return this.http.request("GET", "/api/v1/beacon/sample");
  }

  /** What is checked, what it costs, and the endpoints. */
  overview(): Promise<Record<string, unknown>> {
    return this.http.request("GET", "/api/v1/beacon");
  }

  /**
   * The address an x402 client pays $1 at to get the report in one call, for agents with a wallet:
   *   const res = await fetchWithPayment(beacon.x402Url("example.com"));
   */
  x402Url(url: string): string {
    return `${this.http.baseUrl}/api/x402/beacon?url=${encodeURIComponent(url)}`;
  }
}
