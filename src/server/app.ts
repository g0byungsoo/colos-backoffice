import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { Hono } from "hono";
import twilio from "twilio";
import { z } from "zod";
import { createConversation } from "../agents/phone.js";
import { type CallContext, createTools } from "../agents/tools.js";
import { refreshPrices } from "../backoffice/prices.js";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/interface.js";
import { ElevenLabsBridge, type VoiceBridge } from "../phone/elevenlabs.js";

const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Signed state carries only a server-issued call id. Account identity is recovered from its stored call row.
export function createApp(
  dataFactory: () => DataSource,
  config: Config,
  bridge: VoiceBridge = new ElevenLabsBridge(config),
) {
  const app = new Hono();
  const sign = (id: string) =>
    createHmac("sha256", config.TOOL_WEBHOOK_SECRET ?? "dry-run-disabled")
      .update(id)
      .digest("hex");
  app.onError((error, c) => {
    console.error(error.message);
    return c.json({ error: "Request failed", detail: error.message }, 400);
  });
  app.get("/health", async (c) => {
    const runs = (await dataFactory().read("JobRuns"))
      .filter((r) => r.job === "prices" && r.status === "success")
      .sort((a, b) => b.finished_at.localeCompare(a.finished_at));
    const last = runs[0];
    return c.json({
      status: "ok",
      last_successful_price_run: last?.finished_at ?? null,
      age_seconds: last
        ? Math.max(
            0,
            Math.floor((Date.now() - Date.parse(last.finished_at)) / 1000),
          )
        : null,
    });
  });
  app.use("/twilio/*", async (c, next) => {
    if (config.TWILIO_AUTH_TOKEN) {
      const params = Object.fromEntries(
        new URLSearchParams(await c.req.text()),
      );
      if (
        !twilio.validateRequest(
          config.TWILIO_AUTH_TOKEN,
          c.req.header("x-twilio-signature") ?? "",
          c.req.url,
          params,
        )
      )
        return c.json({ error: "Invalid Twilio signature" }, 403);
    }
    return next();
  });
  app.post("/twilio/voice", async (c) => {
    const form = z
      .object({
        From: z.string().regex(/^\+[1-9]\d{7,14}$/),
        To: z.string(),
        CallSid: z.string().optional(),
      })
      .parse(Object.fromEntries(new URLSearchParams(await c.req.text())));
    const data = dataFactory();
    const conversation = await createConversation({
      data,
      config,
      from: form.From,
      at: new Date(),
    });
    const { context, route } = conversation;
    if (route.route === "message")
      await conversation.tools.invoke("handoff", { reason: route.reason });
    const voice = new twilio.twiml.VoiceResponse();
    if (route.route === "person" && config.OWNER_PHONE) {
      const whisper = new URL("/twilio/whisper", c.req.url);
      whisper.searchParams.set("call_id", context.callId);
      voice
        .dial()
        .number(
          { url: whisper.toString(), method: "POST" },
          config.OWNER_PHONE,
        );
      return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
    }
    if (route.route === "person") {
      voice.say("Owner transfer dry run. A callback is being recorded.");
      await conversation.tools.invoke("handoff", { reason: route.reason });
      return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
    }
    return c.body(
      await bridge.register(form.From, form.To, {
        caller_name:
          (await data.read("Customers")).find(
            (row) => row.customer_id === context.customerId,
          )?.company ?? "Unknown caller",
        open_items: route.reason,
        call_id: context.callId,
        call_token: sign(context.callId),
      }),
      200,
      { "Content-Type": "text/xml" },
    );
  });
  app.post("/twilio/whisper", async (c) => {
    const id = c.req.query("call_id");
    const row = (await dataFactory().read("Calls")).find(
      (r) => r.call_id === id,
    );
    const voice = new twilio.twiml.VoiceResponse();
    voice.say(row?.reason || "Colos customer call");
    return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
  });
  app.post("/tools/:name", async (c) => {
    if (
      !config.TOOL_WEBHOOK_SECRET ||
      !equal(c.req.header("x-tool-secret") ?? "", config.TOOL_WEBHOOK_SECRET)
    )
      return c.json({ error: "Tool endpoint disabled or unauthorized" }, 401);
    const request = z
      .object({
        call_id: z.string(),
        call_token: z.string(),
        input: z.unknown(),
      })
      .parse(await c.req.json());
    if (!equal(request.call_token, sign(request.call_id)))
      return c.json({ error: "Invalid call token" }, 403);
    const data = dataFactory();
    const rows = await data.readMany(["Calls", "Phones"]);
    const call = rows.Calls.find((r) => r.call_id === request.call_id);
    if (!call) return c.json({ error: "Unknown call" }, 404);
    // A call-scoped signed state is supplied by the bridge, not a model-chosen customer id.
    const party = rows.Phones.find((r) => r.phone_e164 === call.from_e164);
    const stateSchema = z.object({
      customerId: z.string().optional(),
      allowed: z.array(z.number().int()).default([]),
    });
    const saved = stateSchema.parse(JSON.parse(call.state_json));
    const ctx: CallContext = {
      data,
      config,
      from: call.from_e164,
      at: new Date(),
      customerId:
        saved.customerId ??
        (party?.party_type === "customer" ? party.party_id : undefined),
      party,
      allowed: new Set(saved.allowed),
      toolCalls: [],
      retrievedIds: [],
      handoff: false,
      offline: !config.OPENAI_API_KEY,
      callId: call.call_id,
    };
    const output = await createTools(ctx).invoke(
      c.req.param("name"),
      request.input,
    );
    await data.upsert(
      "Calls",
      {
        ...call,
        state_json: JSON.stringify({
          customerId: ctx.customerId,
          allowed: [...ctx.allowed],
        }),
        outcome: ctx.handoff ? "handoff" : call.outcome,
      },
      call,
    );
    await mkdir(`${config.RUNTIME_DIR}/.logs`, { recursive: true });
    await appendFile(
      `${config.RUNTIME_DIR}/.logs/${call.call_id}.jsonl`,
      `${JSON.stringify({ at: ctx.at.toISOString(), toolCalls: ctx.toolCalls, retrievedIds: ctx.retrievedIds })}\n`,
    );
    return c.json(output);
  });
  app.get("/cron/prices", async (c) => {
    if (
      !config.CRON_SECRET ||
      !equal(
        c.req.header("authorization") ?? "",
        `Bearer ${config.CRON_SECRET}`,
      )
    )
      return c.json({ error: "Cron disabled or unauthorized" }, 401);
    return c.json(await refreshPrices(dataFactory(), config));
  });
  return app;
}
