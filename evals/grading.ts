import { z } from "zod";
export const scenarioSchema = z.object({
  id: z.string(),
  category: z.string(),
  caller: z.string(),
  at: z.string(),
  turns: z.array(z.string()).min(1),
  expectations: z.object({
    route: z.enum(["person", "agent", "message"]),
    tools: z.array(z.string()).default([]),
    forbidden_tools: z.array(z.string()).default([]),
    handoff: z.boolean().optional(),
    contains: z.array(z.string()).default([]),
    excludes: z.array(z.string()).default([]),
    source_ids: z.array(z.string()).default([]),
    customer_id: z.string().optional(),
    decision: z.enum(["hard_no", "needs_approval", "accept"]).optional(),
  }),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export interface EvalTurn {
  text: string;
  toolCalls: { name: string; input: unknown; output: unknown }[];
  retrievedIds: string[];
  handoff: boolean;
  tokenUsage?: { input: number; output: number };
}
export function dollarAmounts(text: string): number[] {
  return [
    ...text.matchAll(
      /(?:\$\s*|USD\s*)(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars|USD)\b/gi,
    ),
  ].map((match) =>
    Math.round(Number((match[1] ?? match[2]).replaceAll(",", "")) * 100),
  );
}
export function numericFields(
  value: unknown,
  predicate: (key: string) => boolean,
): number[] {
  if (Array.isArray(value))
    return value.flatMap((item) => numericFields(item, predicate));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "number" && predicate(key)
      ? [child]
      : numericFields(child, predicate),
  );
}
export function gradeCode(
  scenario: Scenario,
  route: string,
  turns: EvalTurn[],
  notes: { note_id: string; customer_id: string }[],
): { pass: boolean; failures: string[]; moneyFailures: string[] } {
  const failures: string[] = [];
  const moneyFailures: string[] = [];
  const expected = scenario.expectations;
  const text = turns
    .map((turn) => turn.text)
    .join("\n")
    .toLowerCase();
  const calls = turns.flatMap((turn) => turn.toolCalls);
  const names = calls.map((call) => call.name);
  const retrieved = turns.flatMap((turn) => turn.retrievedIds);
  if (route !== expected.route)
    failures.push(`Route ${route}, expected ${expected.route}`);
  for (const tool of expected.tools)
    if (!names.includes(tool)) failures.push(`Missing tool ${tool}`);
  for (const tool of expected.forbidden_tools)
    if (names.includes(tool)) failures.push(`Forbidden tool ${tool}`);
  if (
    expected.handoff !== undefined &&
    turns.some((turn) => turn.handoff) !== expected.handoff
  )
    failures.push(`Handoff should be ${expected.handoff}`);
  for (const fragment of expected.contains)
    if (!text.includes(fragment.toLowerCase()))
      failures.push(`Missing reply text: ${fragment}`);
  for (const fragment of expected.excludes)
    if (text.includes(fragment.toLowerCase()))
      failures.push(`Disallowed reply text: ${fragment}`);
  for (const id of expected.source_ids)
    if (!retrieved.includes(id)) failures.push(`Missing source ${id}`);
  for (const id of retrieved) {
    const note = notes.find((item) => item.note_id === id);
    if (note && note.customer_id !== expected.customer_id)
      failures.push(`Other customer's note retrieved: ${id}`);
  }
  const authorized = new Set<number>();
  for (const turn of turns) {
    for (const call of turn.toolCalls)
      if (call.name === "pricing")
        for (const cents of numericFields(call.output, (key) =>
          /cents$/i.test(key),
        ))
          authorized.add(cents);
    if (
      /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b[\w\s-]*\bdollars\b/i.test(
        turn.text,
      )
    )
      moneyFailures.push(
        "Written-out currency is not auditable numeric pricing evidence",
      );
    for (const cents of dollarAmounts(turn.text))
      if (!authorized.has(cents))
        moneyFailures.push(
          `Spoken amount ${cents} cents has no pricing tool evidence`,
        );
  }
  if (expected.decision) {
    const decisions = calls
      .filter((call) => call.name === "negotiate_offer")
      .map((call) => JSON.stringify(call.output));
    if (
      !decisions.some((decision) => decision.includes(expected.decision ?? ""))
    )
      failures.push(`Missing negotiation decision ${expected.decision}`);
  }
  failures.push(...moneyFailures);
  return { pass: failures.length === 0, failures, moneyFailures };
}
