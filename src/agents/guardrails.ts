import type { InputGuardrail, OutputGuardrail } from "@openai/agents";
export function unsafeInput(text: string): boolean {
  return /ignore\s+(all\s+)?(previous|prior|system)|system\s*prompt|developer\s*message|override\s+(the\s+)?(rules|instructions)|\b(fuck|idiot|kill yourself)\b/i.test(
    text,
  );
}
function scanMoney(text: string): { amounts: number[]; valid: boolean } {
  const normalized = text.normalize("NFKC");
  const spans: { start: number; end: number }[] = [];
  const amounts: number[] = [];
  let valid = true;
  // Internal whitespace, exponent notation, scales and malformed grouping are
  // ambiguous. The agent must render the exact numeric currency from the tool.
  const number =
    "[+-]?\\d[\\d, \\t]*(?:\\.\\d+)?(?:[eE][+-]?\\d+|[kKmMbB]\\b)?";
  const expressions = [
    new RegExp(`(?:\\$|\\bUSD\\b)\\s*(${number})`, "gi"),
    new RegExp(`\\b(${number})\\s*(?:dollars?|bucks?|USD)\\b`, "gi"),
  ];
  for (const expression of expressions) {
    for (const match of normalized.matchAll(expression)) {
      const raw = match[1].trim();
      spans.push({ start: match.index, end: match.index + match[0].length });
      if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) {
        valid = false;
        continue;
      }
      const [whole, fraction = ""] = raw.replaceAll(",", "").split(".");
      const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
      if (!Number.isSafeInteger(cents)) valid = false;
      else amounts.push(cents);
    }
  }
  for (const marker of normalized.matchAll(
    /\$|\b(?:USD|dollars?|bucks?)\b/gi,
  )) {
    if (
      !spans.some(
        (span) =>
          marker.index >= span.start &&
          marker.index + marker[0].length <= span.end,
      )
    )
      valid = false;
  }
  if (/\d[\d,.]*\s*(?:hundred|thousand|million|billion)\b/i.test(normalized))
    valid = false;
  return { amounts, valid };
}
export function moneyAmounts(text: string): number[] {
  return scanMoney(text).amounts;
}
export function allowedMoney(text: string, allowed: Set<number>): boolean {
  const parsed = scanMoney(text);
  return parsed.valid && parsed.amounts.every((cents) => allowed.has(cents));
}
export const inputGuardrail: InputGuardrail = {
  name: "abuse_and_injection",
  runInParallel: false,
  execute: async ({ input }) => ({
    tripwireTriggered: unsafeInput(
      typeof input === "string" ? input : JSON.stringify(input),
    ),
    outputInfo: "Untrusted instructions and abuse are refused.",
  }),
};
export function outputGuardrail(allowed: Set<number>): OutputGuardrail {
  return {
    name: "tool_grounded_currency",
    execute: async ({ agentOutput }) => ({
      tripwireTriggered: !allowedMoney(String(agentOutput), allowed),
      outputInfo:
        "Currency must appear in pricing results in this conversation.",
    }),
  };
}
