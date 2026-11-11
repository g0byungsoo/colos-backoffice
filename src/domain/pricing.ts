import { localParts } from "./routing.js";
import type { Row } from "./schemas.js";

function money(n: number) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("Money must be nonnegative safe integer cents");
  return n;
}
export function priceFloor(costCents: number, floorMarginCents = 5000) {
  return money(money(costCents) + money(floorMarginCents));
}
export function discountCents(
  listCents: number,
  rules: Row<"PricingRules">[],
  date: string,
): number {
  money(listCents);
  const active = rules.filter(
    (r) => r.starts_on <= date && (!r.ends_on || r.ends_on >= date),
  );
  // Multiple rules do not stack. The most favorable active rule wins.
  return Math.min(
    listCents,
    Math.max(
      0,
      ...active.map((r) =>
        r.kind === "fixed"
          ? money(r.amount)
          : Math.floor((listCents * r.amount) / 100),
      ),
    ),
  );
}
export function invoiceMath(input: {
  listCents: number;
  costCents: number;
  qty: number;
  rules: Row<"PricingRules">[];
  date: string;
  floorMarginCents?: number;
}) {
  const {
    listCents,
    costCents,
    qty,
    rules,
    date,
    floorMarginCents = 5000,
  } = input;
  if (!Number.isSafeInteger(qty) || qty < 1)
    throw new Error("Quantity must be a positive integer");
  money(listCents);
  money(costCents);
  const discount = discountCents(listCents, rules, date),
    final = listCents - discount,
    margin = final - costCents;
  if (final < priceFloor(costCents, floorMarginCents))
    throw new Error("Invoice blocked: margin below floor");
  return {
    listCents,
    discountCents: discount,
    finalCents: final,
    costCents,
    marginCents: margin,
    qty,
    totalCents: money(final * qty),
  };
}
export function decideOffer(input: {
  offerCents: number;
  listCents: number;
  costCents: number;
  floorMarginCents?: number;
}): "hard_no" | "needs_approval" | "accept" {
  money(input.offerCents);
  money(input.listCents);
  if (input.offerCents < priceFloor(input.costCents, input.floorMarginCents))
    return "hard_no";
  return input.offerCents < input.listCents ? "needs_approval" : "accept";
}
export function isPriceStale(input: {
  observedAt: string;
  at: Date;
  updateWeekday: number;
  updateTimeLocal: string;
  timezone: string;
}): boolean {
  const observed = new Date(input.observedAt);
  if (!Number.isFinite(observed.getTime()) || observed > input.at) return true;
  // Scan UTC minutes so timezone offsets and daylight saving changes are honored.
  // More than a week old always crosses at least one weekly supplier update.
  if (input.at.getTime() - observed.getTime() > 8 * 86400000) return true;
  const end = localParts(input.at, input.timezone);
  const start = localParts(observed, input.timezone);
  for (
    let ms = Date.UTC(
      Number(start.date.slice(0, 4)),
      Number(start.date.slice(5, 7)) - 1,
      Number(start.date.slice(8, 10)),
    );
    ms <=
    Date.UTC(
      Number(end.date.slice(0, 4)),
      Number(end.date.slice(5, 7)) - 1,
      Number(end.date.slice(8, 10)),
    );
    ms += 86400000
  ) {
    const day = new Date(ms);
    if (day.getUTCDay() !== input.updateWeekday) continue;
    const scheduled = `${day.toISOString().slice(0, 10)}T${input.updateTimeLocal}`;
    if (
      scheduled > `${start.date}T${start.time}` &&
      scheduled <= `${end.date}T${end.time}`
    )
      return true;
  }
  return false;
}
export function assertFreshPrice(
  input: Parameters<typeof isPriceStale>[0],
): void {
  if (isPriceStale(input))
    throw new Error("Stale supplier price: refresh before invoice approval");
}
export function assertInvoiceDiscount(
  actualDiscount: number,
  listCents: number,
  rules: Row<"PricingRules">[],
  date: string,
): void {
  if (actualDiscount !== discountCents(listCents, rules, date))
    throw new Error("Invoice discount does not match active pricing rules");
}
