/**
 * Overwing guardrail middleware for the Vercel AI SDK (specification v4,
 * AI SDK 6 and 7). Wrap any model:
 *
 *   import { wrapLanguageModel } from "ai";
 *   import { overwingGuardrail } from "overwing/ai-sdk";
 *
 *   const model = wrapLanguageModel({ model: openai("gpt-5"), middleware: overwingGuardrail() });
 *
 * Every response is scored before it is returned. By default a `fail`
 * verdict throws OverwingGuardrailError, a `review` verdict is annotated in
 * providerMetadata.overwing, and streams are buffered so nothing that fails
 * reaches the user.
 */
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult, LanguageModelV4Middleware, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { Overwing } from "./client.js";
import type { OverwingOptions } from "./client.js";
import { OverwingError } from "./errors.js";
import type { Evaluation, Verdict } from "./types.js";

export type VerdictAction = "throw" | "replace" | "annotate";

export type GuardrailOptions = {
  /** An existing client, or options to build one. Defaults to OVERWING_API_KEY from the environment. */
  client?: Overwing | OverwingOptions;
  /** Rule set slug. Default "content-safety". */
  ruleSet?: string;
  /** What to do when the model's output fails. Default "throw". */
  onFail?: VerdictAction;
  /** What to do when a rule is unsure. Default "annotate". */
  onReview?: VerdictAction;
  /** Text returned in place of a failed/reviewed output when the action is "replace". */
  replacement?: string | ((evaluation: Evaluation) => string);
  /** Also score the latest user message before calling the model. A fail throws. Default false. */
  checkInput?: boolean;
  /**
   * "buffer" (default): hold the stream until the model finishes, score it, then release it.
   * "passthrough": stream tokens as they arrive and score at the end; a fail ends the stream with an error.
   */
  streaming?: "buffer" | "passthrough";
  /** Metadata stored with each evaluation, e.g. a user or session id. */
  metadata?: (params: LanguageModelV4CallOptions) => Record<string, unknown> | undefined;
  /** Called with every verdict, for logging. */
  onVerdict?: (evaluation: Evaluation, phase: "input" | "output") => void;
  /** If the Overwing API is unreachable: false (default) throws, true lets the output through unscored. */
  failOpen?: boolean;
};

export class OverwingGuardrailError extends Error {
  readonly evaluation: Evaluation;
  readonly phase: "input" | "output";
  constructor(evaluation: Evaluation, phase: "input" | "output") {
    const failed = evaluation.results.filter((r) => r.verdict !== "pass").map((r) => `${r.rule}=${r.verdict}`).join(", ");
    super(`Overwing ${evaluation.verdict.toUpperCase()} on ${phase} (${failed || "no rule detail"}) · ${evaluation.id}`);
    this.name = "OverwingGuardrailError";
    this.evaluation = evaluation;
    this.phase = phase;
  }
}

const DEFAULT_REPLACEMENT = "I can't share that response.";

function textOf(content: LanguageModelV4GenerateResult["content"]): string {
  return content.filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text").map((c) => c.text).join("\n").trim();
}

function lastUserText(params: LanguageModelV4CallOptions): string {
  for (let i = params.prompt.length - 1; i >= 0; i--) {
    const m = params.prompt[i];
    if (m && m.role === "user") {
      return m.content.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text").map((p) => p.text).join("\n").trim();
    }
  }
  return "";
}

function metadataFor(evaluation: Evaluation): Record<string, string | number | boolean> {
  return {
    id: evaluation.id,
    verdict: evaluation.verdict,
    aggregate_score: evaluation.aggregate_score,
    confidence: evaluation.confidence,
    latency_ms: evaluation.latency_ms,
    failed_rules: evaluation.results.filter((r) => r.verdict === "fail").map((r) => r.rule).join(","),
    review_rules: evaluation.results.filter((r) => r.verdict === "review").map((r) => r.rule).join(","),
  };
}

export function overwingGuardrail(options: GuardrailOptions = {}): LanguageModelV4Middleware {
  const client = options.client instanceof Overwing ? options.client : new Overwing(options.client);
  const ruleSet = options.ruleSet ?? "content-safety";
  const onFail = options.onFail ?? "throw";
  const onReview = options.onReview ?? "annotate";
  const streaming = options.streaming ?? "buffer";
  const failOpen = options.failOpen ?? false;

  const replacementFor = (e: Evaluation): string =>
    typeof options.replacement === "function" ? options.replacement(e) : (options.replacement ?? DEFAULT_REPLACEMENT);

  async function score(text: string, params: LanguageModelV4CallOptions, phase: "input" | "output"): Promise<Evaluation | null> {
    if (text.length === 0) return null;
    try {
      const evaluation = await client.evaluate(text, { ruleSet, metadata: { ...(options.metadata?.(params) ?? {}), phase, source: "ai-sdk" } });
      options.onVerdict?.(evaluation, phase);
      return evaluation;
    } catch (err) {
      if (failOpen && err instanceof OverwingError) return null;
      throw err;
    }
  }

  function actionFor(verdict: Verdict): VerdictAction | "pass" {
    if (verdict === "fail") return onFail;
    if (verdict === "review") return onReview;
    return "pass";
  }

  return {
    specificationVersion: "v4",

    transformParams: async ({ params }) => {
      if (!options.checkInput) return params;
      const evaluation = await score(lastUserText(params), params, "input");
      if (evaluation && evaluation.verdict === "fail") throw new OverwingGuardrailError(evaluation, "input");
      if (evaluation && evaluation.verdict === "review" && onReview === "throw") throw new OverwingGuardrailError(evaluation, "input");
      return params;
    },

    wrapGenerate: async ({ doGenerate, params }) => {
      const result = await doGenerate();
      const evaluation = await score(textOf(result.content), params, "output");
      if (!evaluation) return result;
      const providerMetadata = { ...(result.providerMetadata ?? {}), overwing: metadataFor(evaluation) };
      const action = actionFor(evaluation.verdict);
      if (action === "throw") throw new OverwingGuardrailError(evaluation, "output");
      if (action === "replace") {
        return { ...result, content: [{ type: "text", text: replacementFor(evaluation) }], providerMetadata };
      }
      return { ...result, providerMetadata };
    },

    wrapStream: async ({ doStream, params }) => {
      const { stream, ...rest } = await doStream();
      let text = "";
      const held: LanguageModelV4StreamPart[] = [];
      let textId = "overwing-0";

      const finish = async (controller: TransformStreamDefaultController<LanguageModelV4StreamPart>, finishPart: Extract<LanguageModelV4StreamPart, { type: "finish" }>): Promise<void> => {
        const evaluation = await score(text.trim(), params, "output");
        const action = evaluation ? actionFor(evaluation.verdict) : "pass";
        const meta = evaluation ? { ...(finishPart.providerMetadata ?? {}), overwing: metadataFor(evaluation) } : finishPart.providerMetadata;

        if (evaluation && action === "throw") {
          if (streaming === "buffer") held.length = 0;
          controller.enqueue({ type: "error", error: new OverwingGuardrailError(evaluation, "output") });
          return;
        }
        if (evaluation && action === "replace") {
          if (streaming === "buffer") {
            held.length = 0;
          }
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({ type: "text-delta", id: textId, delta: replacementFor(evaluation) });
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({ ...finishPart, providerMetadata: meta });
          return;
        }
        for (const part of held) controller.enqueue(part);
        held.length = 0;
        controller.enqueue({ ...finishPart, providerMetadata: meta });
      };

      const transformed = stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          async transform(part, controller) {
            if (part.type === "text-start") textId = part.id;
            if (part.type === "text-delta") text += part.delta;
            if (part.type === "finish") {
              await finish(controller, part);
              return;
            }
            if (streaming === "buffer") held.push(part);
            else controller.enqueue(part);
          },
          flush(controller) {
            // Stream ended without a finish part: release what we have.
            for (const part of held) controller.enqueue(part);
            held.length = 0;
          },
        }),
      );
      return { stream: transformed, ...rest };
    },
  };
}
