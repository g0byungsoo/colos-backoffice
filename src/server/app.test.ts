import twilio from "twilio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../config/index.js";
import { LocalDataSource } from "../data/local.js";
import { createApp } from "./app.js";

const auth = "synthetic-twilio-token";
const secret = "synthetic-tools-secret";
const config = getConfig({
  DATA_SOURCE: "local",
  TWILIO_AUTH_TOKEN: auth,
  TOOL_WEBHOOK_SECRET: secret,
});
function signed(
  app: ReturnType<typeof createApp>,
  path: string,
  values: Record<string, string> = {},
) {
  const url = new URL(path, "http://localhost").toString();
  return app.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilio.getExpectedTwilioSignature(
        auth,
        url,
        values,
      ),
    },
    body: new URLSearchParams(values).toString(),
  });
}
function harness() {
  const data = new LocalDataSource({ persist: false });
  let variables: Record<string, string> = {};
  const register = vi.fn(
    async (_from: string, _to: string, v: Record<string, string>) => {
      variables = v;
      return "<Response><Say>mock</Say></Response>";
    },
  );
  const app = createApp(() => data, config, { register });
  return {
    data,
    app,
    register,
    get variables() {
      return variables;
    },
  };
}
async function start(h: ReturnType<typeof harness>, from = "+15555550199") {
  return signed(h.app, "/twilio/voice", {
    From: from,
    To: "+15555550100",
    CallSid: "synthetic-call",
  });
}
function invoke(
  h: ReturnType<typeof harness>,
  name: string,
  input: unknown,
  overrides: Record<string, unknown> = {},
) {
  return h.app.request(`/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tool-secret": secret },
    body: JSON.stringify({
      call_id: h.variables.call_id,
      call_token: h.variables.call_token,
      input,
      ...overrides,
    }),
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());
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
  it("never mints sessions or exposes accounts when Twilio is unconfigured", async () => {
    const data = new LocalDataSource({ persist: false });
    const register = vi.fn();
    const app = createApp(
      () => data,
      getConfig({
        DATA_SOURCE: "local",
        TOOL_WEBHOOK_SECRET: secret,
        OWNER_PHONE: "+15555550100",
      }),
      { register },
    );
    const result = await app.request("/twilio/voice", {
      method: "POST",
      body: "From=%2B15555550102&To=%2B15555550100",
    });
    expect(await result.text()).toContain("dry run");
    expect(register).not.toHaveBeenCalled();
    expect(await data.read("Calls")).toHaveLength(0);
    expect(await data.read("Outbox")).toHaveLength(0);
    expect(
      (
        await app.request("/tools/pickup_status", {
          method: "POST",
          headers: { "x-tool-secret": secret },
        })
      ).status,
    ).toBe(401);
    const whisper = await app.request("/twilio/whisper?call_id=anything", {
      method: "POST",
    });
    expect(await whisper.text()).toContain("dry run");
  });
  it("rejects missing or invalid signatures before looking up a caller", async () => {
    const h = harness();
    const read = vi.spyOn(h.data, "readMany");
    expect(
      (
        await h.app.request("/twilio/voice", {
          method: "POST",
          body: "From=%2B15555550102&To=%2B15555550100",
        })
      ).status,
    ).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
  });
  it("accepts signed depot calls and passes trusted context and a token", async () => {
    const h = harness();
    expect((await start(h, "+15555550181")).status).toBe(200);
    expect(h.variables.open_items).toContain("depot");
    expect(h.variables.call_id).toBeTruthy();
    expect(h.variables.call_token).toMatch(/^\d+\.[a-f0-9]{64}$/);
    const result = await invoke(h, "availability", {
      container_type: "20GP",
      depot_id: "D01",
    });
    expect(result.status).toBe(200);
    expect((await result.json()).ok).toBe(true);
  });
  it("rejects a valid signature reused with a different caller", async () => {
    const h = harness();
    const url = "http://localhost/twilio/voice";
    const values = { From: "+15555550199", To: "+15555550100" };
    const result = await h.app.request(url, {
      method: "POST",
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          auth,
          url,
          values,
        ),
      },
      body: new URLSearchParams({ ...values, From: "+15555550102" }).toString(),
    });
    expect(result.status).toBe(403);
    expect(await h.data.read("Calls")).toHaveLength(0);
  });
  it("requires both call token and shared secret and handles Unicode without throwing", async () => {
    const h = harness();
    await start(h);
    expect(
      (await invoke(h, "availability", {}, { call_token: "bad" })).status,
    ).toBe(403);
    const response = await h.app.request("/tools/availability", {
      method: "POST",
      headers: { "x-tool-secret": "µ".repeat(secret.length) },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(
      (await invoke(h, "availability", {}, { customer_id: "C002" })).status,
    ).toBe(400);
  });
  it("binds tokens to the stored caller and expires them", async () => {
    const h = harness();
    await start(h);
    const call = (await h.data.read("Calls"))[0];
    await h.data.upsert("Calls", { ...call, from_e164: "+15555550102" }, call);
    expect(
      (
        await invoke(h, "availability", {
          container_type: null,
          depot_id: null,
        })
      ).status,
    ).toBe(403);
    await h.data.upsert("Calls", call, { ...call, from_e164: "+15555550102" });
    vi.setSystemTime(new Date("2026-11-11T05:00:00Z"));
    expect(
      (
        await invoke(h, "availability", {
          container_type: null,
          depot_id: null,
        })
      ).status,
    ).toBe(403);
  });
  it("requires matching identity and prevents access or switching to another customer", async () => {
    const h = harness();
    await start(h);
    expect(
      (await (await invoke(h, "pickup_status", { order_id: "O001" })).json())
        .ok,
    ).toBe(false);
    expect(
      (
        await (
          await invoke(h, "verify_identity", {
            order_id: "O001",
            company: "wrong company",
          })
        ).json()
      ).ok,
    ).toBe(false);
    expect(
      (
        await (
          await invoke(h, "verify_identity", {
            order_id: "O001",
            company: "Alder Wharf Works",
          })
        ).json()
      ).ok,
    ).toBe(true);
    expect(
      (await (await invoke(h, "pickup_status", { order_id: "O001" })).json())
        .ok,
    ).toBe(true);
    expect(
      (await (await invoke(h, "pickup_status", { order_id: "O002" })).json())
        .ok,
    ).toBe(false);
    const other = (await h.data.read("Customers")).find(
      (c) => c.customer_id === "C002",
    );
    expect(
      (
        await (
          await invoke(h, "verify_identity", {
            order_id: "O002",
            company: other?.company,
          })
        ).json()
      ).ok,
    ).toBe(false);
    const result = await (
      await invoke(h, "search", { query: "customer notes" })
    ).json();
    expect(result.ok).toBe(true);
    expect(
      result.data.every(
        (hit: { customer_id?: string }) =>
          !hit.customer_id || hit.customer_id === "C001",
      ),
    ).toBe(true);
  });
  it("whispers the open issue reason before dialing the owner", async () => {
    vi.setSystemTime(new Date("2026-11-10T19:30:00Z"));
    const data = new LocalDataSource({ persist: false });
    const app = createApp(() => data, {
      ...config,
      OWNER_PHONE: "+15555550100",
    });
    const response = await signed(app, "/twilio/voice", {
      From: "+15555550102",
      To: "+15555550100",
    });
    const xml = await response.text();
    expect(xml).toContain("<Dial>");
    expect(xml).toContain("+15555550100");
    const call = (await data.read("Calls"))[0];
    const whisper = await signed(
      app,
      `/twilio/whisper?call_id=${call.call_id}`,
    );
    expect(await whisper.text()).toContain(
      "Delivery missed the agreed pickup date",
    );
  });
  it("records an after-hours issue as a priority callback", async () => {
    const h = harness();
    await start(h, "+15555550102");
    const messages = await h.data.read("Outbox");
    expect(messages[0].subject).toBe("Priority callback");
    expect(h.variables.open_items).toContain("Delivery missed");
    expect((await h.data.read("Calls"))[0].outcome).toBe("handoff");
  });
  it("does not echo internal errors in public responses", async () => {
    const data = new LocalDataSource({ persist: false });
    vi.spyOn(data, "read").mockRejectedValue(
      new Error("private-credential-marker"),
    );
    const app = createApp(() => data, config);
    const response = await app.request("/health");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private-credential-marker");
  });
});

it("restores a completed handoff across separate tool HTTP requests", async () => {
  const h = harness();
  await start(h);
  expect(
    (
      await (
        await invoke(h, "verify_identity", {
          order_id: "O001",
          company: "Alder Wharf Works",
        })
      ).json()
    ).ok,
  ).toBe(true);
  expect(
    (await (await invoke(h, "handoff", { reason: "Invoice problem" })).json())
      .ok,
  ).toBe(true);
  const result = await (
    await invoke(h, "pickup_status", { order_id: "O001" })
  ).json();
  expect(result.ok).toBe(false);
  expect((await h.data.read("Calls"))[0].outcome).toBe("handoff");
});
