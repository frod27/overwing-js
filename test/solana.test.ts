import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Overwing, Preflight } from "../dist/index.js";
import { PreflightRefused, PreflightUnavailable, serializeTransaction, withPreflight } from "../dist/solana.js";
import { fakeVerdict, scriptedFetch } from "./helpers.ts";

const ADDRESS = "Wa11etAddre55111111111111111111111111111111";

/** Shaped like web3.js `Transaction`: it will not serialize unsigned unless told the signatures are not required. */
class FakeLegacyTransaction {
  signed = false;
  readonly bytes: number[];
  constructor(bytes: number[] = [1, 2, 3, 4]) { this.bytes = bytes; }
  serialize(config?: { requireAllSignatures?: boolean; verifySignatures?: boolean }): Buffer {
    if (!this.signed && (config?.requireAllSignatures !== false || config?.verifySignatures !== false)) throw new Error("Signature verification failed");
    return Buffer.from(this.bytes);
  }
}

/** Shaped like web3.js `VersionedTransaction`: `version`, and a serialize that takes nothing. */
class FakeVersionedTransaction {
  readonly version = 0;
  signed = false;
  readonly bytes: number[];
  constructor(bytes: number[] = [128, 250, 251, 252]) { this.bytes = bytes; }
  serialize(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

type Tx = FakeLegacyTransaction | FakeVersionedTransaction;

/** Shaped like Solana Agent Kit's `BaseWallet`. The key is a private field, so a method called on the wrong `this` fails. */
class FakeWallet {
  readonly publicKey = { toBase58: () => ADDRESS, toString: () => ADDRESS };
  readonly calls: string[] = [];
  #key = "never leaves this object";
  #sign<T extends Tx>(t: T): T {
    if (!this.#key) throw new Error("no key");
    t.signed = true;
    return t;
  }
  async signTransaction<T extends Tx>(transaction: T): Promise<T> {
    this.calls.push("signTransaction");
    return this.#sign(transaction);
  }
  async signAllTransactions<T extends Tx>(transactions: T[]): Promise<T[]> {
    this.calls.push("signAllTransactions");
    return transactions.map((t) => this.#sign(t));
  }
  async signAndSendTransaction<T extends Tx>(transaction: T, options?: { skipPreflight?: boolean }): Promise<{ signature: string }> {
    this.calls.push(`signAndSendTransaction:${JSON.stringify(options ?? null)}`);
    // Its own inner call must not be checked a second time.
    await this.signTransaction(transaction);
    return { signature: "5ignature" };
  }
  async sendTransaction<T extends Tx>(transaction: T): Promise<string> {
    this.calls.push("sendTransaction");
    this.#sign(transaction);
    return "5ent";
  }
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    this.calls.push("signMessage");
    return this.#key ? message : new Uint8Array();
  }
}

function setup(responses: Array<{ status: number; body: unknown }>, extra: Record<string, unknown> = {}, policy: unknown = { max_sol_out: 0.05 }) {
  const { fetch, calls } = scriptedFetch(responses);
  const inner = new FakeWallet();
  const wallet = withPreflight(inner, { client: new Preflight({ apiKey: "ow_live_test", fetch, baseUrl: "https://example.test", maxRetries: 0 }), policy: policy as never, ...extra });
  const sent = () => calls.map((c) => JSON.parse(String(c.init.body)) as { transaction: string; policy: Record<string, unknown> });
  return { inner, wallet, calls, sent };
}

describe("withPreflight", () => {
  it("allow passes through and signs, with the wallet address filled in", async () => {
    const { inner, wallet, calls, sent } = setup([{ status: 200, body: fakeVerdict("allow") }]);
    const tx = new FakeLegacyTransaction();
    const signed = await wallet.signTransaction(tx);
    assert.equal(signed, tx);
    assert.equal(tx.signed, true);
    assert.deepEqual(inner.calls, ["signTransaction"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.test/api/v1/preflight/checks");
    assert.deepEqual(sent()[0], { transaction: "AQIDBA==", policy: { max_sol_out: 0.05, wallet: ADDRESS } });
    assert.equal(wallet.preflight.lastVerdict?.id, "pfc_0000000000000001");
    assert.equal(wallet.preflight.lastError, null);
  });

  it("keeps the wallet's own interface: public key, instance, and methods it does not check", async () => {
    const { inner, wallet, calls } = setup([{ status: 200, body: fakeVerdict("allow") }]);
    assert.equal(wallet.publicKey, inner.publicKey);
    assert.equal(wallet instanceof FakeWallet, true);
    assert.equal("preflight" in wallet && "signTransaction" in wallet, true);
    assert.equal(wallet.signTransaction, wallet.signTransaction);
    assert.deepEqual(await wallet.signMessage(new Uint8Array([9])), new Uint8Array([9]));
    assert.equal(calls.length, 0);
  });

  it("refuse throws PreflightRefused with the verdict and the wallet's sign function is never called", async () => {
    for (const method of ["signTransaction", "signAndSendTransaction", "sendTransaction"] as const) {
      const { inner, wallet } = setup([{ status: 200, body: fakeVerdict("refuse") }]);
      const tx = new FakeVersionedTransaction();
      await assert.rejects(wallet[method](tx), (err: unknown) => err instanceof PreflightRefused && err.verdict.decision === "refuse" && err.verdict.reasons[0]?.code === "sol_out_exceeds_limit" && err.message.includes("pfc_0000000000000001"));
      assert.deepEqual(inner.calls, []);
      assert.equal(tx.signed, false);
      assert.equal(wallet.preflight.lastVerdict?.decision, "refuse");
    }
  });

  it("checks signAndSendTransaction and sendTransaction once each, and passes their arguments on", async () => {
    const { inner, wallet, calls } = setup([{ status: 200, body: fakeVerdict("allow") }]);
    assert.deepEqual(await wallet.signAndSendTransaction(new FakeVersionedTransaction(), { skipPreflight: true }), { signature: "5ignature" });
    assert.equal(calls.length, 1);
    assert.equal(await wallet.sendTransaction(new FakeLegacyTransaction()), "5ent");
    assert.equal(calls.length, 2);
    assert.deepEqual(inner.calls, ['signAndSendTransaction:{"skipPreflight":true}', "signTransaction", "sendTransaction"]);
  });

  it("a network failure fails closed", async () => {
    const inner = new FakeWallet();
    let attempts = 0;
    const fetch = (async () => { attempts += 1; throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch;
    const errors: unknown[] = [];
    const wallet = withPreflight(inner, { client: new Overwing({ apiKey: "ow_live_test", fetch, maxRetries: 0 }), policy: { max_sol_out: 0.05 }, onError: (e) => errors.push(e) });
    const tx = new FakeLegacyTransaction();
    await assert.rejects(wallet.signTransaction(tx), (err: unknown) => err instanceof PreflightUnavailable && err.status === 0 && /unreachable/.test(err.message) && err.cause === errors[0]);
    assert.equal(attempts, 1);
    assert.deepEqual(inner.calls, []);
    assert.equal(tx.signed, false);
    assert.equal(wallet.preflight.lastVerdict, null);
    assert.equal(wallet.preflight.lastError, errors[0]);
  });

  it("an error status, a timeout and a malformed answer fail closed", async () => {
    for (const response of [{ status: 502, body: { error: "Solana node unreachable" } }, { status: 429, body: { error: "out of allowance" } }, { status: 401, body: { error: "Invalid API key" } }, { status: 200, body: { id: "pfc_1", decision: "yes" } }, { status: 200, body: "allow" }]) {
      const { inner, wallet } = setup([response]);
      await assert.rejects(wallet.signTransaction(new FakeLegacyTransaction()), PreflightUnavailable);
      assert.deepEqual(inner.calls, []);
    }
    const inner = new FakeWallet();
    const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof globalThis.fetch;
    const wallet = withPreflight(inner, { client: new Preflight({ apiKey: "k", fetch: hang, timeoutMs: 20, maxRetries: 0 }), policy: { max_sol_out: 0 } });
    await assert.rejects(wallet.signTransaction(new FakeLegacyTransaction()), PreflightUnavailable);
    assert.deepEqual(inner.calls, []);
  });

  it('onUnavailable: "allow" signs when there is no answer, but never after a refusal or a rejected request', async () => {
    for (const response of [{ status: 502, body: { error: "Solana node unreachable" } }, { status: 200, body: { nonsense: true } }]) {
      const errors: unknown[] = [];
      const { inner, wallet } = setup([response], { onUnavailable: "allow", onError: (e: unknown) => errors.push(e) });
      const tx = new FakeLegacyTransaction();
      await wallet.signTransaction(tx);
      assert.equal(tx.signed, true);
      assert.deepEqual(inner.calls, ["signTransaction"]);
      assert.equal(errors.length, 1);
      assert.equal(wallet.preflight.lastVerdict, null);
      assert.equal(wallet.preflight.lastError, errors[0]);
    }
    const down = new FakeWallet();
    const open = withPreflight(down, { client: new Preflight({ apiKey: "k", fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof globalThis.fetch, maxRetries: 0 }), policy: { max_sol_out: 0.05 }, onUnavailable: "allow" });
    await open.signTransaction(new FakeVersionedTransaction());
    assert.deepEqual(down.calls, ["signTransaction"]);

    const refused = setup([{ status: 200, body: fakeVerdict("refuse") }], { onUnavailable: "allow" });
    await assert.rejects(refused.wallet.signTransaction(new FakeLegacyTransaction()), PreflightRefused);
    assert.deepEqual(refused.inner.calls, []);
    for (const status of [400, 401, 429]) {
      const wrong = setup([{ status, body: { error: "no" } }], { onUnavailable: "allow" });
      await assert.rejects(wrong.wallet.signTransaction(new FakeLegacyTransaction()), (err: unknown) => err instanceof PreflightUnavailable && err.status === status);
      assert.deepEqual(wrong.inner.calls, []);
    }
  });

  it("signAllTransactions checks every transaction and signs none if any is refused", async () => {
    const txs = [new FakeLegacyTransaction([1]), new FakeVersionedTransaction([2]), new FakeLegacyTransaction([3])];
    const seen: string[] = [];
    const { inner, wallet, calls, sent } = setup([{ status: 200, body: fakeVerdict("allow", "pfc_a") }, { status: 200, body: fakeVerdict("refuse", "pfc_b") }, { status: 200, body: fakeVerdict("allow", "pfc_c") }], { onVerdict: (v: { id: string }) => seen.push(v.id) });
    await assert.rejects(wallet.signAllTransactions(txs), (err: unknown) => err instanceof PreflightRefused && err.verdict.id === "pfc_b");
    assert.equal(calls.length, 3);
    assert.deepEqual(sent().map((s) => s.transaction).sort(), ["AQ==", "Ag==", "Aw=="]);
    assert.deepEqual(seen.sort(), ["pfc_a", "pfc_b", "pfc_c"]);
    assert.deepEqual(inner.calls, []);
    assert.equal(txs.some((t) => t.signed), false);
    assert.equal(wallet.preflight.lastVerdict?.id, "pfc_b");
    assert.equal(wallet.preflight.lastVerdicts.length, 3);
  });

  it("signAllTransactions signs all when every one is allowed, and none when one check fails", async () => {
    const ok = setup([{ status: 200, body: fakeVerdict("allow") }]);
    const txs = [new FakeLegacyTransaction([1]), new FakeVersionedTransaction([2])];
    assert.equal((await ok.wallet.signAllTransactions(txs)).length, 2);
    assert.equal(ok.calls.length, 2);
    assert.deepEqual(ok.inner.calls, ["signAllTransactions"]);
    assert.equal(txs.every((t) => t.signed), true);
    assert.equal(ok.wallet.preflight.lastVerdicts.length, 2);

    const bad = setup([{ status: 200, body: fakeVerdict("allow") }, { status: 502, body: { error: "Solana node unreachable" } }]);
    await assert.rejects(bad.wallet.signAllTransactions([new FakeLegacyTransaction([1]), new FakeLegacyTransaction([2])]), PreflightUnavailable);
    assert.deepEqual(bad.inner.calls, []);
  });

  it("a policy function sets the limits for each transaction", async () => {
    const given: unknown[] = [];
    const policy = async (tx: { bytes: number[] }) => { given.push(tx); return { max_sol_out_lamports: String(tx.bytes[0]! * 1000), allowed_programs: ["11111111111111111111111111111111"] }; };
    const { wallet, sent } = setup([{ status: 200, body: fakeVerdict("allow") }], {}, policy);
    const a = new FakeLegacyTransaction([5]), b = new FakeVersionedTransaction([7]);
    await wallet.signTransaction(a);
    await wallet.signTransaction(b);
    assert.deepEqual(given, [a, b]);
    assert.deepEqual(sent().map((s) => s.policy), [
      { max_sol_out_lamports: "5000", allowed_programs: ["11111111111111111111111111111111"], wallet: ADDRESS },
      { max_sol_out_lamports: "7000", allowed_programs: ["11111111111111111111111111111111"], wallet: ADDRESS },
    ]);
  });

  it("keeps a wallet named by the policy, and reads the address from toBase58, toString or a string", async () => {
    const named = setup([{ status: 200, body: fakeVerdict("allow") }], {}, { wallet: "0therWa11et", max_sol_out: 1 });
    await named.wallet.signTransaction(new FakeLegacyTransaction());
    assert.equal(named.sent()[0]?.policy.wallet, "0therWa11et");

    for (const publicKey of [{ toString: () => "FromToString" }, "FromToString"]) {
      const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("allow") }]);
      const plain = { publicKey, signTransaction: async (t: FakeLegacyTransaction) => t };
      await withPreflight(plain, { client: new Preflight({ apiKey: "k", fetch }), policy: { max_sol_out: 1 } }).signTransaction(new FakeLegacyTransaction());
      assert.equal(JSON.parse(String(calls[0]?.init.body)).policy.wallet, "FromToString");
    }
  });

  it("produces base64 of the unsigned bytes from both transaction kinds", () => {
    assert.equal(serializeTransaction(new FakeLegacyTransaction([1, 2, 3, 250, 251, 252])), Buffer.from([1, 2, 3, 250, 251, 252]).toString("base64"));
    assert.equal(serializeTransaction(new FakeVersionedTransaction([128, 0, 255])), "gAD/");
    assert.equal(serializeTransaction({ serialize: () => [1, 2, 3] }), "AQID");
  });

  it("signs nothing when the check cannot be prepared, even with onUnavailable allow", async () => {
    const cases: Array<[unknown, unknown]> = [
      [{ publicKey: null }, new FakeLegacyTransaction()],
      [{ publicKey: { toBase58: () => ADDRESS } }, { notATransaction: true }],
      [{ publicKey: { toBase58: () => ADDRESS } }, { serialize: () => { throw new Error("Transaction recentBlockhash required"); } }],
    ];
    for (const [shape, tx] of cases) {
      const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("allow") }]);
      let signedCount = 0;
      const plain = { ...(shape as object), signTransaction: async (t: unknown) => { signedCount += 1; return t; } };
      const wallet = withPreflight(plain, { client: new Preflight({ apiKey: "k", fetch }), policy: { max_sol_out: 1 }, onUnavailable: "allow" });
      await assert.rejects(wallet.signTransaction(tx), PreflightUnavailable);
      assert.equal(calls.length, 0);
      assert.equal(signedCount, 0);
    }
  });

  it('signMessage: "refuse" blocks message signing', async () => {
    const { inner, wallet } = setup([{ status: 200, body: fakeVerdict("allow") }], { signMessage: "refuse" });
    await assert.rejects(wallet.signMessage(new Uint8Array([1])), PreflightUnavailable);
    assert.deepEqual(inner.calls, []);
  });

  it("builds its own client from apiKey", async () => {
    const saved = globalThis.fetch;
    const { fetch, calls } = scriptedFetch([{ status: 200, body: fakeVerdict("allow") }]);
    globalThis.fetch = fetch;
    try {
      const inner = new FakeWallet();
      await withPreflight(inner, { apiKey: "ow_live_test", policy: { max_sol_out: 0 } }).signTransaction(new FakeLegacyTransaction());
      assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer ow_live_test");
      assert.deepEqual(inner.calls, ["signTransaction"]);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
