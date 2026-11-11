import { describe, expect, it } from "vitest";
import {
  assertFreshPrice,
  assertInvoiceDiscount,
  decideOffer,
  discountCents,
  invoiceMath,
  isPriceStale,
  priceFloor,
} from "./pricing.js";
import { isBusinessHours, routeCall } from "./routing.js";
import type { Row } from "./schemas.js";

const rule: Row<"PricingRules"> = {
  customer_id: "C001",
  kind: "percent",
  amount: 5,
  starts_on: "2026-01-01",
  ends_on: "2026-12-31",
};
const weekly = {
  observedAt: "2026-11-03T18:00:00Z",
  at: new Date("2026-11-10T19:30:00Z"),
  updateWeekday: 1,
  updateTimeLocal: "08:00",
  timezone: "America/Los_Angeles",
};
describe("money and regression rules", () => {
  it("hard refuses below cost plus 50 dollars and requires approval for every other discount", () => {
    expect(priceFloor(200000)).toBe(205000);
    expect(
      decideOffer({ offerCents: 204999, listCents: 280000, costCents: 200000 }),
    ).toBe("hard_no");
    expect(
      decideOffer({ offerCents: 205000, listCents: 280000, costCents: 200000 }),
    ).toBe("needs_approval");
    expect(
      decideOffer({ offerCents: 280000, listCents: 280000, costCents: 200000 }),
    ).toBe("accept");
  });
  it("catches the skipped regular customer discount regression", () => {
    expect(() =>
      assertInvoiceDiscount(0, 280000, [rule], "2026-11-10"),
    ).toThrow("discount");
    const result = invoiceMath({
      listCents: 280000,
      costCents: 200000,
      qty: 2,
      rules: [rule],
      date: "2026-11-10",
    });
    expect(result.discountCents).toBe(14000);
    expect(result.finalCents).toBe(266000);
    expect(result.totalCents).toBe(532000);
  });
  it("catches the stale price invoice regression even when the old cost would pass the floor", () => {
    expect(() => assertFreshPrice(weekly)).toThrow("Stale");
    expect(
      isPriceStale({ ...weekly, observedAt: "2026-11-09T16:00:00Z" }),
    ).toBe(false);
  });
  it("checks the exact weekly update boundary across daylight saving time", () => {
    expect(
      isPriceStale({
        ...weekly,
        observedAt: "2026-10-30T18:00:00Z",
        at: new Date("2026-11-02T15:59:00Z"),
      }),
    ).toBe(false);
    expect(
      isPriceStale({
        ...weekly,
        observedAt: "2026-10-30T18:00:00Z",
        at: new Date("2026-11-02T16:00:00Z"),
      }),
    ).toBe(true);
  });
  it("blocks a valid discount that would breach the margin floor", () => {
    expect(() =>
      invoiceMath({
        listCents: 210000,
        costCents: 200000,
        qty: 1,
        rules: [rule],
        date: "2026-11-10",
      }),
    ).toThrow("floor");
  });
  it("does not stack discounts, honors dates, and rounds down to integer cents", () => {
    expect(discountCents(101, [rule], "2026-11-10")).toBe(5);
    expect(
      discountCents(
        280000,
        [rule, { ...rule, kind: "fixed", amount: 10000 }],
        "2026-11-10",
      ),
    ).toBe(14000);
    expect(discountCents(280000, [rule], "2027-01-01")).toBe(0);
  });
  it("rejects fractional and unsafe money", () => {
    expect(() => priceFloor(1.5)).toThrow();
    expect(() => priceFloor(Number.MAX_SAFE_INTEGER)).toThrow();
  });
});
describe("routing", () => {
  const customer: Row<"Customers"> = {
    customer_id: "C001",
    company: "Test Company",
    contact_name: "Test",
    email: "test@example.com",
    created_at: "2026-01-01T00:00:00Z",
  };
  const phone: Row<"Phones"> = {
    phone_e164: "+15555550101",
    party_type: "customer",
    party_id: "C001",
    label: "Test",
  };
  const issue: Row<"Issues"> = {
    issue_id: "I1",
    customer_id: "C001",
    order_id: "O001",
    kind: "invoice",
    status: "open",
    summary: "Wrong invoice",
    opened_at: "2026-11-01T00:00:00Z",
  };
  it("routes open issues to a person with a reason during business hours", () => {
    expect(
      routeCall({
        phone,
        customer,
        issues: [issue],
        at: new Date("2026-11-10T19:30:00Z"),
      }),
    ).toEqual({
      route: "person",
      reason: "Wrong invoice",
      priorityCallback: false,
    });
  });
  it("takes a priority message after hours", () => {
    expect(
      routeCall({
        phone,
        customer,
        issues: [issue],
        at: new Date("2026-11-11T03:00:00Z"),
      }),
    ).toMatchObject({ route: "message", priorityCallback: true });
  });
  it("keeps depot calls with the agent and unknown calls unverified", () => {
    expect(
      routeCall({
        phone: { ...phone, party_type: "depot" },
        issues: [],
        at: new Date("2026-11-10T19:30:00Z"),
      }).route,
    ).toBe("agent");
    expect(
      routeCall({ issues: [], at: new Date("2026-11-10T19:30:00Z") }).reason,
    ).toContain("verify");
  });
  it("rings regular customers during business hours and respects the end boundary", () => {
    expect(
      routeCall({
        phone,
        customer,
        issues: [],
        at: new Date("2026-11-10T19:30:00Z"),
      }).route,
    ).toBe("person");
    expect(isBusinessHours(new Date("2026-11-11T02:00:00Z"))).toBe(false);
    expect(isBusinessHours(new Date("2026-11-10T16:00:00Z"))).toBe(true);
  });
});

it("does exact percent math near the safe integer limit", () => {
  expect(
    discountCents(
      Number.MAX_SAFE_INTEGER,
      [{ ...rule, amount: 99 }],
      "2026-11-10",
    ),
  ).toBe(Number((BigInt(Number.MAX_SAFE_INTEGER) * 99n) / 100n));
  expect(() => priceFloor(100000, 4999)).toThrow("Floor margin");
});
