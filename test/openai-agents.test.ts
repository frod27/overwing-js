import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing } from "../dist/index.js";
import { overwingInputGuardrail, overwingOutputGuardrail, textFromInput } from "../dist/openai-agents.js";
import { fakeEvaluation, scriptedFetch } from "./helpers.ts";

const ctx = {} as never;
const agent = {} as never;

describe("openai-agents guardrails", () => {
  it("extracts user text from strings and model item lists", () => {
    assert.equal(textFromInput("  hi  "), "hi");
    assert.equal(textFromInput([{ role: "system", content: "x" }, { role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }]), "a\nb");
    assert.equal(textFromInput([{ role: "user", content: "plain" }]), "plain");
    assert.equal(textFromInput(42), "");
  });

  it("input guardrail trips on fail and carries the evaluation", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("fail") }]);
    const g = overwingInputGuardrail({ client: new Overwing({ apiKey: "k", fetch }), metadata: { user: "u1" } });
    assert.equal(g.name, "overwing-input");
    const r = await g.execute({ input: "you idiot", context: ctx, agent });
    assert.equal(r.tripwireTriggered, true);
    assert.equal((r.outputInfo as { evaluation: { verdict: string } }).evaluation.verdict, "fail");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.equal(sent.metadata.phase, "input");
    assert.equal(sent.metadata.user, "u1");
  });

  it("review does not trip by default, but does with tripOn fail-or-review", async () => {
    const a = overwingInputGuardrail({ client: new Overwing({ apiKey: "k", fetch: scriptedFetch([{ status: 200, body: fakeEvaluation("review") }]).fetch }) });
    assert.equal((await a.execute({ input: "hmm", context: ctx, agent })).tripwireTriggered, false);
    const b = overwingInputGuardrail({ client: new Overwing({ apiKey: "k", fetch: scriptedFetch([{ status: 200, body: fakeEvaluation("review") }]).fetch }), tripOn: "fail-or-review" });
    assert.equal((await b.execute({ input: "hmm", context: ctx, agent })).tripwireTriggered, true);
  });

  it("output guardrail scores text and structured output", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeEvaluation("pass") }, { status: 200, body: fakeEvaluation("pass") }]);
    const g = overwingOutputGuardrail({ client: new Overwing({ apiKey: "k", fetch }) });
    assert.equal((await g.execute({ agentOutput: "All good.", context: ctx, agent })).tripwireTriggered, false);
    await g.execute({ agentOutput: { reply: "structured" } as never, context: ctx, agent });
    assert.equal(JSON.parse(String(calls[1]?.init.body)).input, '{"reply":"structured"}');
  });

  it("skips empty output and fails open only when asked", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 500, body: { error: "boom" } }]);
    const strict = overwingOutputGuardrail({ client: new Overwing({ apiKey: "k", fetch, maxRetries: 0 }) });
    const empty = await strict.execute({ agentOutput: "", context: ctx, agent });
    assert.deepEqual(empty.outputInfo, { evaluation: null, skipped: "empty" });
    assert.equal(calls.length, 0);
    await assert.rejects(() => strict.execute({ agentOutput: "text", context: ctx, agent }));
    const open = overwingOutputGuardrail({ client: new Overwing({ apiKey: "k", fetch: scriptedFetch([{ status: 500, body: { error: "boom" } }]).fetch, maxRetries: 0 }), failOpen: true });
    const r = await open.execute({ agentOutput: "text", context: ctx, agent });
    assert.equal(r.tripwireTriggered, false);
    assert.equal((r.outputInfo as { skipped?: string }).skipped, "unreachable");
  });
});
