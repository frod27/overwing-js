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

export type Me = {
  org_id: string;
  org: string;
  plan: string;
  daily_limit: number;
  webhook_configured: boolean;
  /** "key_only": an account made with no email. */
  account?: "key_only" | "standard";
  /** A domain the account has proved it controls, or null. */
  verified_domain?: string | null;
};

/** What signing up with no email returns. `api_key` is shown once. */
export type AccountCreated = {
  org_id: string;
  org: string;
  plan: string;
  account: "key_only";
  daily_limit: number;
  api_key: string;
  key_prefix: string;
  notice: string;
};

/** The one value to publish at a domain to prove control of it, as a TXT record or as a file. */
export type DomainProofSteps = { value: string; dns: { type: "TXT"; name: string; value: string }; http: { url: string; body: string }; note: string };

export type DomainProof = { domain: string; status: "pending_verification" | "verified"; verification?: DomainProofSteps; next?: string };

/** The outcome of looking for a domain proof. `verified: false` means it was not there yet; ask again. */
export type DomainCheck = { verified: true; domain: string } | { verified: false; error: string; verification?: DomainProofSteps };

export type RecoveryStarted = { domain: string; verification: DomainProofSteps; expires_in_hours: number; next: string };

export type KeyRecovered = { org_id: string; domain: string; api_key: string; key_prefix: string; revoked_keys: number; notice: string };

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

export type AtlasPurpose = "training_crawl" | "search_index" | "user_fetch" | "browser_agent" | "coding_agent" | "api_agent" | "other";

/** An agent you operate, to add to the registry. */
export type AtlasRegistrationInput = {
  /** The agent's name, e.g. "AcmeBot". */
  name: string;
  /** The company or person that runs it. */
  operator: string;
  /** The operator's domain. You prove control of it with a DNS record or a file. */
  domain: string;
  /** The product name the User-Agent carries, e.g. ["AcmeBot"]. One to three. */
  tokens: string[];
  purpose?: AtlasPurpose;
  /** The full User-Agent string the agent sends. It must contain a token. */
  userAgent?: string;
  description?: string;
  policyUrl?: string;
  /** A Web Bot Auth key directory on the operator's domain. With one that answers, the entry is listed as signed. */
  keyDirectoryUrl?: string;
  followsRobotsTxt?: boolean;
};

export type AtlasRegistration = {
  id: string;
  status: "pending_verification" | "pending_review" | "published" | "rejected" | "withdrawn";
  name: string;
  operator: string;
  domain: string;
  tokens: string[];
  purpose: AtlasPurpose | (string & {});
  user_agent: string | null;
  description: string | null;
  policy_url: string | null;
  key_directory_url: string | null;
  follows_robots_txt: boolean | null;
  /** Why it is waiting for a person, or why it was not accepted. */
  note: string | null;
  verified_at: string | null;
  verified_by: "dns" | "http" | null;
  created_at: string;
  /** While unverified: the one value to publish at the domain, as a TXT record or as a file. */
  verification?: { value: string; dns: { type: "TXT"; name: string; value: string }; http: { url: string; body: string }; note: string };
  next?: string;
  /** Once published: the registry entry. */
  agent?: string;
  lookup?: string;
};

/** The outcome of looking for the proof at the domain. `verified: false` means it was not there yet; ask again. */
export type AtlasRegistrationCheck = { verified: true; registration: AtlasRegistration } | { verified: false; registration: AtlasRegistration; error: string };

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

/** What a check answers with when no key was sent: the report without its checks, with the first of its top fixes. */
export type BeaconSummary = Pick<BeaconReport, "id" | "url" | "host" | "scanned_at" | "score" | "verdict" | "summary" | "categories" | "top_fixes"> & {
  /** How many checks the full report holds, by result, and how many carry a fix. */
  counts: { checks: number; pass: number; gaps: number; missing: number; fixes: number };
  /** How to open the full report: a free account. */
  full_report?: Record<string, string>;
};

export type BeaconStarted = { id: string; url: string; status: "queued"; price_usd: number; access: "full" | "summary"; status_url: string; report_url: string; saved_to_dashboard: boolean };

/** Branch on `status`, then on `access`: `"full"` carries `checks`, `"summary"` carries `counts`. */
export type BeaconStatus =
  | (BeaconReport & { status: "complete"; access: "full" })
  | (BeaconSummary & { status: "complete"; access: "summary" })
  | { status: "running"; id: string; url: string };

// ---- Overwing Preflight ----

/** Atomic units of a token, by mint address. A whole number, or a string of digits for amounts past 2^53. */
export type PreflightTokenAmounts = Record<string, number | string>;

/**
 * What a transaction may do to the wallet, without naming the wallet. Give the SOL limit one way, never both:
 * `max_sol_out` in SOL, or `max_sol_out_lamports` as a whole number. Fees count. 0 allows none.
 */
export type PreflightLimits = {
  /** Atomic units that may leave, by mint. A mint not listed may not leave at all. */
  max_token_out?: PreflightTokenAmounts;
  /** Atomic units that must arrive, by mint. For a swap. */
  min_token_in?: PreflightTokenAmounts;
  /** When given, every program the transaction runs, top-level or inner, must be listed. */
  allowed_programs?: string[];
  /** Whether a spending approval on the wallet's token accounts is acceptable. Default false. */
  allow_delegation?: boolean;
} & ({ max_sol_out: number; max_sol_out_lamports?: never } | { max_sol_out_lamports: number | string; max_sol_out?: never });

/** The policy one check is made against. `wallet` is the base58 address to protect; it must sign the transaction. */
export type PreflightPolicy = PreflightLimits & { wallet: string };

export type PreflightCheckInput = {
  /** The serialized transaction, legacy or v0, signed or not: base64, or the bytes. */
  transaction: string | Uint8Array;
  policy: PreflightPolicy;
};

export type PreflightDecision = "allow" | "refuse";

/** One reason to refuse. The codes are listed by `preflight.overview()`. */
export type PreflightReason = { code: string; detail: string };

/** What the simulation says would happen to the wallet. Amounts are atomic units as strings. */
export type PreflightEffects = { sol_out_lamports: string; token_out: Record<string, string>; token_in: Record<string, string>; control: unknown[] };

export type PreflightReceipt = { payload: Record<string, unknown>; payload_hash: string; signature: string; signing_key_id: string; public_key: string };

export type PreflightVerdict = {
  id: string;
  /** The one field to branch on. Sign only on "allow". */
  decision: PreflightDecision;
  /** Every reason to refuse. Empty on an allow. */
  reasons: PreflightReason[];
  /** Null when the transaction could not be simulated. */
  effects: PreflightEffects | null;
  /** Every program the transaction would run. */
  programs: string[];
  /** sha256 of the message with its blockhash zeroed. */
  digest: string;
  slot: number | null;
  /** Whether the guarantee applies: an allow made only of programs Overwing names. */
  covered: boolean;
  decided_at: string;
  /** The verdict covers a transaction that lands within this many seconds. Sign and send at once. */
  valid_for_seconds: number;
  receipt: PreflightReceipt;
  record_url: string;
  if_it_goes_wrong?: string;
};

/** A verdict as published: never the wallet, the amounts or the transaction. */
export type PreflightPublishedVerdict = {
  id: string;
  decision: PreflightDecision;
  reason_codes: string[];
  programs: string[];
  digest: string;
  covered: boolean;
  slot: number | null;
  /** How the check was paid for: "key" or "x402". */
  channel: string;
  decided_at: string;
  payload_hash: string;
  signature: string;
  signing_key_id: string;
};

/** What the chain showed for a transaction reported against a verdict. */
export type PreflightReport = {
  check_id: string;
  /** The landed transaction's signature. */
  transaction: string;
  outcome: "miss" | "not_a_miss";
  why: string | null;
  covered: boolean;
  payout_usd: number | null;
  [key: string]: unknown;
};

/** The public record of one verdict, with every transaction reported against it. */
export type PreflightVerdictRecord = PreflightPublishedVerdict & { reports: Array<Record<string, unknown>> };

export type PreflightRecord = {
  totals: { checks: number; allowed: number; refused: number; covered_allows: number; reports: number; misses: number; covered_misses: number; paid_usd: number };
  misses: Array<Record<string, unknown>>;
  /** The latest verdicts, newest first. */
  recent: PreflightPublishedVerdict[];
  guarantee: { active: boolean; reserve: unknown; per_verdict_usd: number; per_wallet_monthly_usd: number; terms: string };
  [key: string]: unknown;
};

// ---- Overwing Radar ----

export type RadarOp = "read" | "write" | "list" | "delete";

/**
 * One event, as you give it to `radar.sendEvents`: who touched which artifact on which shared surface, and when.
 * Hashes and sizes only. There is no field for an artifact's contents, and the API refuses a request that adds one.
 */
export type RadarEventInput = {
  /** Your own id for the event, 1 to 100 letters, digits, `.` `_` `:` or `-`. An id sent again is stored once. */
  id: string;
  /** Your name for the shared surface: a cache, a queue, a bucket. Not an artifact. */
  surfaceId: string;
  /** The key, path or ticket that was touched. */
  artifactId: string;
  /** The agent or identity that did it. */
  actorId: string;
  /** Who the actor works for. Actors that share one are never a finding. */
  principalId?: string | null;
  op: RadarOp;
  /** When it happened: a Date, an ISO 8601 time, or milliseconds since the epoch. */
  ts: string | number | Date;
  /** A digest of the content, for example "sha256:<hex>". Never the content. */
  contentHash?: string | null;
  /** On a write: the `contentHash` of the artifact this one was derived from. */
  parentArtifactHash?: string | null;
  sizeBytes?: number | null;
  /** Up to 16 short labels, 1 KB in all. Not contents: keys such as `content`, `body` or `payload` are refused. */
  metadata?: Record<string, string | number | boolean | null> | null;
};

export type RadarEventsAccepted = { accepted: number; duplicates: number; drill_id: string | null };

export type RadarStatus = {
  product: string;
  events_this_month: number;
  /** Null when the account has no limit. */
  monthly_allowance: number | null;
  monitoring: { active: boolean; status: string; current_period_end: string | null; cancel_at_period_end: boolean };
  /** A null price means not on sale. */
  pricing: { drill_usd: number | null; monitoring_monthly_usd: number | null; free_monthly_events: number; monitoring_monthly_events: number };
  limits: { events_per_request: number; request_bytes: number; requests_per_minute: number; retention_days: number; surfaces: number; decoys: number };
};

export type RadarSurfaceKind = "cache" | "queue" | "bucket" | "tickets" | "memory" | "other";

/** A surface as `radar.nameSurface` returns it. */
export type RadarSurfaceNamed = { id: string; kind: RadarSurfaceKind | null; label: string | null; created_at: string };

/** A surface as `radar.listSurfaces` returns it, with what it saw in the last day. */
export type RadarSurface = RadarSurfaceNamed & { last_24h: { events: number; actors: number; last_event_at: string | null } };

/** What a minted decoy is made to look like. */
export type RadarDecoyKind = "credentials" | "export" | "notes" | "config";

export type RadarDecoy = {
  id: string;
  /** "key": a decoy key. "artifact": an entry on a surface, minted or registered. */
  kind: "key" | "artifact";
  surface_id: string;
  artifact_id: string;
  content_hash: string;
  label: string | null;
  created_at: string;
  retired_at: string | null;
};

/** A minted decoy. `content` is shown once and never stored: write it to `artifact_id` on the surface. */
export type RadarDecoyMinted = RadarDecoy & { kind: "artifact"; content: string; content_shown_once: true; plant: string };

/** A minted decoy key. `key` and `content` are shown once and never stored: keep them where real keys are kept. */
export type RadarDecoyKeyMinted = RadarDecoy & {
  kind: "key";
  /** The address the key points at. Overwing answers it. */
  base_url: string;
  key: string;
  /** `base_url` and `key` as lines of an env file. */
  content: string;
  content_shown_once: true;
  /** Present when the address configured for decoy keys did not answer and another was used. */
  warning?: string;
  plant: string;
};

/** A decoy of your own making, registered. */
export type RadarDecoyRegistered = RadarDecoy & { kind: "artifact"; plant: string };

export type RadarSeverity = "low" | "medium" | "high" | "critical";
export type RadarDetector = "decoy_credential" | "decoy_touch" | "sweep" | "convergence" | "relay_chain" | "cold_start_cluster";

/** The actions a responder can carry out by itself, and so the ones it can report. */
export type RadarResponseAction = "revoke_identity" | "block_source" | "rotate_secrets" | "quarantine_surface";

/** What an incident recommends. Radar recommends and changes nothing on your systems. */
export type RadarRecommendedAction = {
  action: RadarResponseAction | "shorten_ttl" | "cut_write_quota" | "review_actors";
  surface: string | null;
  /** Who the action is about, when it is about someone. */
  actors?: string[];
  reason: string;
};

/** done: carried out. failed: tried and it did not work. skipped: the responder's own rules said no. dry_run: what it would have done. */
export type RadarResponseStatus = "done" | "failed" | "skipped" | "dry_run";

/** One thing your own responder reports doing about an incident, or deciding not to do. */
export type RadarResponseInput = {
  action: RadarResponseAction;
  status: RadarResponseStatus;
  /** Who or what it was done to: an identity, an address, a surface. Up to 300 characters. */
  target?: string | null;
  /** Up to 500 characters. */
  detail?: string | null;
  /** The responder's own name, for the record. Up to 80 characters. */
  by?: string | null;
};

export type RadarResponse = { action: RadarResponseAction; target: string | null; status: RadarResponseStatus; detail: string | null; by: string | null; at: string };

export type RadarResponses = {
  incident_id: string;
  responses: RadarResponse[];
  /** Seconds from the incident opening to the first action carried out. Null while nothing has been. */
  contained_in_seconds: number | null;
};

export type RadarResponseRecorded = {
  incident_id: string;
  recorded: true;
  /** How many reports the incident now holds. It keeps 50. */
  responses: number;
  contained_in_seconds: number | null;
};

export type RadarIncident = {
  id: string;
  status: "open" | "closed";
  severity: RadarSeverity;
  title: string;
  detectors: RadarDetector[];
  surfaces: string[];
  actors: string[];
  first_event_at: string;
  last_event_at: string;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  /** How a closed incident was closed: by a person, or by going quiet. */
  closed_by: string | null;
  drill_id: string | null;
  recommended_actions: RadarRecommendedAction[];
  /** Always false: Radar recommends and changes nothing on your systems. */
  enforced: false;
  /** What your own responder reported doing. */
  responses: RadarResponse[];
  contained_in_seconds: number | null;
  /** The incident in the dashboard. */
  url: string;
};

/** An incident as `radar.listIncidents` and `radar.closeIncident` return it. */
export type RadarIncidentSummary = RadarIncident & { evidence_count: number };

export type RadarEvidence = {
  detector: RadarDetector;
  /** 0 to 1. */
  score: number;
  summary: string;
  surfaces: string[];
  actors: string[];
  artifacts: string[];
  event_ids: string[];
  /** ISO times of the first and last event of the evidence. */
  from: string;
  to: string;
};

/** One event an incident's evidence names. */
export type RadarTimelineEvent = {
  at: string;
  event_id: string;
  actor_id: string;
  principal_id: string | null;
  op: RadarOp;
  surface_id: string;
  artifact_id: string;
  content_hash: string | null;
  parent_artifact_hash: string | null;
  size_bytes: number | null;
  metadata: Record<string, string | number | boolean | null> | null;
};

/** An incident as `radar.getIncident` returns it: with its evidence and the events that evidence names, in time order. */
export type RadarIncidentDetail = RadarIncident & {
  evidence: RadarEvidence[];
  /** The last webhook sent for this incident and whether the receiver took it. Null when none was sent. */
  webhook: { type: string; at?: string; delivered?: boolean } | null;
  timeline: RadarTimelineEvent[];
};

/** Detector thresholds. The field names are the API's own. */
export type RadarThresholds = {
  /** How far back a scan looks, in minutes. */
  windowMinutes: number;
  decoyTouch: { enabled: boolean };
  /** One actor reads or lists this many distinct entries it did not write, inside the span. Actors in `exemptActors` (up to 50) are left out. */
  sweep: { enabled: boolean; minArtifacts: number; windowSeconds: number; exemptActors: string[] };
  /** Actors who are strangers to each other read one artifact and each then write, all inside the window. */
  convergence: { enabled: boolean; minActors: number; windowSeconds: number };
  /** One artifact's lineage passes through this many strangers, over at least this many writes. */
  relayChain: { enabled: boolean; minActors: number; minLength: number };
  /** This many strangers with no history first appear on one surface inside the burst. */
  coldStart: { enabled: boolean; minActors: number; burstSeconds: number; newWithinSeconds: number };
  /** A hit joins an open incident it touches inside the merge window; an incident with no new evidence for the quiet span closes. */
  incident: { mergeWindowSeconds: number; quietCloseSeconds: number };
  /** Whether an incident's webhook asks your responder to act, and from which severity. Off by default. */
  response: { enabled: boolean; minSeverity: "high" | "critical" };
};

/** Any part of the thresholds. */
export type RadarThresholdsInput = { [K in keyof RadarThresholds]?: RadarThresholds[K] extends object ? Partial<RadarThresholds[K]> : RadarThresholds[K] };

export type RadarThresholdsState = {
  /** The thresholds in force. */
  thresholds: RadarThresholds;
  /** What this account changed from the defaults. */
  changed: RadarThresholdsInput;
  defaults: RadarThresholds;
};

/** What `radar.sendCloudTrail` answers for a log file or an EventBridge event. `skipped` counts records that are not a call Radar reads. */
export type RadarCloudTrailResult = { records: number; accepted: number; duplicates: number; skipped: number };

/** What `radar.sendCloudTrail` answers for a body in the form of a Firehose HTTP delivery. */
export type RadarFirehoseAck = { requestId: string; timestamp: number };

/** The body of a Radar webhook. Check its signature with `verifyRadarWebhook` before reading it. */
export type RadarIncidentWebhook = {
  type: "swarm.incident.opened" | "swarm.incident.updated";
  created_at: string;
  data: {
    id: string;
    status: "open" | "closed";
    severity: RadarSeverity;
    title: string;
    detectors: RadarDetector[];
    surfaces: string[];
    actors: string[];
    first_event_at: string;
    last_event_at: string;
    recommended_actions: RadarRecommendedAction[];
    /** Whether your responder is asked to act, and on what. Asked only when the account switched the response step on and the incident is severe enough. */
    response: { requested: false } | { requested: true; actions: RadarRecommendedAction[]; report_to: string };
    url: string;
  };
};
