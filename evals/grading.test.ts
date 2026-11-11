import { describe, expect, it } from "vitest";
import { type EvalTurn, gradeCode, scenarioSchema } from "./grading.js";

const scenario = scenarioSchema.parse({
  id: "test",
  category: "money",
  caller: "+15555550199",
  at: "2026-11-10T19:00:00Z",
  turns: ["price"],
  expectations: { route: "agent" },
});
const turn = (text: string, calls: EvalTurn["toolCalls"] = []): EvalTurn => ({
  text,
  toolCalls: calls,
  retrievedIds: [],
  handoff: false,
});
describe("eval grader", () => {
  it("does not trust failed pricing or supplier cost as quote evidence", () => {
    for (const output of [
      { ok: false, data: { list_cents: 280000 } },
      { ok: true, data: { cost_cents: 280000 } },
    ]) {
      expect(
        gradeCode(
          scenario,
          "agent",
          [turn("$2800", [{ name: "pricing", input: {}, output }])],
          [],
        ).pass,
      ).toBe(false);
    }
  });
  it("rejects ungrounded currency variants and malformed amounts", () => {
    for (const text of [
      "2800 bucks",
      "two thousand dollars",
      "$2 800",
      "$28e2",
      "$2,80.00",
      "$2800.001",
      "＄２８００",
    ]) {
      expect(
        gradeCode(scenario, "agent", [turn(text)], []).moneyFailures.length,
      ).toBeGreaterThan(0);
    }
  });
  it("checks private search payload even when retrieved ids are omitted", () => {
    const response = turn("Nothing to see", [
      {
        name: "search",
        input: {},
        output: {
          ok: true,
          data: [
            { customer_id: "C002", source_id: "N-secret", status: "current" },
          ],
        },
      },
    ]);
    expect(gradeCode(scenario, "agent", [response], []).pass).toBe(false);
  });

  it("rejects a plausible invented price and a price returned only by search", () => {
    expect(
      gradeCode(scenario, "agent", [turn("$2800")], []).moneyFailures,
    ).toHaveLength(1);
    expect(
      gradeCode(
        scenario,
        "agent",
        [
          turn("$2800", [
            { name: "search", input: {}, output: { list_cents: 280000 } },
          ]),
        ],
        [],
      ).moneyFailures,
    ).toHaveLength(1);
  });
  it("accepts pricing evidence from an earlier turn but never a future turn", () => {
    const evidence = turn("Current price found.", [
      {
        name: "pricing",
        input: {},
        output: { ok: true, data: { list_cents: 280000 } },
      },
    ]);
    expect(
      gradeCode(scenario, "agent", [evidence, turn("$2,800.00")], []).pass,
    ).toBe(true);
    expect(
      gradeCode(scenario, "agent", [turn("$2,800.00"), evidence], []).pass,
    ).toBe(false);
  });
  it("fails other account notes even if the answer hides them", () => {
    const response = { ...turn("No details"), retrievedIds: ["secret-note"] };
    expect(
      gradeCode(
        scenario,
        "agent",
        [response],
        [{ note_id: "secret-note", customer_id: "C002" }],
      ).pass,
    ).toBe(false);
  });
});
