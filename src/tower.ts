import { OverwingError } from "./errors.js";
import { Transport, env, query } from "./http.js";
import type { TransportOptions } from "./http.js";
import type { TowerAction, TowerAgent, TowerAgentWithKey, TowerCapabilities, TowerDecision, TowerPublicKey, TowerReceipt, TowerTemplate, TowerVerifyReport } from "./types.js";

export type TowerOptions = TransportOptions & {
  /** Agent key (ow_agent_...). Defaults to process.env.OVERWING_AGENT_KEY. The organization creates it; see `Overwing#tower`. */
  agentKey?: string;
};

export type SubmitOptions = {
  /** Stable for this business request, such as the source message id. Repeating it returns the original outcome instead of acting twice. */
  idempotencyKey: string;
  /** Decide without executing or queueing. */
  dryRun?: boolean;
};

/**
 * Overwing Tower, as an agent: typed operations on a legacy system, each one ruled
 * auto, review, or reject, with a signed receipt for every step.
 *
 *   const tower = new Tower();                       // reads OVERWING_AGENT_KEY
 *   const { operations } = await tower.capabilities();
 *   const action = await tower.submit("create_order", order, { idempotencyKey: messageId });
 *   if (action.status === "pending") { ...a person must approve; poll tower.get(action.action_id) }
 */
export class Tower {
  private readonly http: Transport;

  constructor(options: TowerOptions = {}) {
    const agentKey = options.agentKey ?? env("OVERWING_AGENT_KEY");
    if (!agentKey) {
      throw new OverwingError("Overwing Tower agent key missing. Pass { agentKey } or set OVERWING_AGENT_KEY. An organization creates one with overwing.tower.agents.create({ name, scopes }).", 0);
    }
    this.http = new Transport(agentKey, options);
  }

  /** The operations this agent may call, each with the JSON Schema its input must match. */
  capabilities(): Promise<TowerCapabilities> {
    return this.http.request("GET", "/api/v1/tower/capabilities");
  }

  /** How Tower would rule, with no side effects. */
  decide(operation: string, input: Record<string, unknown>): Promise<TowerDecision> {
    return this.http.request("POST", "/api/v1/tower/decide", { body: { operation, input } });
  }

  /**
   * Request an action. Resolves for every ruling, so branch on `status`:
   * "executed" (done), "pending" (a person must approve; poll `get`, do not resubmit),
   * "rejected" (do not retry unchanged), or "approved" on a dry run.
   * Throws OverwingError for a malformed request, an operation outside the agent's scopes, or a spent quota.
   */
  submit(operation: string, input: Record<string, unknown>, options: SubmitOptions): Promise<TowerAction> {
    return this.http.request("POST", "/api/v1/tower/actions", { body: { operation, input, idempotency_key: options.idempotencyKey, dry_run: options.dryRun }, acceptStatuses: [422] });
  }

  /** Status and result of an action. */
  get(actionId: string): Promise<TowerAction> {
    return this.http.request("GET", `/api/v1/tower/actions/${encodeURIComponent(actionId)}`);
  }

  /** Poll an action that is waiting on a person until it leaves "pending", or until the timeout passes. Returns the last state seen. */
  async waitForReview(actionId: string, options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<TowerAction> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    const interval = Math.max(1_000, options.intervalMs ?? 5_000);
    for (;;) {
      const action = await this.get(actionId);
      if (action.status !== "pending" || Date.now() + interval > deadline) return action;
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  /** Run the compensating operation for an executed action. Runs once; repeating it returns the first outcome. */
  compensate(actionId: string): Promise<TowerAction> {
    return this.http.request("POST", `/api/v1/tower/actions/${encodeURIComponent(actionId)}/compensate`, { body: {} });
  }

  readonly receipts = {
    /** One signed receipt, by id or by sequence number. */
    get: (idOrSequence: string | number): Promise<TowerReceipt> => this.http.request("GET", `/api/v1/tower/receipts/${encodeURIComponent(String(idOrSequence))}`),
    /** Recompute every hash and check every signature over a range (default: the whole chain, up to 5,000 links). */
    verify: (range: { from?: number; to?: number } = {}): Promise<TowerVerifyReport> => this.http.request("GET", `/api/v1/tower/receipts/verify${query(range)}`),
    /** The Ed25519 public key that signs receipts, for verifying them yourself. */
    publicKey: (): Promise<TowerPublicKey> => this.http.request("GET", "/api/v1/tower/receipts/public-key"),
  };
}

/** Overwing Tower setup, as the organization. Reached through `new Overwing().tower`. */
export class TowerSetup {
  private readonly http: Transport;
  constructor(http: Transport) {
    this.http = http;
  }

  /** Load the starter workflow (email purchase order to order entry, mock IBM i). Idempotent. */
  loadTemplate(): Promise<TowerTemplate> {
    return this.http.request("POST", "/api/v1/tower/template", { body: {} });
  }

  readonly agents = {
    /** Create a scoped agent identity. The key is returned once; store it and hand it to `new Tower({ agentKey })`. */
    create: (input: { name: string; scopes: string[] }): Promise<TowerAgentWithKey> => this.http.request("POST", "/api/v1/tower/agents", { body: input }),
    /** Keys are never returned here. */
    list: (): Promise<{ agents: TowerAgent[]; active_limit: number }> => this.http.request("GET", "/api/v1/tower/agents"),
    /** The key stops working at once. */
    revoke: (agentId: string): Promise<{ agent_id: string; status: "revoked" }> => this.http.request("DELETE", `/api/v1/tower/agents/${encodeURIComponent(agentId)}`),
  };

  /** Create an agent and return a ready Tower client for it, alongside the agent record. */
  async agent(input: { name: string; scopes: string[] }): Promise<{ agent: TowerAgentWithKey; tower: Tower }> {
    const agent = await this.agents.create(input);
    return { agent, tower: new Tower({ ...this.http.options, agentKey: agent.key, baseUrl: this.http.baseUrl }) };
  }
}
