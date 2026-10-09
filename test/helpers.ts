export type Call = { url: string; init: RequestInit };

export function fakeEvaluation(verdict: "pass" | "fail" | "review", id = "eval_0000000000000001", recommended: "block" | "redact" | "review" | "allow" = verdict === "fail" ? "block" : verdict === "review" ? "review" : "allow") {
  return {
    id,
    verdict,
    recommended_action: recommended,
    aggregate_score: verdict === "pass" ? 1 : verdict === "review" ? 0.9 : 0.5,
    confidence: 0.9,
    latency_ms: 42,
    results: [
      { rule: "toxicity", type: "choice", answer: verdict === "fail" ? "toxic" : "safe", probability: 0.9, confidence: 0.9, verdict: verdict === "fail" ? "fail" : "pass", action: "block" },
      { rule: "pii_detected", type: "noul", answer: false, probability: 0.9, confidence: verdict === "review" ? 0.6 : 0.9, verdict: verdict === "review" ? "review" : "pass", action: "redact" },
    ],
  };
}

/** A fetch that answers with a scripted sequence of responses and records calls. */
export function scriptedFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

export function fakeVerdict(decision: "allow" | "refuse", id = "pfc_0000000000000001") {
  return {
    id,
    decision,
    reasons: decision === "refuse" ? [{ code: "sol_out_exceeds_limit", detail: "1.2 SOL would leave; the policy allows 0.05" }] : [],
    effects: { sol_out_lamports: decision === "refuse" ? "1200000000" : "1005000", token_out: {}, token_in: {}, control: [] },
    programs: ["11111111111111111111111111111111"],
    digest: "8e493754cf4c6883b79443511623dba8f410c050a5995d2c146e938a07eb6e80",
    slot: 454679568,
    covered: decision === "allow",
    decided_at: "2026-10-08T22:33:53.770Z",
    valid_for_seconds: 120,
    receipt: { payload: {}, payload_hash: "aff3", signature: "sig", signing_key_id: "b71e", public_key: "https://overwing.ai/api/v1/tower/receipts/public-key" },
    record_url: `https://overwing.ai/api/v1/preflight/checks/${id}`,
  };
}
