<p align="center">
  <a href="https://overwing.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
      <img src="assets/wordmark.svg" alt="Overwing" width="220">
    </picture>
  </a>
</p>

<p align="center"><strong>Guardrails for LLM output, in one line.</strong><br>
Every model response gets a <code>pass</code> / <code>fail</code> / <code>review</code> verdict with calibrated confidence before it reaches your user.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/overwing"><img alt="npm" src="https://img.shields.io/npm/v/overwing?color=0B1220&label=overwing"></a>
  <a href="https://github.com/frod27/overwing-js/actions"><img alt="CI" src="https://github.com/frod27/overwing-js/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://overwing.ai/docs"><img alt="API reference" src="https://img.shields.io/badge/API-reference-0B1220"></a>
  <a href="https://overwing.ai"><img alt="agents welcome" src="https://overwing.ai/badge.svg"></a>
</p>

---

```bash
npm install overwing
```

Get a free API key at [overwing.ai](https://overwing.ai/login) (250 evaluations a day), or let your agent sign itself up with one `POST` to `/api/v1/signup`. Try it first with no key: paste anything into the console at [overwing.ai](https://overwing.ai).

## Vercel AI SDK middleware

Wrap any model. Works with AI SDK 6 and 7 (`generateText`, `streamText`, `generateObject`, agents, everything).

```ts
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { overwingGuardrail } from "overwing/ai-sdk";

const model = wrapLanguageModel({
  model: openai("gpt-5"),
  middleware: overwingGuardrail(), // reads OVERWING_API_KEY
});

const { text, providerMetadata } = await generateText({ model, prompt: "Draft a reply to this customer." });
console.log(providerMetadata?.overwing); // { verdict: "pass", confidence: 0.97, id: "eval_…", … }
```

What happens by default:

| Verdict | Default action | Change it with |
| --- | --- | --- |
| `pass` | Response returned, verdict attached to `providerMetadata.overwing` | |
| `review` | Returned and annotated so you can route it | `onReview: "throw" \| "replace"` |
| `fail` | Throws `OverwingGuardrailError` (carries the full evaluation) | `onFail: "replace" \| "annotate"` |

Streaming is **buffered by default**: tokens are held until the model finishes and the verdict is in, so a failing response never reaches the screen. Set `streaming: "passthrough"` to stream immediately and end with an error on fail.

```ts
overwingGuardrail({
  ruleSet: "content-safety",        // or your own rule set slug
  onFail: "replace",                // "throw" (default) | "replace" | "annotate"
  onReview: "annotate",             // "annotate" (default) | "throw" | "replace"
  replacement: "I can't share that response.",
  checkInput: true,                 // also score the user's latest message before calling the model
  streaming: "buffer",              // "buffer" (default) | "passthrough"
  metadata: (params) => ({ userId: "u_123" }),
  onVerdict: (evaluation, phase) => console.log(phase, evaluation.verdict),
  failOpen: false,                  // true = if Overwing is unreachable, let the response through unscored
});
```

## Client

```ts
import { Overwing } from "overwing";

const ow = new Overwing({ apiKey: process.env.OVERWING_API_KEY });

const e = await ow.evaluate("Reach me at dana@example.com to sort out the refund.");
// e.verdict === "fail"; e.results → [{ rule: "pii_detected", verdict: "fail", confidence: 0.98, … }, …]

const batch = await ow.evaluateBatch([{ id: "a", input: "…" }, { id: "b", input: "…" }]);
const custom = await ow.ruleSets.create({ name: "Support tone", slug: "support-tone", rules: [/* … */] });
const usage = await ow.usage();
ow.lastRateLimit; // { daily: { remaining, resetAt }, burst: { … } } from the last evaluate call
```

Everything on the API is covered: `evaluate`, `evaluateBatch`, `evaluations.get/list/delete`, `ruleSets.list/get/create/update/delete`, `usage`, `me`. Errors are `OverwingError` with `status` and `retryAfterSeconds`. 429s with a short `Retry-After` and 5xx are retried automatically. Pass `idempotencyKey` to make retries safe.

Runs anywhere `fetch` exists: Node 20+, Bun, Deno, Vercel Edge, Cloudflare Workers.

## How verdicts work

Each rule has a fail condition, an optional review threshold, and a weight. The prebuilt `content-safety` set checks toxicity, personal data, self-harm, sexual content, and severity. **fail** means a rule matched. **review** means a rule was unsure. **pass** is everything else. Full guide: [overwing.ai/llms.txt](https://overwing.ai/llms.txt). Reference: [overwing.ai/docs](https://overwing.ai/docs).

## Also from Overwing

- [`overwing-mcp`](https://github.com/frod27/overwing-mcp): the same guardrails as MCP tools for Claude, Cursor, and any MCP client.

MIT © Overwing. Verdicts are produced by TypeSafe's Jev System One model; Overwing is not affiliated with TypeSafe.
