export type Verdict = "pass" | "fail" | "review";
export type QuestionType = "choice" | "score" | "noul";

export type RuleResult = {
  rule: string;
  type: QuestionType;
  answer: string | number | boolean;
  probability: number;
  confidence: number;
  verdict: Verdict;
};

export type Evaluation = {
  id: string;
  verdict: Verdict;
  aggregate_score: number;
  confidence: number;
  latency_ms: number;
  results: RuleResult[];
};

export type EvaluationDetail = Evaluation & {
  rule_set: string;
  input: string;
  input_token_count: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type EvaluationSummary = Omit<EvaluationDetail, "input" | "input_token_count" | "results">;

export type BatchItem = { id?: string; input: string; metadata?: Record<string, unknown> };
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
