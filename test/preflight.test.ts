import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing, OverwingError, Preflight, transactionToBase64 } from "../dist/index.js";
import { fakeVerdict, scriptedFetch } from "./helpers.ts";

const policy = { wallet: "Wa11etAddre55111111111111111111111111111111", max_sol_out: 0.05 };

describe("Preflight client", () => {
  it("checks a base64 transaction with the key and returns the verdict", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("allow") }]);
    const verdict = await new Preflight({ fetch, apiKey: "ow_live_test", baseUrl: "https://example.test" }).check({ transaction: "AQID", policy });
    assert.equal(verdict.decision, "allow");
    assert.equal(verdict.id, "pfc_0000000000000001");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/preflight/checks");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { transaction: "AQID", policy });
  });

  it("turns bytes into base64, and resolves on a refusal", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("refuse") }]);
    const verdict = await new Preflight({ fetch, apiKey: "k" }).check({ transaction: new Uint8Array([1, 2, 3, 250, 251, 252]), policy: { wallet: policy.wallet, max_sol_out_lamports: "50000000" } });
    assert.equal(verdict.decision, "refuse");
    assert.equal(verdict.reasons[0]?.code, "sol_out_exceeds_limit");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.equal(sent.transaction, Buffer.from([1, 2, 3, 250, 251, 252]).toString("base64"));
    assert.equal(sent.policy.max_sol_out_lamports, "50000000");
    assert.equal(transactionToBase64(Buffer.from([255, 0, 128])), "/wCA");
    assert.equal(transactionToBase64(" AQID\n"), "AQID");
  });

  it("throws OverwingError when there is no verdict: an error status, or an answer that is not a verdict", async () => {
    const bad = new Preflight({ fetch: scriptedFetch([{ status: 400, body: { error: "policy.max_sol_out is required" } }]).fetch, apiKey: "k" });
    await assert.rejects(bad.check({ transaction: "AQID", policy }), (err: unknown) => err instanceof OverwingError && err.status === 400 && err.message === "policy.max_sol_out is required");
    const down = new Preflight({ fetch: scriptedFetch([{ status: 502, body: { error: "Solana node unreachable" } }]).fetch, apiKey: "k", maxRetries: 0 });
    await assert.rejects(down.check({ transaction: "AQID", policy }), (err: unknown) => err instanceof OverwingError && err.status === 502);
    for (const body of [null, {}, { id: "pfc_1" }, { id: "pfc_1", decision: "maybe" }, { decision: "allow" }]) {
      const odd = new Preflight({ fetch: scriptedFetch([{ status: 200, body }]).fetch, apiKey: "k" });
      await assert.rejects(odd.check({ transaction: "AQID", policy }), (err: unknown) => err instanceof OverwingError && err.code === "malformed_verdict");
    }
  });

  it("reads a verdict, the record and the overview, and reports a signature, all with no key", async () => {
    const saved = process.env.OVERWING_API_KEY;
    delete process.env.OVERWING_API_KEY;
    try {
      const published = { id: "pfc_a/b", decision: "allow", reason_codes: [], programs: ["11111111111111111111111111111111"], digest: "ab", covered: true, slot: 1, channel: "key", decided_at: "2026-10-08T00:00:00.000Z", payload_hash: "h", signature: "s", signing_key_id: "k" };
      const { fetch, calls } = scriptedFetch([
        { status: 200, body: { ...published, reports: [] } },
        { status: 200, body: { check_id: "pfc_a/b", transaction: "5sig", outcome: "not_a_miss", why: null, covered: true, payout_usd: null } },
        { status: 200, body: { totals: { checks: 2, allowed: 1, refused: 1, covered_allows: 1, reports: 0, misses: 0, covered_misses: 0, paid_usd: 0 }, misses: [], recent: [published], guarantee: { active: false, reserve: null, per_verdict_usd: 100, per_wallet_monthly_usd: 200, terms: "t" } } },
        { status: 200, body: { product: "Overwing Preflight" } },
      ]);
      const preflight = new Preflight({ fetch, baseUrl: "https://example.test/" });
      assert.deepEqual((await preflight.verdict("pfc_a/b")).reports, []);
      assert.equal(calls[0]?.url, "https://example.test/api/v1/preflight/checks/pfc_a%2Fb");
      assert.equal("Authorization" in (calls[0]?.init.headers as Record<string, string>), false);
      assert.equal((await preflight.report("pfc_a/b", "5sig")).outcome, "not_a_miss");
      assert.equal(calls[1]?.url, "https://example.test/api/v1/preflight/checks/pfc_a%2Fb/reports");
      assert.equal(calls[1]?.init.method, "POST");
      assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { signature: "5sig" });
      assert.equal((await preflight.record()).totals.checks, 2);
      assert.equal(calls[2]?.url, "https://example.test/api/v1/preflight/record");
      assert.equal((await preflight.overview()).product, "Overwing Preflight");
      assert.equal(calls[3]?.url, "https://example.test/api/v1/preflight");
      assert.equal(preflight.x402Url(), "https://example.test/api/x402/preflight");
    } finally {
      if (saved) process.env.OVERWING_API_KEY = saved;
    }
  });

  it("is reachable from the main client, with its key", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("allow") }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    assert.equal((await ow.preflight.check({ transaction: "AQID", policy })).decision, "allow");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
  });
});
