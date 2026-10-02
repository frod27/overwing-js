import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing, OverwingError } from "../dist/index.js";
import { fakeEvaluation, scriptedFetch } from "./helpers.ts";

describe("Overwing client", () => {
  it("evaluates with no key: no Authorization header, no metadata, no idempotency key", async () => {
    const saved = process.env.OVERWING_API_KEY;
    delete process.env.OVERWING_API_KEY;
    try {
      const access = { mode: "keyless", daily_limit: 10, remaining_today: 9, input_stored: false, retrievable: false, note: "", next: {} };
      const { fetch, calls } = scriptedFetch([{ status: 200, body: { ...fakeEvaluation("pass"), access } }]);
      const ow = new Overwing({ fetch, baseUrl: "https://example.test" });
      assert.equal(ow.keyless, true);
      const e = await ow.evaluate("hello", { metadata: { a: 1 }, idempotencyKey: "k1", ruleSet: "outbound-message", context: { channel: "email" } });
      assert.equal(e.access?.remaining_today, 9);
      const headers = calls[0]?.init.headers as Record<string, string>;
      assert.equal("Authorization" in headers, false);
      assert.equal("Idempotency-Key" in headers, false);
      assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { input: "hello", rule_set: "outbound-message", context: { channel: "email" } });
    } finally {
      if (saved) process.env.OVERWING_API_KEY = saved;
    }
  });

  it("with no key, everything but evaluate fails before a request is sent, and says how to get a key", async () => {
    const saved = process.env.OVERWING_API_KEY;
    delete process.env.OVERWING_API_KEY;
    try {
      const { fetch, calls } = scriptedFetch([{ status: 200, body: {} }]);
      const ow = new Overwing({ fetch });
      for (const call of [() => ow.usage(), () => ow.me(), () => ow.ruleSets.list(), () => ow.evaluations.get("eval_1"), () => ow.evaluateBatch([{ input: "x" }])]) {
        await assert.rejects(call, (err: unknown) => err instanceof OverwingError && /signup/.test(err.message));
      }
      assert.equal(calls.length, 0);
      assert.equal(new Overwing({ apiKey: "ow_live_test", fetch }).keyless, false);
    } finally {
      if (saved) process.env.OVERWING_API_KEY = saved;
    }
  });

  it("sends the right request and parses rate-limit headers", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass"), headers: { "x-ratelimit-limit": "250", "x-ratelimit-remaining": "249", "x-ratelimit-reset": "1800000000", "x-burst-limit": "30", "x-burst-remaining": "29", "x-burst-reset": "1800000060" } }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test/" });
    const e = await ow.evaluate("hello", { metadata: { a: 1 }, idempotencyKey: "k1" });
    assert.equal(e.verdict, "pass");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/evaluate");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer ow_live_test");
    assert.equal(headers["Idempotency-Key"], "k1");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { input: "hello", rule_set: "content-safety", metadata: { a: 1 } });
    assert.equal(ow.lastRateLimit.daily?.remaining, 249);
    assert.equal(ow.lastRateLimit.burst?.limit, 30);
  });

  it("passes store: false through on evaluate and batch, and leaves it out otherwise", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass") }, { status: 200, body: { summary: {}, results: [] } }, { status: 200, body: fakeEvaluation("pass") }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    await ow.evaluate("hello", { store: false });
    await ow.evaluateBatch([{ input: "a" }], { store: false });
    await ow.evaluate("hello");
    assert.equal(JSON.parse(String(calls[0]?.init.body)).store, false);
    assert.equal(JSON.parse(String(calls[1]?.init.body)).store, false);
    assert.equal("store" in JSON.parse(String(calls[2]?.init.body)), false);
  });

  it("retries a 429 with a short Retry-After, then succeeds", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, body: { error: "slow down" }, headers: { "retry-after": "0" } }, { status: 200, body: fakeEvaluation("pass") }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch });
    const e = await ow.evaluate("x");
    assert.equal(e.verdict, "pass");
    assert.equal(calls.length, 2);
  });

  it("surfaces API errors with status and message", async () => {
    const { fetch } = scriptedFetch([{ status: 404, body: { error: "Rule set 'nope' not found" } }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch });
    await assert.rejects(() => ow.evaluate("x", { ruleSet: "nope" }), (err: unknown) => err instanceof OverwingError && err.status === 404 && /not found/.test(err.message));
  });

  it("does not retry a 429 with a long Retry-After", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, body: { error: "Daily limit" }, headers: { "retry-after": "3600" } }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch });
    await assert.rejects(() => ow.evaluate("x"), (err: unknown) => err instanceof OverwingError && err.retryAfterSeconds === 3600);
    assert.equal(calls.length, 1);
  });

  it("batch accepts a 502 body (all items failed) instead of throwing", async () => {
    const { fetch } = scriptedFetch([{ status: 502, body: { summary: { total: 1, pass: 0, fail: 0, review: 0, errors: 1 }, results: [{ id: null, index: 0, evaluation: null, error: "engine" }] } }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, maxRetries: 0 });
    const b = await ow.evaluateBatch([{ input: "x" }]);
    assert.equal(b.summary.errors, 1);
  });

  it("signs up with no email, sends no key, and hands back a client that uses the new one", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 201, body: { org_id: "o1", org: "Agent account", plan: "free", account: "key_only", daily_limit: 50, api_key: "ow_live_new", key_prefix: "ow_live_new", notice: "" } },
      { status: 200, body: { org_id: "o1", org: "Agent account", plan: "free", daily_limit: 50, webhook_configured: false, account: "key_only", verified_domain: null } },
    ]);
    const { account, client } = await Overwing.signup({ fetch, baseUrl: "https://example.test" });
    assert.equal(account.account, "key_only");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/signup");
    assert.equal("Authorization" in (calls[0]?.init.headers as Record<string, string>), false);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {});
    assert.equal(client.keyless, false);
    assert.equal((await client.me()).account, "key_only");
    assert.equal((calls[1]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_new");
  });

  it("proves a domain, and reads a proof that is not there yet as a state", async () => {
    const steps = { value: "overwing-atlas-verification=tok", dns: { type: "TXT", name: "_overwing-atlas.acme.com", value: "overwing-atlas-verification=tok" }, http: { url: "https://acme.com/.well-known/overwing-atlas.txt", body: "overwing-atlas-verification=tok" }, note: "" };
    const { fetch, calls } = scriptedFetch([
      { status: 200, body: { domain: "acme.com", status: "pending_verification", verification: steps } },
      { status: 422, body: { error: "No proof found.", verification: steps } },
      { status: 200, body: { domain: "acme.com", status: "verified" } },
    ]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    assert.equal((await ow.account.proveDomain("acme.com")).verification?.dns.name, "_overwing-atlas.acme.com");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { domain: "acme.com" });
    const first = await ow.account.verifyDomain();
    assert.equal(first.verified, false);
    assert.equal(!first.verified && first.error, "No proof found.");
    assert.deepEqual(await ow.account.verifyDomain(), { verified: true, domain: "acme.com" });
    assert.equal(calls[2]?.url, "https://example.test/api/v1/org/domain/verify");
  });

  it("recovers a lost key by domain with no key, and returns a client on the new one", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 200, body: { domain: "acme.com", verification: {}, expires_in_hours: 24, next: "" } },
      { status: 200, body: { org_id: "o1", domain: "acme.com", api_key: "ow_live_again", key_prefix: "ow_live_agai", revoked_keys: 1, notice: "" } },
    ]);
    assert.equal((await Overwing.startRecovery("acme.com", { fetch, baseUrl: "https://example.test" })).expires_in_hours, 24);
    const { recovered, client } = await Overwing.finishRecovery("acme.com", { fetch, baseUrl: "https://example.test" });
    assert.equal(recovered.revoked_keys, 1);
    assert.equal(client.keyless, false);
    assert.equal(calls[1]?.url, "https://example.test/api/v1/signup/recover/verify");
    for (const c of calls) assert.equal("Authorization" in (c.init.headers as Record<string, string>), false);
  });
});
