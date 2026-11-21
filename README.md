<p align="center">
  <a href="https://overwing.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
      <img src="assets/wordmark.svg" alt="Overwing" width="220">
    </picture>
  </a>
</p>

<p align="center"><strong>Guardrails for LLM output, in one line.</strong><br>
Vercel AI SDK middleware, OpenAI Agents SDK guardrails, and a typed client. Also: <a href="#atlas-who-is-this-user-agent-no-key-needed">Atlas</a> user-agent lookups with no key, and <a href="#preflight-should-the-agent-sign-this-solana-transaction">Preflight</a> for checking a Solana transaction before an agent signs it. Every model response gets a <code>pass</code> / <code>fail</code> / <code>review</code> verdict with calibrated confidence before it reaches your user.</p>

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

It works with no key: `new Overwing().evaluate(text)` runs 10 evaluations a day on inputs up to 2,000 characters, and text sent without a key is not stored. For more, get a free API key at [overwing.ai](https://overwing.ai/login) (250 evaluations a day), or let your agent make its own account with `Overwing.signup()`, which needs no email (see [An account for an agent](#an-account-for-an-agent-no-email)).

The text can be in any language. It was tested on 2026-09-29 in Spanish, Portuguese, French, German, Japanese, Simplified Chinese, Korean, Arabic and Hindi: a small test, not a benchmark. Results come back in English.

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
| `fail`, recommended action `block` | Throws `OverwingGuardrailError` (carries the full evaluation) | `onFail: "replace" \| "annotate"` |
| `fail`, recommended action `redact` (e.g. personal data) | Replaces the text with the safe fallback instead of throwing | `honorActions: false` to treat every fail alike |

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
  context: (params) => ({ recipient: "customer", channel: "chat" }),   // facts the rules may reference
  honorActions: true,               // redact-level fails replace rather than throw
  onVerdict: (evaluation, phase) => console.log(phase, evaluation.verdict),
  failOpen: false,                  // true = if Overwing is unreachable, let the response through unscored
});
```

## OpenAI Agents SDK guardrails

```ts
import { Agent, run } from "@openai/agents";
import { overwingInputGuardrail, overwingOutputGuardrail } from "overwing/openai-agents";

const agent = new Agent({
  name: "Support",
  instructions: "Help the customer.",
  inputGuardrails: [overwingInputGuardrail()],     // scores the user's message
  outputGuardrails: [overwingOutputGuardrail()],   // scores the agent's final answer
});

try {
  const result = await run(agent, "Reach me at dana@example.com to sort out the refund.");
} catch (err) {
  // InputGuardrailTripwireTriggered / OutputGuardrailTripwireTriggered
  // err.result.output.outputInfo.evaluation → the full Overwing verdict
}
```

Both accept `ruleSet`, `tripOn: "fail" | "fail-or-review"`, `metadata`, `onVerdict`, and `failOpen`. Input guardrails run in parallel with the agent by default; pass `runInParallel: false` to block before the model is called.

## Atlas: who is this user agent? (no key needed)

[Overwing Atlas](https://overwing.ai/atlas) is a registry of AI crawlers, fetchers and browser agents. Give it a `User-Agent` string and it says what the string claims to be and whether that claim can be trusted.

```ts
import { Atlas } from "overwing";

const atlas = new Atlas(); // no key: 10 lookups a day. With OVERWING_API_KEY set: 100, or your Atlas plan's limit.

const who = await atlas.lookup(request.headers.get("user-agent") ?? "");
if (who.identified) {
  who.claims.agent;         // "GPTBot"
  who.claims.operator;      // "OpenAI"
  who.claims.purpose_class; // "Training / bulk crawl"
  who.claims.verification;  // "User-agent string only (spoofable)"
}
atlas.lastLookupLimit;      // { limit: 10, remaining: 9 }
```

Read `verification` before you act on the claim. `Web Bot Auth signature` means the operator signs its requests and you can check the signature. `User-agent string only (spoofable)` means anyone can send that string. When the allowance is spent, `lookup` throws an `OverwingError` with `status: 429` and `retryAfterSeconds`.

`atlas.agents({ purpose, operator, verification, q, limit })` searches the registry and `atlas.summary()` returns traffic shares and field-scan headlines. With an API key, the same client is at `new Overwing().atlas`.

### Register your own agent

If you run an agent or a crawler, add it to the registry so a lookup of its User-Agent names you. It is free and needs an API key.

```ts
const atlas = new Atlas({ apiKey: process.env.OVERWING_API_KEY });

const reg = await atlas.register({ name: "AcmeBot", operator: "Acme, Inc.", domain: "acme.com", tokens: ["AcmeBot"], purpose: "user_fetch" });
reg.verification?.dns;    // { type: "TXT", name: "_overwing-atlas.acme.com", value: "overwing-atlas-verification=..." }
reg.verification?.http;   // or serve the same value at https://acme.com/.well-known/overwing-atlas.txt

// publish either one, then:
const check = await atlas.verifyRegistration(reg.id);
if (check.verified) check.registration.status;   // "published", or "pending_review"
else check.error;                                // not found yet: what was looked for
```

`atlas.registrations()` lists yours and `atlas.withdrawRegistration(id)` takes one out. Registration proves control of the operator's domain. A User-Agent is still a string anyone can send, so the entry is listed as user-agent only unless `keyDirectoryUrl` is a Web Bot Auth key directory on that domain.

## Beacon: is your product reachable by agents? (free)

[Overwing Beacon](https://overwing.ai/beacon) checks one site and answers three questions: can an agent find it, read it, and use it. It looks for robots.txt rules for AI agents, llms.txt, an MCP server card and endpoint, an A2A agent card and an OpenAPI document, and reads the home page the way an agent does. A check is free: with a key you get the full report, saved to your dashboard; with no key you get the summary (the score, the three answers and the first fix).

```ts
import { Beacon } from "overwing";

const beacon = new Beacon();                     // { apiKey } or OVERWING_API_KEY for the full report
(await beacon.sample()).top_fixes;               // a real report in full, to see the shape

const { id } = await beacon.start("example.com");
const report = await beacon.waitForReport(id);   // the first read runs the check
if (report.status === "complete") {
  report.score;                                  // 0 to 100
  report.verdict;                                // "yes" | "partly" | "no"
  report.categories;                             // find, read, use, each with an answer
  report.top_fixes;                              // [{ check, fix, gain }], most valuable first
  if (report.access === "full") report.checks;   // every check, with what was found and a fix
  else report.counts;                            // no key: the summary, and what the full report holds
}
```

A key is free: `POST https://overwing.ai/api/v1/signup` returns one, and `new Overwing({ apiKey }).beacon` uses it. An agent with a wallet and no account can pass `beacon.x402Url("example.com")` to any x402 client, pay $1 in USDC, and get the full report as the response.

## Preflight: should the agent sign this Solana transaction?

[Overwing Preflight](https://overwing.ai/preflight) checks one unsigned Solana transaction against your policy before an agent signs it. It simulates the transaction against the chain as it is now, works out what it would take from the wallet you name (SOL, tokens, and control of its token accounts), and answers `allow` or `refuse` with every reason. It never sees a private key and sends nothing to the chain.

The check only protects an agent that cannot sign without it, so put it in the wallet. `withPreflight` wraps a wallet and returns one with the same interface:

```ts
import { withPreflight, PreflightRefused } from "overwing/solana";

const wallet = withPreflight(myWallet, {
  policy: { max_sol_out: 0.05 },                  // reads OVERWING_API_KEY; `wallet` defaults to myWallet.publicKey
  onVerdict: (verdict) => console.log(verdict.id, verdict.decision),
});

try {
  await wallet.signTransaction(tx);               // checked first; signed only on "allow"
} catch (err) {
  if (err instanceof PreflightRefused) err.verdict.reasons;   // [{ code: "sol_out_exceeds_limit", detail: "..." }]
  else throw err;                                 // PreflightUnavailable: no verdict, nothing signed
}
```

What it does:

- Checks `signTransaction`, `signAllTransactions`, `signAndSendTransaction`, `signAndSendAllTransactions` and `sendTransaction`, whichever the wallet has. With several transactions, every one is checked and none is signed unless all are allowed.
- Fails closed. A refusal throws `PreflightRefused` (it carries the verdict). No verdict (an HTTP error, a timeout, a malformed answer) throws `PreflightUnavailable`. Either way the wallet's own sign function is never called.
- `onUnavailable: "allow"` signs unchecked when Preflight cannot answer (unreachable, timed out, 5xx, malformed). It never overrides a refusal, a spent allowance (429), or a request Preflight rejected as wrong (400, 401, 403) still throws, so a bad key cannot switch the check off.
- `policy` can be a function, to set limits per transaction: `policy: (tx) => ({ max_sol_out: 0.01, allowed_programs: [...] })`.
- `wallet.preflight.lastVerdict` holds the latest verdict, and `lastVerdicts` every verdict of the last call.
- Works with the legacy `Transaction` and with `VersionedTransaction`. Set the fee payer and recent blockhash before signing, as the transaction is serialized for the check. This package has no Solana dependency: wallets and transactions are typed by shape.
- `signMessage` cannot be checked. It passes through unless you set `signMessage: "refuse"`.

A verdict covers a transaction that lands within `valid_for_seconds` (120), so sign and send at once. The check is advice to whoever holds the key: code that reaches the unwrapped wallet or the keypair is not protected.

### Solana Agent Kit

[Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) v2 takes a wallet that implements its `BaseWallet`. The wrapped wallet has the type of the wallet you gave it, so it goes straight in:

```ts
import { KeypairWallet, SolanaAgentKit } from "solana-agent-kit";
import TokenPlugin from "@solana-agent-kit/plugin-token";
import { withPreflight } from "overwing/solana";

const wallet = withPreflight(new KeypairWallet(keypair, RPC_URL), {
  policy: { max_sol_out: 0.05, allow_delegation: false },
});

const agent = new SolanaAgentKit(wallet, RPC_URL, {}).use(TokenPlugin);
// Every transaction the kit's actions build is checked before the keypair signs it.
```

Checked against `solana-agent-kit` 2.0.10. Each check counts as one evaluation, and some kit actions sign more than once per transaction sent.

### The client

```ts
import { Preflight } from "overwing";

const preflight = new Preflight();                       // OVERWING_API_KEY, or new Overwing().preflight
const verdict = await preflight.check({
  transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }),   // bytes or base64
  policy: { wallet: "<address>", max_sol_out: 0.05, max_token_out: { "<mint>": "1000" }, allowed_programs: ["11111111111111111111111111111111"] },
});
if (verdict.decision !== "allow") return;                // do not sign; verdict.reasons says why

await preflight.report(verdict.id, signature);           // after it lands: { outcome: "miss" | "not_a_miss", ... }
await preflight.verdict(verdict.id);                     // the public record of one verdict
await preflight.record();                                // totals, misses, latest verdicts
await preflight.overview();                              // policy fields and reason codes
```

`check` needs a key and throws `OverwingError` when no verdict was given (400, 401, 429, 502). An error is not an allow. `verdict`, `report`, `record` and `overview` need no key. Give the SOL limit as `max_sol_out` or as `max_sol_out_lamports`, never both. An agent with a wallet and no account can post the same body to `preflight.x402Url()` with any x402 client and pay $0.01 in USDC.

## Radar: are agents acting together on a shared store?

[Overwing Radar](https://overwing.ai/radar) watches shared stores (a cache, a queue, a scratch bucket, a place where keys are kept) for agents acting together, and for one stolen login behaving like a machine. You report who touched which entry, with a hash and a size and never the contents, and Radar groups what it finds into incidents that say what to do. Radar recommends: it changes nothing on your systems.

```ts
import { Radar } from "overwing";

const radar = new Radar();                       // OVERWING_API_KEY, or new Overwing().radar

await radar.sendEvents([
  { id: "evt-000001", surfaceId: "scratch-bucket", artifactId: "notes/plan.md", actorId: "agent-17", principalId: "team-a",
    op: "read", ts: new Date(), contentHash: "sha256:9f2c0e...", sizeBytes: 812 },
  { id: "evt-000002", surfaceId: "scratch-bucket", artifactId: "out/agent-17/step.txt", actorId: "agent-17", principalId: "team-a",
    op: "write", ts: new Date(), contentHash: "sha256:41bd77...", parentArtifactHash: "sha256:9f2c0e...", sizeBytes: 240 },
]);                                              // { accepted: 2, duplicates: 0, drill_id: null }

const { incidents } = await radar.listIncidents({ status: "open" });
for (const incident of incidents) {
  incident.severity;                             // "low" | "medium" | "high" | "critical"
  incident.detectors;                            // ["sweep"], ["decoy_touch", "sweep"], ...
  incident.recommended_actions;                  // [{ action: "revoke_identity", surface: null, actors: ["agent-17"], reason: "..." }]
  incident.enforced;                             // always false
}

const first = incidents[0];
if (first) {
  const detail = await radar.getIncident(first.id);   // adds `evidence` and a `timeline` of the events it names
  await radar.closeIncident(first.id);                // once it is dealt with
}
```

What to know about events:

- The fields are camelCase here and are sent under the API's names (`surface_id`, `content_hash`, ...). `ts` is a `Date`, an ISO 8601 time, or milliseconds since the epoch.
- Up to 500 events and 1,000,000 bytes a call. A batch is taken whole or not at all: one bad event refuses it, and the `OverwingError` message names it.
- An event `id` sent again is counted once, so send the same batch again when no answer came back.
- Send `principalId` (who the actor works for) wherever you know it. Actors that share one are never a finding.
- Report the reads and listings, not only the writes.

Every Radar call needs a key, and fails with an `OverwingError` before any request when there is none. A key of scope `swarm` can call `sendEvents`, `sendCloudTrail` and `reportResponse` and nothing else, so it is the one to put in the infrastructure you are watching. The rest needs a key of scope `full`.

### A decoy key

A decoy key looks like a model gateway's address and key, and nothing legitimate uses it. Keep it where real keys are kept. The first request that carries it opens a critical incident naming that place and the address the request came from.

```ts
const decoy = await radar.mintDecoy({ surfaceId: "ci-secrets", kind: "key", label: "llm gateway" });

decoy.content;    // "# internal model gateway\nLLM_GATEWAY_BASE_URL=https://...\nLLM_GATEWAY_API_KEY=sk-gw-...\n"
decoy.base_url;   // the same two values, to store in the form your own secrets take
decoy.key;
decoy.id;         // "swd_...": radar.retireDecoy(decoy.id) retires it
```

`key` and `content` are in the answer once and are never stored, so write them where they go at once. `surfaceId` is your name for that place; it does not have to be a surface you send events for. Use one key per place, so an incident says which place was read.

`radar.mintDecoy({ surfaceId, kind })` with `kind` `"notes"`, `"credentials"`, `"export"` or `"config"` mints an entry to plant on a surface you do send events for: write `content` to `artifact_id` there and report that write with the same `content_hash`. `radar.registerDecoy({ surfaceId, artifactId, contentHash })` registers an entry of your own. `radar.listDecoys()` lists them.

### The webhook

If your organization has a webhook set, Radar posts `swarm.incident.opened` when an incident opens and `swarm.incident.updated` when it becomes more severe. Check the signature before you read the body:

```ts
import { verifyRadarWebhook } from "overwing";
import type { RadarIncidentWebhook } from "overwing";

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();              // the body as it arrived, not parsed and re-serialized
  const genuine = await verifyRadarWebhook(process.env.OVERWING_WEBHOOK_SECRET!, request.headers.get("x-overwing-signature"), raw);
  if (!genuine) return new Response(null, { status: 401 });

  const event = JSON.parse(raw) as RadarIncidentWebhook;
  event.data.severity;                           // "critical"
  event.data.recommended_actions;
  event.data.response;                           // { requested: false }, or the actions your responder is asked for
  return new Response(null, { status: 204 });
}
```

`verifyRadarWebhook(secret, signatureHeader, rawBody, { toleranceSeconds, now })` resolves to `true` only when the `X-Overwing-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`) matches your webhook secret over that exact body and the timestamp is within `toleranceSeconds` of now (default 300). A missing or malformed header resolves to `false`. It uses WebCrypto, so it runs wherever the client does.

The webhook asks your responder to act only if you switch that on: `radar.setThresholds({ response: { enabled: true, minSeverity: "critical" } })`. Overwing still acts on nothing. Your own code does, with your own credentials, and can put what it did on the incident's record:

```ts
await radar.reportResponse(event.data.id, { action: "revoke_identity", status: "done", target: "arn:aws:iam::111122223333:user/svc-reports", by: "responder-east" });
await radar.listResponses(event.data.id);        // { responses: [...], contained_in_seconds: 42 }
```

Also on the client: `status()` (events this month, the allowance and the limits), `listSurfaces()` and `nameSurface(id, { kind, label })`, `getThresholds()` and `setThresholds(changes)`, and `sendCloudTrail(body)` for a CloudTrail log file or an EventBridge event. `setThresholds` replaces everything the account changed before, it does not merge with it: send every part that should differ from the defaults, or `{}` to restore them all. The guides are at [overwing.ai/radar](https://overwing.ai/radar).

## Client

```ts
import { Overwing } from "overwing";

const ow = new Overwing({ apiKey: process.env.OVERWING_API_KEY }); // or new Overwing() to try it with no key

const e = await ow.evaluate("Reach me at dana@example.com to sort out the refund.");
// e.verdict === "fail"; e.recommended_action === "redact"
// e.results → [{ rule: "pii_detected", verdict: "fail", action: "redact", confidence: 0.98, … }, …]

// Give the rules context and use the context-aware prebuilt set:
const ok = await ow.evaluate("Reach me at dana@example.com to sort out the refund.", {
  ruleSet: "outbound-message",
  context: { recipient: "one known customer", channel: "email", owns_contact_info: true },
});
// ok.verdict === "pass": the details are the sender's own, deliberately shared

const batch = await ow.evaluateBatch([{ id: "a", input: "…" }, { id: "b", input: "…" }]);
const custom = await ow.ruleSets.create({ name: "Support tone", slug: "support-tone", rules: [/* … */] });
const usage = await ow.usage();
ow.lastRateLimit; // { daily: { remaining, resetAt }, burst: { … } } from the last evaluate call
```

Everything on the API is covered: `evaluate`, `evaluateBatch`, `evaluations.get/list/delete`, `ruleSets.list/get/create/update/delete`, `usage`, `me`. Errors are `OverwingError` with `status` and `retryAfterSeconds`, plus `code`, `field`, `retryable` and `suggestedFix` when the API supplies them. 429s with a short `Retry-After` and 5xx are retried automatically. Pass `idempotencyKey` to make retries safe.

Runs anywhere `fetch` exists: Node 20+, Bun, Deno, Vercel Edge, Cloudflare Workers.

### An account for an agent (no email)

An agent has no inbox, and should not put a person's address on an account that person did not ask for. So an account needs no email:

```ts
const { account, client } = await Overwing.signup();   // nothing is sent to anyone
saveSomewhereSafe(account.api_key);                    // shown once; there is no reset link
await client.evaluate("…");                            // 50 evaluations a day to start
```

A domain the account proves it controls takes the place of the email. It raises the limits to the normal free tier, opens full Beacon reports, and makes a lost key recoverable:

```ts
const proof = await client.account.proveDomain("acme.com");
proof.verification?.dns;    // publish this TXT record, or serve proof.verification.http.body at .http.url
const check = await client.account.verifyDomain();
if (!check.verified) check.error;                      // not there yet; DNS can take a few minutes

// Key lost: prove the domain again. Every old key is revoked and one new key is returned.
const started = await Overwing.startRecovery("acme.com");
const { recovered, client: again } = await Overwing.finishRecovery("acme.com");
```

Registering an agent in Atlas on a domain (`atlas.register`) proves that domain for the account in the same step. `client.account.claim(email, password)` lets a person take charge later and get a dashboard login.

## Data handling

Text you evaluate is sent to the Overwing API and from there to TypeSafe, whose Jev model produces the verdict. It is not used to train models. Without a key it is never stored. With a key, the text, context and verdict are stored so you can read them back, until you delete them; pass `store: false` to keep no text or context for a call:

```ts
await ow.evaluate(text, { store: false });
```

Organization-wide settings (`store_inputs`, `retention_days`) and keys restricted to running checks (`scope: "evaluate"`) are described at [overwing.ai/security](https://overwing.ai/security), along with subprocessors and how to report a vulnerability.

## How verdicts work

Each rule has a fail condition, an optional review threshold, and a weight. The prebuilt `content-safety` set checks toxicity, personal data, self-harm, sexual content, and severity. **fail** means a rule matched. **review** means a rule was unsure. **pass** is everything else. Full guide: [overwing.ai/llms.txt](https://overwing.ai/llms.txt). Reference: [overwing.ai/docs](https://overwing.ai/docs).

## Also from Overwing

- MCP: the same tools for Claude, Cursor and any MCP client, hosted at `https://overwing.ai/mcp` with no install, or from npm as [`overwing-mcp`](https://github.com/frod27/overwing-mcp).
- A2A: `https://overwing.ai/a2a` answers "send message" for evaluations and User-Agent lookups.
- Python: [`pip install overwing`](https://github.com/frod27/overwing-python).

MIT © Overwing. Verdicts are produced by TypeSafe's Jev System One model; Overwing is not affiliated with TypeSafe.
