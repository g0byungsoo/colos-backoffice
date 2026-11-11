import { expect, it } from "vitest";
import { parseCallTime } from "./time.js";

it("interprets bare call timestamps in TIMEZONE and honors offsets", () => {
  expect(
    parseCallTime("2026-11-10T19:30", "America/Los_Angeles").toISOString(),
  ).toBe("2026-11-11T03:30:00.000Z");
  expect(
    parseCallTime("2026-11-10T19:30:00Z", "America/Los_Angeles").toISOString(),
  ).toBe("2026-11-10T19:30:00.000Z");
  expect(() =>
    parseCallTime("2026-03-08T02:30", "America/Los_Angeles"),
  ).toThrow("does not exist");
  expect(() =>
    parseCallTime("2026-02-30T19:30", "America/Los_Angeles"),
  ).toThrow();
});
