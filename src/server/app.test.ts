import { describe, expect, it } from "vitest";
import { getConfig } from "../config/index.js";
import { LocalDataSource } from "../data/local.js";
import { createApp } from "./app.js";

describe("HTTP boundaries", () => {
  it("fails closed for remote writes without secrets", async () => {
    const data = new LocalDataSource({ persist: false });
    const app = createApp(() => data, getConfig({ DATA_SOURCE: "local" }));
    expect(
      (await app.request("/tools/pricing", { method: "POST" })).status,
    ).toBe(401);
    expect((await app.request("/cron/prices")).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });
  it("checks Twilio signatures when configured", async () => {
    const app = createApp(
      () => new LocalDataSource({ persist: false }),
      getConfig({ DATA_SOURCE: "local", TWILIO_AUTH_TOKEN: "test" }),
    );
    expect(
      (
        await app.request("/twilio/voice", {
          method: "POST",
          body: "From=%2B15555550199&To=%2B15555550100",
        })
      ).status,
    ).toBe(403);
  });
  it("passes only server caller context to the voice bridge", async () => {
    let variables: Record<string, string> = {};
    const data = new LocalDataSource({ persist: false });
    const app = createApp(() => data, getConfig({ DATA_SOURCE: "local" }), {
      register: async (_from, _to, v) => {
        variables = v;
        return "<Response><Say>mock</Say></Response>";
      },
    });
    const result = await app.request("/twilio/voice", {
      method: "POST",
      body: "From=%2B15555550181&To=%2B15555550100",
    });
    expect(result.status).toBe(200);
    expect(variables.open_items).toContain("depot");
    expect(variables.call_id).toBeTruthy();
  });
});
