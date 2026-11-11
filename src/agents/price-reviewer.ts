import { readFile } from "node:fs/promises";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { recordUsage } from "./usage.js";
export const priceChangeSchema = z.object({
  depot_id: z.string(),
  container_type: z.string(),
  previous_cents: z.number().int().nonnegative().nullable(),
  next_cents: z.number().int().positive(),
});
export const priceReviewSchema = z.object({
  needs_review: z.boolean(),
  reason: z.string(),
});
export async function reviewPriceChanges(config: Config, raw: unknown) {
  const changes = z.array(priceChangeSchema).parse(raw);
  const odd = changes.some(
    (c) =>
      c.previous_cents !== null &&
      Math.abs(c.next_cents - c.previous_cents) * 100 > c.previous_cents * 20,
  );
  const fallback = {
    needs_review: odd,
    reason: odd
      ? "A price changed by more than twenty percent."
      : "No unusual change found by the deterministic check.",
    mode: "dry-run" as const,
  };
  if (!config.OPENAI_API_KEY) return fallback;
  const agent = new Agent({
    name: "Price change reviewer",
    model: config.OPENAI_MODEL,
    modelSettings: config.OPENAI_MODEL.startsWith("gpt-5")
      ? { reasoning: { effort: "low" } }
      : {},
    instructions: await readFile("prompts/price-reviewer.md", "utf8"),
    outputType: priceReviewSchema,
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    agent,
    JSON.stringify(changes),
  );
  recordUsage({
    input: result.runContext.usage.inputTokens,
    output: result.runContext.usage.outputTokens,
  });
  const review = priceReviewSchema.parse(result.finalOutput);
  return {
    ...review,
    needs_review: odd || review.needs_review,
    mode: "live" as const,
  };
}
