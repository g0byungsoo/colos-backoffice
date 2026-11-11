import { describe, expect, it } from "vitest";
import { getConfig } from "../config/index.js";
import { schemas } from "./schemas.js";

describe("configuration and row boundaries", () => {
  it("rejects malformed business hours and a lower floor", () => {
    for (const BUSINESS_HOURS of ["25:00-26:00", "18:00-08:00", "08:75-18:00"])
      expect(() => getConfig({ BUSINESS_HOURS })).toThrow();
    expect(() => getConfig({ FLOOR_MARGIN_CENTS: "4999" })).toThrow();
  });
  it("does not treat an empty supplier price as zero", () => {
    const row = {
      supplier_id: "S01",
      depot_id: "D01",
      container_type: "20GP",
      observed_at: "2026-11-10T18:00:00Z",
      source_ref: "fixture",
      cost_cents: "",
    };
    expect(() => schemas.SupplierPrices.parse(row)).toThrow();
    expect(
      schemas.SupplierPrices.parse({ ...row, cost_cents: "200000" }).cost_cents,
    ).toBe(200000);
  });
});
