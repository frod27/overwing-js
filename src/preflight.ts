import { OverwingError } from "./errors.js";
import { Transport, env } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { PreflightCheckInput, PreflightRecord, PreflightReport, PreflightVerdict, PreflightVerdictRecord } from "./types.js";

/** Base64 of a serialized transaction. A string is taken to be base64 already. */
export function transactionToBase64(transaction: string | Uint8Array): string {
  if (typeof transaction === "string") return transaction.trim();
  let binary = "";
  for (let i = 0; i < transaction.length; i += 1) binary += String.fromCharCode(transaction[i]!);
  return btoa(binary);
}

/**
 * Overwing Preflight: should the agent sign this Solana transaction? One check of one unsigned
 * transaction against your policy. It never sees a private key and sends nothing to the chain.
 * A check needs a key (`apiKey`, or OVERWING_API_KEY). The record and the reports need none.
 *
 *   const preflight = new Preflight();
 *   const verdict = await preflight.check({ transaction: tx.serialize(), policy: { wallet, max_sol_out: 0.05 } });
 *   if (verdict.decision !== "allow") throw new Error(verdict.reasons[0]?.detail);   // do not sign
 *
 * Sign only on "allow". An error from `check` is not an allow: do not sign.
 * To put the check in a wallet's signing path, use `withPreflight` from "overwing/solana".
 */
export class Preflight {
  private readonly http: Transport;

  constructor(options: TransportOptions & { apiKey?: string } = {}, transport?: Transport) {
    this.http = transport ?? new Transport(options.apiKey ?? env("OVERWING_API_KEY") ?? undefined, options);
  }

  /**
   * Check one transaction against a policy. Resolves for both decisions; branch on `decision`.
   * Throws OverwingError when no verdict was given: 400 bad input, 401 no key, 429 out of allowance,
   * 502 Solana node unreachable, or an answer that is not a verdict.
   */
  async check(input: PreflightCheckInput): Promise<PreflightVerdict> {
    const verdict = await this.http.request<PreflightVerdict>("POST", "/api/v1/preflight/checks", { body: { transaction: transactionToBase64(input.transaction), policy: input.policy } });
    const v = verdict as Partial<PreflightVerdict> | null;
    if (typeof v !== "object" || v === null || typeof v.id !== "string" || (v.decision !== "allow" && v.decision !== "refuse")) {
      throw new OverwingError("Overwing Preflight gave an answer that is not a verdict. Do not sign.", 0, null, { code: "malformed_verdict", body: verdict });
    }
    return verdict;
  }

  /** The public record of one verdict and of every transaction reported against it. No key needed. */
  verdict(id: string): Promise<PreflightVerdictRecord> {
    return this.http.request("GET", `/api/v1/preflight/checks/${encodeURIComponent(id)}`);
  }

  /** Report the transaction that landed after a verdict, by its base58 signature. The outcome is read from the chain and published. No key needed. */
  report(id: string, signature: string): Promise<PreflightReport> {
    return this.http.request("POST", `/api/v1/preflight/checks/${encodeURIComponent(id)}/reports`, { body: { signature } });
  }

  /** The public record: totals, every miss, the latest verdicts, and what the guarantee's reserve holds. No key needed. */
  record(): Promise<PreflightRecord> {
    return this.http.request("GET", "/api/v1/preflight/record");
  }

  /** What is checked, the policy fields, the reason codes, the prices and the endpoints. No key needed. */
  overview(): Promise<Record<string, unknown>> {
    return this.http.request("GET", "/api/v1/preflight");
  }

  /** The address an x402 client pays $0.01 at for one check, with the same body and answer, for agents with a wallet and no account. */
  x402Url(): string {
    return `${this.http.baseUrl}/api/x402/preflight`;
  }
}
