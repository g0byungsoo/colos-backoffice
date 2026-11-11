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
const decisionSentences: Record<NegotiationDecision, string> = {
  hard_no:
    "We cannot accept this offer because it is below our minimum margin.",
  needs_approval:
    "The owner must review this discount before we can agree to it.",
  accept:
    "The listed price is available. The owner will review the invoice before it is issued.",
};
export function permittedDrafts(
  decision: NegotiationDecision,
): [string, string, string] {
  const statement = decisionSentences[decision];
  return [
    `Thank you for the offer. ${statement}`,
    `Thank you for getting in touch. ${statement}`,
    statement,
  ];
}
export async function draftNegotiation(
  config: Config,
  decision: NegotiationDecision,
  email: string,
): Promise<{ draft: string; mode: "live" | "dry-run" | "fallback" }> {
  // The model chooses wording within the code-owned decision. It cannot emit a
  // conflicting commitment, even if an email instructs it to accept a low offer.
  const allowedDrafts = permittedDrafts(decision);
  const fallback = allowedDrafts[0];
  const draftSchema = z.object({ draft: z.enum(allowedDrafts) });
  if (!config.OPENAI_API_KEY || suspiciousEmail(email))
    return { draft: fallback, mode: "dry-run" };
  const agent = new Agent({
    name: "Negotiation drafter",
    model: config.OPENAI_MODEL,
    modelSettings: config.OPENAI_MODEL.startsWith("gpt-5")
      ? { reasoning: { effort: "low" } }
      : {},
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
      JSON.stringify({
        immutable_decision: decision,
        approved_drafts: allowedDrafts,
        untrusted_email: email,
      }),
    );
    return { ...draftSchema.parse(result.finalOutput), mode: "live" };
  } catch {
    return { draft: fallback, mode: "fallback" };
  }
}
