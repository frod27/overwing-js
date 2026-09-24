import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing } from "../dist/index.js";
import { OverwingGuardrailError, overwingGuardrail } from "../dist/ai-sdk.js";
import { fakeEvaluation, scriptedFetch } from "./helpers.ts";

type Part = { type: string; [k: string]: unknown };
const params = { prompt: [{ role: "user", content: [{ type: "text", text: "hi there" }] }] } as never;
const model = {} as never;

function generateResult(text: string) {
  return { content: [{ type: "text" as const, text }], finishReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
}

function streamOf(parts: Part[]): { stream: ReadableStream<Part> } {
  return { stream: new ReadableStream<Part>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
}

async function collect(stream: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const reader = stream.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; out.push(value); }
  return out;
}

const textParts: Part[] = [{ type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "Hello " }, { type: "text-delta", id: "t1", delta: "world" }, { type: "text-end", id: "t1" }, { type: "finish", finishReason: "stop", usage: {} }];

describe("overwingGuardrail (generate)", () => {
  it("passes clean output through and annotates providerMetadata", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), metadata: () => ({ user: "u1" }) });
    const r = await mw.wrapGenerate!({ doGenerate: async () => generateResult("Hello world"), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal((r.content[0] as { text: string }).text, "Hello world");
    assert.equal((r.providerMetadata as { overwing: { verdict: string } }).overwing.verdict, "pass");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.equal(sent.input, "Hello world");
    assert.equal(sent.metadata.user, "u1");
    assert.equal(sent.metadata.phase, "output");
  });

  it("throws on fail by default, carrying the evaluation", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }) });
    await assert.rejects(
      () => mw.wrapGenerate!({ doGenerate: async () => generateResult("you idiot"), doStream: async () => { throw new Error("unused"); }, params, model }),
      (err: unknown) => err instanceof OverwingGuardrailError && err.evaluation.verdict === "fail" && err.phase === "output" && /toxicity=fail/.test(err.message),
    );
  });

  it("replaces failed output when configured", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), onFail: "replace", replacement: (e) => `Blocked (${e.id})` });
    const r = await mw.wrapGenerate!({ doGenerate: async () => generateResult("bad"), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal((r.content[0] as { text: string }).text, "Blocked (eval_0000000000000001)");
  });

  it("review is annotated by default and can be escalated to throw", async () => {
    const a = scriptedFetch([{ status: 200, body: fakeEvaluation("review") }]);
    const mwA = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch: a.fetch }) });
    const r = await mwA.wrapGenerate!({ doGenerate: async () => generateResult("hmm"), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal((r.providerMetadata as { overwing: { review_rules: string } }).overwing.review_rules, "pii_detected");
    const b = scriptedFetch([{ status: 200, body: fakeEvaluation("review") }]);
    const mwB = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch: b.fetch }), onReview: "throw" });
    await assert.rejects(() => mwB.wrapGenerate!({ doGenerate: async () => generateResult("hmm"), doStream: async () => { throw new Error("unused"); }, params, model }), OverwingGuardrailError);
  });

  it("skips scoring when there is no text, and fails open only when asked", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 500, body: { error: "boom" } }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch, maxRetries: 0 }) });
    const r = await mw.wrapGenerate!({ doGenerate: async () => ({ ...generateResult(""), content: [] }), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal(r.content.length, 0);
    assert.equal(calls.length, 0);
    await assert.rejects(() => mw.wrapGenerate!({ doGenerate: async () => generateResult("text"), doStream: async () => { throw new Error("unused"); }, params, model }));
    const open = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch: scriptedFetch([{ status: 500, body: { error: "boom" } }]).fetch, maxRetries: 0 }), failOpen: true });
    const r2 = await open.wrapGenerate!({ doGenerate: async () => generateResult("text"), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal((r2.content[0] as { text: string }).text, "text");
  });

  it("checks input when enabled and throws on a failing prompt", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), checkInput: true });
    await assert.rejects(() => mw.transformParams!({ type: "generate", params, model }), (err: unknown) => err instanceof OverwingGuardrailError && err.phase === "input");
    assert.equal(JSON.parse(String(calls[0]?.init.body)).input, "hi there");
  });
});

describe("overwingGuardrail (actions)", () => {
  it("a redact-level fail replaces instead of throwing, and context is forwarded", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail", "eval_0000000000000002", "redact") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), context: () => ({ recipient: "customer", channel: "chat" }) });
    const r = await mw.wrapGenerate!({ doGenerate: async () => generateResult("call me at 555-0142"), doStream: async () => { throw new Error("unused"); }, params, model });
    assert.equal((r.content[0] as { text: string }).text, "I can't share that response.");
    assert.equal((r.providerMetadata as { overwing: { recommended_action: string } }).overwing.recommended_action, "redact");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)).context, { recipient: "customer", channel: "chat" });
    const strict = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch: scriptedFetch([{ status: 200, body: fakeEvaluation("fail", "eval_0000000000000002", "redact") }]).fetch }), honorActions: false });
    await assert.rejects(() => strict.wrapGenerate!({ doGenerate: async () => generateResult("call me"), doStream: async () => { throw new Error("unused"); }, params, model }), OverwingGuardrailError);
  });
});

describe("overwingGuardrail (stream)", () => {
  it("buffers by default: releases text only after a passing verdict", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }) });
    const { stream } = await mw.wrapStream!({ doStream: async () => streamOf(textParts) as never, doGenerate: async () => { throw new Error("unused"); }, params, model });
    const parts = await collect(stream as ReadableStream<Part>);
    assert.deepEqual(parts.map((p) => p.type), ["text-start", "text-delta", "text-delta", "text-end", "finish"]);
    assert.equal((parts[4]!.providerMetadata as { overwing: { verdict: string } }).overwing.verdict, "pass");
  });

  it("buffers and replaces a failing stream so no original token leaks", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), onFail: "replace" });
    const { stream } = await mw.wrapStream!({ doStream: async () => streamOf(textParts) as never, doGenerate: async () => { throw new Error("unused"); }, params, model });
    const parts = await collect(stream as ReadableStream<Part>);
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
    assert.equal(text, "I can't share that response.");
    assert.equal(parts.at(-1)?.type, "finish");
  });

  it("throw action ends the stream with an error part", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }) });
    const { stream } = await mw.wrapStream!({ doStream: async () => streamOf(textParts) as never, doGenerate: async () => { throw new Error("unused"); }, params, model });
    const parts = await collect(stream as ReadableStream<Part>);
    assert.deepEqual(parts.map((p) => p.type), ["error"]);
    assert.ok(parts[0]!.error instanceof OverwingGuardrailError);
  });

  it("passthrough streams tokens immediately and still scores at the end", async () => {
    const { fetch } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass") }]);
    const mw = overwingGuardrail({ client: new Overwing({ apiKey: "k", fetch }), streaming: "passthrough" });
    const { stream } = await mw.wrapStream!({ doStream: async () => streamOf(textParts) as never, doGenerate: async () => { throw new Error("unused"); }, params, model });
    const parts = await collect(stream as ReadableStream<Part>);
    assert.equal(parts.length, 5);
    assert.equal((parts[4]!.providerMetadata as { overwing: { id: string } }).overwing.id, "eval_0000000000000001");
  });
});
