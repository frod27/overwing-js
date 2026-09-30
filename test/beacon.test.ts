import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Beacon, Overwing } from "../dist/index.js";
import { scriptedFetch } from "./helpers.ts";

const report = { id: "bcn_0123456789abcdef", url: "https://example.com", host: "example.com", scanned_at: "2026-09-30T00:00:00.000Z", score: 25, verdict: "no", summary: "s", categories: [], checks: [], top_fixes: [{ check: "llms_txt", fix: "Publish /llms.txt", gain: 10 }], judged: true, duration_ms: 900, requests: 19 };

describe("Beacon client", () => {
  it("starts a check with no Authorization header and returns where to pay", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 201, body: { id: report.id, url: report.url, status: "awaiting_payment", price_usd: 5, checkout_url: "https://checkout.example/c", status_url: "s", report_url: "r" } }]);
    const started = await new Beacon({ fetch, baseUrl: "https://example.test" }).start("example.com");
    assert.equal(started.checkout_url, "https://checkout.example/c");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/beacon/checks");
    assert.equal(calls[0]?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { url: "example.com" });
    assert.equal("Authorization" in (calls[0]?.init.headers as Record<string, string>), false);
  });

  it("reads an unpaid check as a state, not an error", async () => {
    const { fetch } = scriptedFetch([{ status: 402, body: { id: report.id, url: report.url, status: "awaiting_payment", price_usd: 5, checkout_url: "https://checkout.example/c", error: "not paid" } }]);
    const status = await new Beacon({ fetch }).report(report.id);
    assert.equal(status.status, "awaiting_payment");
    assert.equal(status.status === "awaiting_payment" && status.checkout_url, "https://checkout.example/c");
  });

  it("waits through awaiting_payment and running until the report is complete", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 402, body: { id: report.id, url: report.url, status: "awaiting_payment", price_usd: 5, checkout_url: "c" } },
      { status: 202, body: { id: report.id, url: report.url, status: "running" } },
      { status: 200, body: { status: "complete", ...report } },
    ]);
    const done = await new Beacon({ fetch, baseUrl: "https://example.test" }).waitForReport(report.id, { intervalMs: 1_000 });
    assert.equal(done.status, "complete");
    assert.equal(done.status === "complete" && done.top_fixes[0]?.check, "llms_txt");
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.url, `https://example.test/api/v1/beacon/checks/${report.id}`);
  });

  it("gives the sample, the x402 address, and is reachable from the main client", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { sample: true, ...report } }, { status: 200, body: { sample: true, ...report } }]);
    const beacon = new Beacon({ fetch, baseUrl: "https://example.test/" });
    assert.equal((await beacon.sample()).score, 25);
    assert.equal(beacon.x402Url("https://example.com/a b"), "https://example.test/api/x402/beacon?url=https%3A%2F%2Fexample.com%2Fa%20b");
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    await ow.beacon.sample();
    assert.equal(calls[1]?.url, "https://example.test/api/v1/beacon/sample");
  });
});
