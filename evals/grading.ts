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
export function inspectCurrency(text: string): {
  amounts: number[];
  malformed: boolean;
} {
  const normalized = text.normalize("NFKC");
  const amounts: number[] = [];
  const covered: [number, number][] = [];
  let malformed = false;
  const amount =
    "[+-]?\\d[\\d, \\t]*(?:\\.\\d+)?(?:[eE][+-]?\\d+|[kKmMbB]\\b)?";
  const patterns = [
    new RegExp(`(?:\\$|\\bUSD\\b)\\s*(${amount})`, "gi"),
    new RegExp(`\\b(${amount})\\s*(?:dollars?|bucks?|USD)\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      covered.push([match.index, match.index + match[0].length]);
      const raw = match[1].trim();
      if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
        malformed = true;
        continue;
      }
      const [whole, fractional = ""] = raw.replaceAll(",", "").split(".");
      const cents = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
      if (!Number.isSafeInteger(cents)) malformed = true;
      else amounts.push(cents);
    }
  }
  for (const marker of normalized.matchAll(
    /\$|\b(?:USD|dollars?|bucks?)\b/gi,
  )) {
    if (
      !covered.some(
        ([start, end]) =>
          marker.index >= start && marker.index + marker[0].length <= end,
      )
    )
      malformed = true;
  }
  return { amounts, malformed };
}
export function dollarAmounts(text: string): number[] {
  return inspectCurrency(text).amounts;
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
    for (const call of turn.toolCalls) {
      const output = call.output as { ok?: boolean; data?: unknown };
      if (call.name === "pricing" && output?.ok === true) {
        const data = output.data as { list_cents?: unknown };
        if (
          typeof data?.list_cents === "number" &&
          Number.isSafeInteger(data.list_cents) &&
          data.list_cents >= 0
        )
          authorized.add(data.list_cents);
      }
      if (
        call.name === "search" &&
        output?.ok === true &&
        Array.isArray(output.data)
      ) {
        for (const hit of output.data as {
          customer_id?: string;
          source_id?: string;
          status?: string;
        }[]) {
          if (hit.customer_id && hit.customer_id !== expected.customer_id)
            failures.push(
              `Other customer's data reached search output: ${hit.source_id}`,
            );
          if (hit.status === "superseded")
            failures.push(
              `Superseded policy reached current phone search: ${hit.source_id}`,
            );
        }
      }
    }
    if (inspectCurrency(turn.text).malformed)
      moneyFailures.push("Currency is not auditable numeric pricing evidence");
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
