import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Atlas, Overwing, OverwingError } from "../dist/index.js";
import { scriptedFetch } from "./helpers.ts";

const lookup = (extra: Record<string, unknown> = {}) => ({
  user_agent: "GPTBot/1.2",
  identified: true,
  claims: { agent: "GPTBot", operator: "OpenAI", purpose_class: "Training / bulk crawl", verification: "User-agent string only (spoofable)", matched_token: "GPTBot" },
  trust_note: "A user-agent string is not proof of identity; anyone can send this one. Treat the claim as unverified.",
  matches: [],
  ...extra,
});

function withoutKey<T>(fn: () => T): T {
  const saved = process.env.OVERWING_API_KEY;
  delete process.env.OVERWING_API_KEY;
  try { return fn(); } finally { if (saved) process.env.OVERWING_API_KEY = saved; }
}

describe("Atlas client", () => {
  it("works with no key and sends no Authorization header", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: lookup({ access: { mode: "keyless", daily_limit: 10, remaining_today: 9, next: {} } }), headers: { "x-atlas-lookup-limit": "10", "x-atlas-lookup-remaining": "9" } }]);
    const atlas = withoutKey(() => new Atlas({ fetch, baseUrl: "https://example.test" }));
    assert.equal(atlas.keyless, true);
    const r = await atlas.lookup("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)");
    assert.equal(r.claims?.agent, "GPTBot");
    assert.equal(r.access?.remaining_today, 9);
    assert.deepEqual(atlas.lastLookupLimit, { limit: 10, remaining: 9 });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, undefined);
    assert.equal(calls[0]?.url, "https://example.test/api/v1/atlas/lookup?user_agent=Mozilla%2F5.0+%28compatible%3B+GPTBot%2F1.2%3B+%2Bhttps%3A%2F%2Fopenai.com%2Fgptbot%29");
  });

  it("sends the key when one is given", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: lookup() }]);
    const atlas = new Atlas({ apiKey: "ow_live_test", fetch });
    assert.equal(atlas.keyless, false);
    await atlas.lookup("GPTBot");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
  });

  it("reports a spent allowance as a 429 with the reset time, without retrying", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, body: { error: "Keyless allowance spent (10 lookups a day without a key)", next: { free_key: "POST /api/v1/signup" } }, headers: { "retry-after": "13000" } }]);
    const atlas = withoutKey(() => new Atlas({ fetch }));
    await assert.rejects(() => atlas.lookup("GPTBot"), (err: unknown) => err instanceof OverwingError && err.status === 429 && err.retryAfterSeconds === 13000 && /Keyless allowance spent/.test(err.message));
    assert.equal(calls.length, 1);
  });

  it("builds registry filters and is reachable from the main client", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { total: 0, limit: 5, offset: 0, fields: "public", tier: "free", agents: [] } }, { status: 200, body: lookup() }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    await ow.atlas.agents({ purpose: "browser", limit: 5 });
    assert.equal(calls[0]?.url, "https://example.test/api/v1/atlas/agents?purpose=browser&limit=5");
    await ow.atlas.lookup("GPTBot");
    assert.equal((calls[1]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
  });
});
