/**
 * Overwing guardrails for the OpenAI Agents SDK (JavaScript).
 *
 *   import { Agent } from "@openai/agents";
 *   import { overwingInputGuardrail, overwingOutputGuardrail } from "overwing/openai-agents";
 *
 *   const agent = new Agent({
 *     name: "Support",
 *     instructions: "…",
 *     inputGuardrails: [overwingInputGuardrail()],
 *     outputGuardrails: [overwingOutputGuardrail()],
 *   });
 *
 * A tripped guardrail makes the SDK throw InputGuardrailTripwireTriggered or
 * OutputGuardrailTripwireTriggered; the full Overwing evaluation is on
 * `error.result.output.outputInfo`.
 */
import type { InputGuardrail, OutputGuardrail } from "@openai/agents";
import { Overwing } from "./client.js";
import type { OverwingOptions } from "./client.js";
import { OverwingError } from "./errors.js";
import type { Evaluation } from "./types.js";

export type AgentsGuardrailOptions = {
  /** An existing client, or options to build one. Defaults to OVERWING_API_KEY from the environment. */
  client?: Overwing | OverwingOptions;
  /** Rule set slug. Default "content-safety". */
  ruleSet?: string;
  /** Which verdicts trip the wire. Default "fail". */
  tripOn?: "fail" | "fail-or-review";
  /** Guardrail name shown in the SDK's results. */
  name?: string;
  /** Metadata stored with each evaluation, e.g. a user or session id. */
  metadata?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Context the rules may reference (recipient, channel, ownership). */
  context?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Called with every verdict, for logging. */
  onVerdict?: (evaluation: Evaluation, phase: "input" | "output") => void;
  /** If the Overwing API is unreachable: false (default) throws, true lets the run continue unscored. */
  failOpen?: boolean;
  /** Input guardrails only: run alongside the agent (default true) or before it starts. */
  runInParallel?: boolean;
};

export type OverwingGuardrailInfo = { evaluation: Evaluation | null; skipped?: "empty" | "unreachable" };

type Common = {
  client: Overwing;
  ruleSet: string;
  tripOn: "fail" | "fail-or-review";
  metadata: () => Record<string, unknown>;
  context: () => Record<string, unknown> | undefined;
  onVerdict?: (evaluation: Evaluation, phase: "input" | "output") => void;
  failOpen: boolean;
};

function resolveMetadata(value: AgentsGuardrailOptions["metadata"]): () => Record<string, unknown> {
  if (typeof value === "function") return value;
  const fixed = value ?? {};
  return () => fixed;
}

function setup(options: AgentsGuardrailOptions): Common {
  return {
    client: options.client instanceof Overwing ? options.client : new Overwing(options.client),
    ruleSet: options.ruleSet ?? "content-safety",
    tripOn: options.tripOn ?? "fail",
    metadata: resolveMetadata(options.metadata),
    context: () => (typeof options.context === "function" ? options.context() : options.context),
    onVerdict: options.onVerdict,
    failOpen: options.failOpen ?? false,
  };
}

/** Pull user-facing text out of the SDK's input shape (a string or a list of model items). */
export function textFromInput(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!Array.isArray(input)) return "";
  const texts: string[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as { role?: string; type?: string; content?: unknown; text?: unknown };
    if (it.role !== undefined && it.role !== "user") continue;
    if (typeof it.content === "string") texts.push(it.content);
    else if (Array.isArray(it.content)) {
      for (const part of it.content) {
        const p = part as { type?: string; text?: unknown };
        if (typeof p.text === "string" && (p.type === undefined || p.type === "input_text" || p.type === "text")) texts.push(p.text);
      }
    } else if (typeof it.text === "string") texts.push(it.text);
  }
  return texts.join("\n").trim();
}

export function textFromOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (output === null || output === undefined) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

async function run(common: Common, text: string, phase: "input" | "output"): Promise<{ tripwireTriggered: boolean; outputInfo: OverwingGuardrailInfo }> {
  if (text.length === 0) return { tripwireTriggered: false, outputInfo: { evaluation: null, skipped: "empty" } };
  let evaluation: Evaluation;
  try {
    evaluation = await common.client.evaluate(text, { ruleSet: common.ruleSet, metadata: { ...common.metadata(), phase, source: "openai-agents" }, context: common.context() });
  } catch (err) {
    if (common.failOpen && err instanceof OverwingError) return { tripwireTriggered: false, outputInfo: { evaluation: null, skipped: "unreachable" } };
    throw err;
  }
  common.onVerdict?.(evaluation, phase);
  const tripped = evaluation.verdict === "fail" || (common.tripOn === "fail-or-review" && evaluation.verdict === "review");
  return { tripwireTriggered: tripped, outputInfo: { evaluation } };
}

/** Scores the user's input before (or alongside) the agent run. */
export function overwingInputGuardrail(options: AgentsGuardrailOptions = {}): InputGuardrail {
  const common = setup(options);
  return {
    name: options.name ?? "overwing-input",
    runInParallel: options.runInParallel ?? true,
    execute: async ({ input }) => run(common, textFromInput(input), "input"),
  };
}

/** Scores the agent's final output before it is returned. */
export function overwingOutputGuardrail(options: AgentsGuardrailOptions = {}): OutputGuardrail {
  const common = setup(options);
  return {
    name: options.name ?? "overwing-output",
    execute: async ({ agentOutput }) => run(common, textFromOutput(agentOutput), "output"),
  };
}
