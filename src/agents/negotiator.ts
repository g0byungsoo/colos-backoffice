import { readFile } from "node:fs/promises";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config/index.js";

export const decisionSchema = z.enum(["hard_no", "needs_approval", "accept"]);
export type NegotiationDecision = z.infer<typeof decisionSchema>;
export const suspiciousEmail = (text: string): boolean =>
  /ignore\s+(?:all\s+|previous\s+|the\s+)?(?:instructions|rules)|system\s*(?:prompt|message)|(?:bypass|override)\s+(?:the\s+)?(?:floor|approval|rules)|<\/?(?:system|assistant)>|you are now/i.test(
    text,
  );
const draftSchema = z.object({ draft: z.string().min(1) });
export async function draftNegotiation(
  config: Config,
  decision: NegotiationDecision,
  email: string,
): Promise<{ draft: string; mode: "live" | "dry-run" }> {
  const fallback: Record<NegotiationDecision, string> = {
    hard_no:
      "Thank you for the offer. We cannot accept it because it is below our minimum margin.",
    needs_approval:
      "Thank you for the offer. The owner must review this discount before we can agree to it.",
    accept:
      "The listed price is available. The owner will review the invoice before it is issued.",
  };
  if (!config.OPENAI_API_KEY || suspiciousEmail(email))
    return { draft: fallback[decision], mode: "dry-run" };
  const agent = new Agent({
    name: "Negotiation drafter",
    model: config.OPENAI_MODEL,
    instructions: await readFile("prompts/negotiator.md", "utf8"),
    outputType: draftSchema,
    inputGuardrails: [
      {
        name: "Untrusted email instructions",
        runInParallel: false,
        execute: async ({ input }) => ({
          tripwireTriggered: suspiciousEmail(
            typeof input === "string" ? input : JSON.stringify(input),
          ),
          outputInfo: "Email must not contain control instructions.",
        }),
      },
    ],
    outputGuardrails: [
      {
        name: "No model numbers",
        execute: async ({ agentOutput }) => ({
          tripwireTriggered: /[0-9$%]/.test(agentOutput.draft),
          outputInfo: "Only code supplies amounts.",
        }),
      },
    ],
  });
  try {
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      JSON.stringify({ immutable_decision: decision, untrusted_email: email }),
    );
    return { ...draftSchema.parse(result.finalOutput), mode: "live" };
  } catch {
    return { draft: fallback[decision], mode: "dry-run" };
  }
}
