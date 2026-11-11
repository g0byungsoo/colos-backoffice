import { describe, expect, it } from "vitest";
import { type CallContext, createTools } from "../agents/tools.js";
import { getConfig } from "../config/index.js";
import { LocalDataSource } from "../data/index.js";

const config = getConfig({ DATA_SOURCE: "local" });
function context(at = "2026-11-11T19:00:00Z"): CallContext {
  return {
    data: new LocalDataSource({ persist: false }),
    config,
    from: "+15555550101",
    at: new Date(at),
    customerId: "C001",
    allowed: new Set(),
    toolCalls: [],
    retrievedIds: [],
    handoff: false,
    offline: true,
    callId: "tool-test",
  };
}
describe("phone money tools", () => {
  it("quotes a fresh available supplier through the pricing tool", async () => {
    const ctx = context("2026-11-03T19:00:00Z");
    const result = await createTools(ctx).invoke("pricing", {
      depot_id: "D01",
      container_type: "20GP",
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("$2800.00");
    expect(ctx.allowed.has(280000)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("cost_cents");
  });
  it("refreshes the order supplier before judging a phone offer", async () => {
    const ctx = context();
    const result = await createTools(ctx).invoke("negotiate_offer", {
      order_id: "O001",
      offer_cents: 206000,
    });
    expect(result.data).toEqual({ decision: "hard_no" });
    // The old floor was 205000. The refreshed floor is 207000.
    expect(
      (await ctx.data.read("SupplierPrices")).some(
        (p) => p.supplier_id === "S01" && p.cost_cents === 202000,
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/cost_cents|202000|207000/);
  });
  it("refuses offers when the captured source remains stale", async () => {
    const ctx = context("2026-11-17T19:00:00Z");
    const result = await createTools(ctx).invoke("negotiate_offer", {
      order_id: "O001",
      offer_cents: 280000,
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(await ctx.data.read("Approvals")).toHaveLength(0);
  });
  it("cannot negotiate or refresh another customer order", async () => {
    const ctx = context();
    const before = await ctx.data.read("SupplierPrices");
    const result = await createTools(ctx).invoke("negotiate_offer", {
      order_id: "O002",
      offer_cents: 280000,
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
    expect(await ctx.data.read("SupplierPrices")).toEqual(before);
    expect(await ctx.data.read("Approvals")).toHaveLength(0);
  });
});
