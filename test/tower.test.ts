import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing, OverwingError, Tower } from "../dist/index.js";
import { scriptedFetch } from "./helpers.ts";

const decision = (outcome: "auto" | "review" | "reject", score: number | null = 0.94) => ({ decision_id: "d1", outcome, score, reason: "r", provider: "jev", thresholds: { auto: 0.85, review: 0.45 }, results: [], checks: [], latency_ms: 200 });
const action = (status: string, extra: Record<string, unknown> = {}) => ({ action_id: "7beeb669-ddc0-4b0c-b358-fc41e0181b9d", operation: "create_order", status, dry_run: false, idempotency_key: "k1", decision: decision(status === "rejected" ? "reject" : status === "pending" ? "review" : "auto"), result: null, error: null, ...extra });

describe("Tower agent client", () => {
  it("requires an agent key", () => {
    const saved = process.env.OVERWING_AGENT_KEY;
    delete process.env.OVERWING_AGENT_KEY;
    assert.throws(() => new Tower(), OverwingError);
    if (saved) process.env.OVERWING_AGENT_KEY = saved;
  });

  it("submits with the agent key and the idempotency key in the body", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: action("executed", { result: { order_number: "SO1" } }) }]);
    const tower = new Tower({ agentKey: "ow_agent_test", fetch, baseUrl: "https://example.test" });
    const a = await tower.submit("create_order", { customer_id: "C1" }, { idempotencyKey: "k1" });
    assert.equal(a.status, "executed");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/tower/actions");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_agent_test");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { operation: "create_order", input: { customer_id: "C1" }, idempotency_key: "k1" });
  });

  it("resolves a pending review (202) and a policy rejection (422) instead of throwing", async () => {
    const { fetch } = scriptedFetch([{ status: 202, body: action("pending", { review_id: "rv1" }) }, { status: 422, body: action("rejected", { error: { code: "rejected", message: "over credit limit", retryable: false } }) }]);
    const tower = new Tower({ agentKey: "ow_agent_test", fetch, maxRetries: 0 });
    const pending = await tower.submit("create_order", {}, { idempotencyKey: "a" });
    assert.equal(pending.status, "pending");
    assert.equal(pending.review_id, "rv1");
    const rejected = await tower.submit("create_order", {}, { idempotencyKey: "b" });
    assert.equal(rejected.status, "rejected");
  });

  it("throws typed errors with code, field and suggested fix", async () => {
    const { fetch } = scriptedFetch([{ status: 403, body: { error: { code: "forbidden_scope", field: "operation", message: "This agent is not scoped to 'update_order'", retryable: false, suggested_fix: "Ask the organization to add the operation to the agent's scopes" } } }]);
    const tower = new Tower({ agentKey: "ow_agent_test", fetch });
    await assert.rejects(() => tower.submit("update_order", {}, { idempotencyKey: "c" }), (err: unknown) =>
      err instanceof OverwingError && err.status === 403 && err.code === "forbidden_scope" && err.field === "operation" && err.retryable === false && /add the operation/.test(err.suggestedFix ?? "") && /not scoped/.test(err.message));
  });

  it("waitForReview polls until the action leaves pending", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: action("pending") }, { status: 200, body: action("executed") }]);
    const tower = new Tower({ agentKey: "ow_agent_test", fetch });
    const a = await tower.waitForReview("7beeb669-ddc0-4b0c-b358-fc41e0181b9d", { intervalMs: 1000, timeoutMs: 10_000 });
    assert.equal(a.status, "executed");
    assert.equal(calls.length, 2);
  });

  it("verifies a receipt range", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { ok: true, checked: 4, first_break: null, from: 3, to: 6, signing_key_ids: ["k"], latest_sequence: 6 } }]);
    const tower = new Tower({ agentKey: "ow_agent_test", fetch, baseUrl: "https://example.test" });
    const r = await tower.receipts.verify({ from: 3 });
    assert.equal(r.ok, true);
    assert.equal(calls[0]?.url, "https://example.test/api/v1/tower/receipts/verify?from=3");
  });
});

describe("Tower setup on the main client", () => {
  it("creates an agent with the organization key and hands back a ready Tower client", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 201, body: { agent_id: "a1", name: "order-bot", scopes: ["create_order"], status: "active", key_prefix: "ow_agent_abc", created_at: "t", last_used_at: null, revoked_at: null, key: "ow_agent_minted", key_shown_once: true, use: "" } },
      { status: 200, body: { agent: { id: "a1", name: "order-bot", scopes: ["create_order"] }, operations: [] } },
    ]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    const { agent, tower } = await ow.tower.agent({ name: "order-bot", scopes: ["create_order"] });
    assert.equal(agent.key, "ow_agent_minted");
    assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
    await tower.capabilities();
    assert.equal(calls[1]?.url, "https://example.test/api/v1/tower/capabilities");
    assert.equal((calls[1]?.init.headers as Record<string, string>).Authorization, "Bearer ow_agent_minted");
  });

  it("revokes by id", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: { agent_id: "a1", status: "revoked" } }]);
    const ow = new Overwing({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test" });
    await ow.tower.agents.revoke("a1");
    assert.equal(calls[0]?.init.method, "DELETE");
    assert.equal(calls[0]?.url, "https://example.test/api/v1/tower/agents/a1");
  });
});
