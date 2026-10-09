/**
 * Overwing Preflight in a Solana wallet's signing path.
 *
 *   import { withPreflight } from "overwing/solana";
 *
 *   const wallet = withPreflight(keypairWallet, { policy: { max_sol_out: 0.05 } });   // reads OVERWING_API_KEY
 *   await wallet.signTransaction(tx);   // checked first; throws PreflightRefused unless the answer is "allow"
 *
 * The wrapped wallet has the same interface as the one it wraps, so it goes wherever that wallet went
 * (Solana Agent Kit, wallet-adapter, your own code). Before every signature the unsigned transaction is
 * serialized and sent to Preflight with the policy. Nothing is signed unless the decision is "allow".
 * No answer (an HTTP error, a timeout, a malformed body) is not an allow: it throws PreflightUnavailable.
 *
 * This file has no Solana dependency. Wallets and transactions are typed by shape, and both the legacy
 * `Transaction` and `VersionedTransaction` of @solana/web3.js fit.
 */
import { Overwing } from "./client.js";
import { OverwingError } from "./errors.js";
import { Preflight, transactionToBase64 } from "./preflight.js";
import type { PreflightCheckInput, PreflightLimits, PreflightVerdict } from "./types.js";

/** A public key by shape: web3.js `PublicKey` has both methods. A base58 string is accepted too. */
export type PublicKeyLike = string | { toBase58?: () => string; toString: () => string };

/**
 * A transaction by shape. Legacy `Transaction.serialize(config)` needs the two flags to serialize
 * without signatures; `VersionedTransaction.serialize()` takes no argument and ignores them.
 */
export type SolanaTransactionLike = { serialize: (config?: { requireAllSignatures?: boolean; verifySignatures?: boolean }) => Uint8Array | number[] };

/** A wallet by shape. Every method is optional; the ones that exist are wrapped. */
export type SolanaWalletLike = {
  readonly publicKey?: PublicKeyLike | null;
  signTransaction?: (transaction: any, ...rest: any[]) => Promise<any>;
  signAllTransactions?: (transactions: any[], ...rest: any[]) => Promise<any>;
  signAndSendTransaction?: (transaction: any, ...rest: any[]) => Promise<any>;
  signAndSendAllTransactions?: (transactions: any[], ...rest: any[]) => Promise<any>;
  sendTransaction?: (transaction: any, ...rest: any[]) => Promise<any>;
  signMessage?: (message: any, ...rest: any[]) => Promise<any>;
};

/** A policy for the wrapper: the limits, with `wallet` optional. Left out, it is the wrapped wallet's public key. */
export type PreflightWalletPolicy = PreflightLimits & { wallet?: string };

/** Anything that can check a transaction: `new Preflight()`, `new Overwing().preflight`, or your own (for instance one that pays over x402). */
export type PreflightChecker = { check: (input: PreflightCheckInput) => Promise<PreflightVerdict> };

export type WithPreflightOptions = {
  /** The limits for every transaction, or a function that gives the limits for one transaction. */
  policy: PreflightWalletPolicy | ((transaction: SolanaTransactionLike) => PreflightWalletPolicy | Promise<PreflightWalletPolicy>);
  /** An existing client. Defaults to a new one from `apiKey`, or from OVERWING_API_KEY. */
  client?: Overwing | PreflightChecker;
  /** API key (ow_live_...), when no `client` is given. */
  apiKey?: string;
  /**
   * When Preflight gives no verdict because it could not be reached, timed out, failed (5xx)
   * or gave a malformed answer: "throw" (default) signs nothing; "allow" signs unchecked.
   * A refusal is never affected, and neither is a request Preflight rejected as wrong (400, 401, 403)
   * or a spent allowance (429): running out must not quietly switch the check off.
   */
  onUnavailable?: "throw" | "allow";
  /** `signMessage` cannot be checked. "pass" (default) leaves it as it is; "refuse" makes it throw, so raw transaction bytes cannot be signed that way. */
  signMessage?: "pass" | "refuse";
  /** Called with every verdict, allow or refuse, before anything is signed. For logging ids. */
  onVerdict?: (verdict: PreflightVerdict, transaction: SolanaTransactionLike) => void;
  /** Called when a check gave no verdict, whether or not the transaction is then signed. */
  onError?: (error: unknown, transaction: SolanaTransactionLike) => void;
};

/** What the wrapped wallet exposes as `wallet.preflight`. */
export type PreflightState = {
  /** The most recent verdict, allow or refuse. Null before the first check, and after a check that gave none. */
  readonly lastVerdict: PreflightVerdict | null;
  /** The verdicts of the most recent sign call, in the order of its transactions. */
  readonly lastVerdicts: readonly PreflightVerdict[];
  /** What the most recent check failed with, when it gave no verdict. Otherwise null. */
  readonly lastError: unknown;
};

/** Preflight refused the transaction. Nothing was signed. */
export class PreflightRefused extends Error {
  readonly verdict: PreflightVerdict;
  constructor(verdict: PreflightVerdict) {
    const reasons = Array.isArray(verdict.reasons) ? verdict.reasons.map((r) => r.code).join(", ") : "";
    super(`Overwing Preflight refused the transaction (${reasons || "no reason given"}) · ${verdict.id}`);
    this.name = "PreflightRefused";
    this.verdict = verdict;
  }
}

/** Preflight gave no verdict (unreachable, timed out, rejected the request, or the transaction could not be serialized). Nothing was signed. */
export class PreflightUnavailable extends Error {
  /** HTTP status of the failed check. 0 when there was no answer. */
  readonly status: number;
  constructor(message: string, cause?: unknown) {
    super(`Overwing Preflight gave no verdict, so nothing was signed: ${message}`, { cause });
    this.name = "PreflightUnavailable";
    this.status = cause instanceof OverwingError ? cause.status : 0;
  }
}

const SINGLE = new Set<PropertyKey>(["signTransaction", "signAndSendTransaction", "sendTransaction"]);
const MANY = new Set<PropertyKey>(["signAllTransactions", "signAndSendAllTransactions"]);

/** The unsigned transaction in base64, from a legacy `Transaction` or a `VersionedTransaction`. */
export function serializeTransaction(transaction: SolanaTransactionLike): string {
  if (typeof transaction !== "object" || transaction === null || typeof transaction.serialize !== "function") throw new TypeError("not a transaction: it has no serialize()");
  const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false });
  const view = bytes instanceof Uint8Array ? bytes : Array.isArray(bytes) ? Uint8Array.from(bytes) : null;
  if (!view || view.length === 0) throw new TypeError("serialize() did not return bytes");
  return transactionToBase64(view);
}

function addressOf(key: PublicKeyLike | null | undefined): string | null {
  if (typeof key === "string") return key || null;
  if (typeof key !== "object" || key === null) return null;
  const text = typeof key.toBase58 === "function" ? key.toBase58() : key.toString();
  return typeof text === "string" && text && !text.startsWith("[object") ? text : null;
}

/** True when the failure means Preflight could not answer, rather than that the request was wrong. */
function couldNotAnswer(err: unknown): boolean {
  if (!(err instanceof OverwingError)) return true;
  return err.status === 0 || err.status === 408 || err.status >= 500;
}

/**
 * Wrap a wallet so that every signature is checked by Overwing Preflight first.
 * Returns an object of the wallet's own type, plus `preflight` (the last verdict).
 *
 * Checked: `signTransaction`, `signAllTransactions`, `signAndSendTransaction`, `signAndSendAllTransactions`
 * and `sendTransaction`, whichever the wallet has. With several transactions every one is checked and none
 * is signed unless all are allowed. Throws PreflightRefused on a refusal and PreflightUnavailable when
 * there is no verdict. The transaction needs its fee payer and recent blockhash set before the call.
 */
export function withPreflight<W extends SolanaWalletLike>(wallet: W, options: WithPreflightOptions): W & { readonly preflight: PreflightState } {
  if (typeof wallet !== "object" || wallet === null) throw new TypeError("withPreflight needs a wallet object");
  if (!options || options.policy === undefined || options.policy === null) throw new TypeError("withPreflight needs a policy");
  const checker: PreflightChecker = options.client instanceof Overwing ? options.client.preflight : options.client ?? new Preflight({ apiKey: options.apiKey });
  const failOpen = options.onUnavailable === "allow";
  const state: { lastVerdict: PreflightVerdict | null; lastVerdicts: PreflightVerdict[]; lastError: unknown } = { lastVerdict: null, lastVerdicts: [], lastError: null };

  /** Resolves with the allow verdict, or with null when there was none and the caller chose to sign anyway. Throws otherwise. */
  async function clear(transaction: SolanaTransactionLike): Promise<PreflightVerdict | null> {
    let input: PreflightCheckInput;
    try {
      const base64 = serializeTransaction(transaction);
      const policy = { ...(typeof options.policy === "function" ? await options.policy(transaction) : options.policy) };
      const address = policy.wallet ?? addressOf(wallet.publicKey);
      if (!address) throw new TypeError("the policy names no wallet and the wrapped wallet has no public key");
      input = { transaction: base64, policy: { ...policy, wallet: address } };
    } catch (err) {
      // The request could not be built. That is never a reason to sign unchecked.
      state.lastError = err;
      options.onError?.(err, transaction);
      throw new PreflightUnavailable(`the check could not be prepared (${err instanceof Error ? err.message : String(err)})`, err);
    }

    let verdict: PreflightVerdict;
    try {
      verdict = await checker.check(input);
      if (typeof verdict !== "object" || verdict === null || (verdict.decision !== "allow" && verdict.decision !== "refuse")) {
        throw new OverwingError("the answer is not a verdict", 0, null, { code: "malformed_verdict", body: verdict });
      }
    } catch (err) {
      state.lastError = err;
      options.onError?.(err, transaction);
      if (failOpen && couldNotAnswer(err)) return null;
      throw new PreflightUnavailable(err instanceof Error ? err.message : String(err), err);
    }

    options.onVerdict?.(verdict, transaction);
    if (verdict.decision !== "allow") throw new PreflightRefused(verdict);
    return verdict;
  }

  async function clearAll(transactions: SolanaTransactionLike[]): Promise<void> {
    state.lastVerdict = null;
    state.lastVerdicts = [];
    state.lastError = null;
    const seen: PreflightVerdict[] = [];
    const settled = await Promise.allSettled(transactions.map((t) => clear(t)));
    let failure: unknown;
    for (const s of settled) {
      if (s.status === "fulfilled") {
        if (s.value) seen.push(s.value);
        continue;
      }
      if (s.reason instanceof PreflightRefused) seen.push(s.reason.verdict);
      // A refusal is the more useful thing to throw than a check that gave no answer.
      if (failure === undefined || (s.reason instanceof PreflightRefused && !(failure instanceof PreflightRefused))) failure = s.reason;
    }
    state.lastVerdicts = seen;
    state.lastVerdict = seen.length > 0 ? seen[seen.length - 1]! : null;
    if (failure !== undefined) {
      if (failure instanceof PreflightRefused) state.lastVerdict = failure.verdict;
      throw failure;
    }
  }

  const made = new Map<PropertyKey, unknown>();
  const view: PreflightState = {
    get lastVerdict() { return state.lastVerdict; },
    get lastVerdicts() { return state.lastVerdicts; },
    get lastError() { return state.lastError; },
  };

  return new Proxy(wallet, {
    get(target, prop) {
      if (prop === "preflight") return view;
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      const cached = made.get(prop) as { from: unknown; fn: unknown } | undefined;
      if (cached && cached.from === value) return cached.fn;
      const original = value as (...args: unknown[]) => unknown;
      let fn: (...args: unknown[]) => unknown;
      if (SINGLE.has(prop)) {
        fn = async (transaction: unknown, ...rest: unknown[]) => {
          await clearAll([transaction as SolanaTransactionLike]);
          return original.call(target, transaction, ...rest);
        };
      } else if (MANY.has(prop)) {
        fn = async (transactions: unknown, ...rest: unknown[]) => {
          await clearAll((Array.isArray(transactions) ? transactions : [transactions]) as SolanaTransactionLike[]);
          return original.call(target, transactions, ...rest);
        };
      } else if (prop === "signMessage" && options.signMessage === "refuse") {
        fn = async () => {
          throw new PreflightUnavailable("signMessage cannot be checked and this wallet was wrapped with signMessage: \"refuse\"");
        };
      } else {
        // Bound to the wallet itself, so its private state works and its own internal calls are not checked twice.
        fn = original.bind(target);
      }
      made.set(prop, { from: value, fn });
      return fn;
    },
    has(target, prop) {
      return prop === "preflight" || Reflect.has(target, prop);
    },
  }) as W & { readonly preflight: PreflightState };
}
