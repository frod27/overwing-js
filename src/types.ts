export type Verdict = "pass" | "fail" | "review";
export type QuestionType = "choice" | "score" | "noul";
/** What a rule says to do when it fails. */
export type RuleAction = "block" | "redact" | "review";
/** One word to act on for the whole evaluation. */
export type RecommendedAction = "block" | "redact" | "review" | "allow";

export type RuleResult = {
  rule: string;
  type: QuestionType;
  answer: string | number | boolean;
  probability: number;
  confidence: number;
  verdict: Verdict;
  action: RuleAction;
};

export type Evaluation = {
  id: string;
  verdict: Verdict;
  recommended_action: RecommendedAction;
  aggregate_score: number;
  confidence: number;
  latency_ms: number;
  results: RuleResult[];
  /** Present only on an evaluation made with no key: what is left of the free allowance, and that the text was not stored. */
  access?: { mode: "keyless"; daily_limit: number; remaining_today: number; input_stored: false; retrievable: false; note: string; next: Record<string, string> };
};

export type EvaluationDetail = Evaluation & {
  rule_set: string;
  input: string;
  context: Record<string, unknown> | null;
  input_token_count: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type EvaluationSummary = Omit<EvaluationDetail, "input" | "input_token_count" | "results">;

export type BatchItem = { id?: string; input: string; metadata?: Record<string, unknown>; context?: Record<string, unknown> };
export type BatchResult = {
  summary: { total: number; pass: number; fail: number; review: number; errors: number };
  results: Array<{ id: string | null; index: number; evaluation: Evaluation | null; error: string | null }>;
};

export type RuleDefinition = {
  name: string;
  description?: string | null;
  question_type: QuestionType;
  question_config:
    | { options: string[]; instructions: string }
    | { levels: string[]; instructions: string }
    | { question: string };
  fail_condition: { failOn: string[] } | { failOn: boolean } | { failAbove: number };
  review_condition?: { confidenceBelow: number } | null;
  /** What a caller should do when this rule fails. Default "block". */
  action?: RuleAction;
  weight?: number;
};

export type RuleSet = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_system_prebuilt: boolean;
  is_active: boolean;
  created_at: string;
  rules?: Array<RuleDefinition & { id: string; sort_order: number; is_active: boolean }>;
};

export type Usage = {
  org: string;
  plan: string;
  daily_limit: number;
  today: { date: string; eval_count: number; remaining: number };
  days: Array<{ date: string; eval_count: number; pass_count: number; fail_count: number; review_count: number; avg_latency_ms: number | null; total_input_tokens: number }>;
};

export type Me = { org_id: string; org: string; plan: string; daily_limit: number; webhook_configured: boolean };

export type RateLimitInfo = {
  daily: { limit: number; remaining: number; resetAt: Date } | null;
  burst: { limit: number; remaining: number; resetAt: Date } | null;
};

// ---- Overwing Atlas ----

export type AtlasVerification = "Web Bot Auth signature" | "User-agent string only (spoofable)" | "Unattributable / spoofed" | "Published IP ranges" | (string & {});

export type AtlasAgent = {
  slug: string;
  agent: string;
  operator: string | null;
  user_agent_tokens: string[];
  web_bot_auth_key_directory: string | null;
  description: string | null;
  /** Curated fields, present with Atlas Pro or Team, and on lookup matches. */
  purpose_class?: string | null;
  verification?: AtlasVerification | null;
  [field: string]: unknown;
};

export type AtlasLookup = {
  user_agent: string;
  identified: boolean;
  /** What the string claims to be. `verification` says whether the claim can be trusted. */
  claims: { agent: string; operator: string | null; purpose_class: string | null; verification: AtlasVerification | null; matched_token: string } | null;
  trust_note: string;
  matches: Array<{ matched_token: string; strength: string | number; agent: AtlasAgent }>;
  /** Present on keyless calls. */
  access?: { mode: "keyless"; daily_limit: number; remaining_today: number; next: Record<string, string> };
};

export type AtlasLookupLimit = { limit: number; remaining: number };

export type AtlasAgentList = { total: number; limit: number; offset: number; fields: "public" | "full" | (string & {}); tier: string; agents: AtlasAgent[] };

export type AtlasSummary = {
  registry: { count: number; operators: number; purpose_classes: Record<string, number>; verification: Record<string, number> };
  traffic_shares: Array<{ agent: string; value: number | string; period: string; [field: string]: unknown }>;
  sector_scans: Array<{ sector: string; date: string; headline_findings: Array<{ finding: string; [field: string]: unknown }>; [field: string]: unknown }>;
  report_summary: string | null;
  [field: string]: unknown;
};

// ---- Overwing Tower ----

export type TowerOutcome = "auto" | "review" | "reject";
export type TowerActionStatus = "pending" | "approved" | "executed" | "failed" | "compensated" | "rejected";

export type TowerDecision = {
  decision_id: string;
  outcome: TowerOutcome;
  score: number | null;
  reason: string;
  provider: "jev" | "local_rules";
  thresholds: { auto: number; review: number };
  results: Array<{ question_id: string; answer: string | number | boolean; probability: number; confidence: number; passed: boolean; gated: boolean }>;
  checks: Array<{ check: string; passed: boolean; detail?: string }>;
  latency_ms: number | null;
  operation?: string;
};

export type TowerError = { code: string; field?: string; message: string; retryable: boolean; suggested_fix?: string };

export type TowerAction = {
  action_id: string;
  operation: string;
  status: TowerActionStatus;
  dry_run: boolean;
  idempotency_key: string;
  /** The full decision on submit; only `decision_id` on some reads. */
  decision: TowerDecision | { decision_id: string } | null;
  /** What the legacy system returned. */
  result: Record<string, unknown> | null;
  error: TowerError | Record<string, unknown> | null;
  /** Set when the action is waiting on a person. */
  review_id?: string;
  /** True when this answer is the stored outcome of an earlier request with the same idempotency key. */
  replayed?: boolean;
  /** On a dry run: what would have happened. */
  would?: string;
  compensated_by?: string | null;
  executed_at?: string | null;
  created_at?: string;
};

export type TowerCapabilities = {
  agent: { id: string; name: string; scopes: string[] };
  operations: Array<{ operation: string; workflow: string; is_write: boolean; compensating_operation: string | null; input_schema: Record<string, unknown>; description: string | null }>;
};

export type TowerReceipt = {
  receipt_id: string;
  sequence: number;
  kind: "decision" | "action" | "review" | "compensation";
  action_id: string | null;
  decision_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  prev_hash: string;
  chain_hash: string;
  signature: string;
  signing_key_id: string;
  created_at: string;
};

export type TowerVerifyReport = { ok: boolean; checked: number; first_break: { sequence: number; problem: string } | null; from: number; to: number; signing_key_ids: string[]; latest_sequence: number };

export type TowerPublicKey = { key_id: string; algorithm: "Ed25519"; public_key_pem: string; how: string };

export type TowerAgent = { agent_id: string; name: string; scopes: string[]; status: "active" | "revoked"; key_prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null };

export type TowerAgentWithKey = TowerAgent & { key: string; key_shown_once: true; use: string };

export type TowerTemplate = { workflow_id: string; workflow: string; created: boolean; operations: string[]; target_system: string; sample_input: { operation: string; input: Record<string, unknown> }; next: string };

// ---- Overwing Beacon ----

export type BeaconAnswer = "yes" | "partly" | "no";
export type BeaconCategory = "find" | "read" | "use";

export type BeaconCheck = {
  id: string;
  category: BeaconCategory;
  title: string;
  status: "pass" | "warn" | "fail";
  points: number;
  max: number;
  /** What was found. */
  detail: string;
  /** What to change. Absent when the check passed. */
  fix?: string;
  /** The address that was read. */
  evidence?: string;
};

export type BeaconReport = {
  status?: "complete";
  id: string;
  url: string;
  host: string;
  scanned_at: string;
  /** 0 to 100. */
  score: number;
  /** Is the product reachable by agents. */
  verdict: BeaconAnswer;
  summary: string;
  categories: Array<{ key: BeaconCategory; title: string; question: string; answer: BeaconAnswer; points: number; max: number }>;
  checks: BeaconCheck[];
  /** The three changes worth the most, most valuable first. */
  top_fixes: Array<{ check: string; fix: string; gain: number }>;
  /** False when the model judgments could not be made; their checks are then left out. */
  judged: boolean;
  duration_ms: number;
  requests: number;
};

export type BeaconStarted = { id: string; url: string; status: "awaiting_payment"; price_usd: number; checkout_url: string; status_url: string; report_url: string };

export type BeaconStatus =
  | (BeaconReport & { status: "complete" })
  | { status: "running"; id: string; url: string }
  | { status: "awaiting_payment"; id: string; url: string; price_usd: number; checkout_url: string | null };
