import { describe, expect, it } from "vitest";
import { allowedMoney, moneyAmounts } from "./guardrails.js";
import { toolResultSchema } from "./tools.js";

describe("tool-grounded currency", () => {
  const allowed = new Set([280000]);
  it.each([
    "$2,800.00",
    "$ 2800",
    "USD\t2800",
    "2800 dollars",
    "2,800 bucks",
    "2800 USD",
    "＄２８００",
  ])("allows an exact tool amount in %s", (text) => {
    expect(allowedMoney(text, allowed)).toBe(true);
    expect(moneyAmounts(text)).toContain(280000);
    expect(allowedMoney(text, new Set())).toBe(false);
  });
  it.each([
    "$2 800",
    "$2\t800",
    "USD 2\u202f800",
    "2 800 dollars",
    "two thousand eight hundred dollars",
    "twenty-eight hundred bucks",
    "$two thousand",
    "USD several thousand",
    "2.8k bucks",
    "$2.8k",
    "$2e3",
    "$2,80.00",
    "$2800.001",
    "$2800 thousand",
  ])("refuses ambiguous currency %s", (text) => {
    expect(allowedMoney(text, new Set([200, 80000, 280000, 28000]))).toBe(
      false,
    );
  });
  it("checks every amount in a reply and allows plain operational text", () => {
    expect(
      allowedMoney("The price is $2,800.00 and delivery is 20 bucks.", allowed),
    ).toBe(false);
    expect(
      allowedMoney("Please bring your release number to the gate.", new Set()),
    ).toBe(true);
  });
});

describe("validated tool result payloads", () => {
  it("accepts each supported output type", () => {
    const values = [
      { count: 3 },
      { list_cents: 280000, price_observed_at: "2026-11-10T18:00:00Z" },
      { order_id: "O001", status: "ready", ready: true },
      { decision: "needs_approval" },
      [
        {
          id: "K01#0",
          source_id: "K01",
          updated_at: "2026-11-01T16:00:00Z",
          text: "Payment terms",
          status: "current",
          score: 0.1,
        },
      ],
    ];
    for (const data of values)
      expect(
        toolResultSchema.safeParse({ ok: true, message: "Result", data })
          .success,
      ).toBe(true);
  });
  it.each([
    { list_cents: 1.5, price_observed_at: "yesterday" },
    { count: -1 },
    { decision: "model_approved" },
    { order_id: "O001", status: "confirmed", ready: true },
    [{ id: "K01#0", text: "Missing source and date" }],
    { secret_account: "C002" },
  ])("rejects malformed tool data %j", (data) => {
    expect(
      toolResultSchema.safeParse({ ok: true, message: "Result", data }).success,
    ).toBe(false);
  });
});
