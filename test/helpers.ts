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
