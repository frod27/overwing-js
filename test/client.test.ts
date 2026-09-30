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
});
