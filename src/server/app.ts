import { appendFile, mkdir } from "node:fs/promises";
import { Hono } from "hono";
import twilio from "twilio";
import { z } from "zod";
import { createConversation } from "../agents/phone.js";
import { type CallContext, createTools } from "../agents/tools.js";
import { refreshPrices } from "../backoffice/prices.js";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/interface.js";
import { RequestDataSource } from "../data/sheets.js";
import { equalSecret, issueCallToken, verifyCallToken } from "../phone/auth.js";
import { ElevenLabsBridge, type VoiceBridge } from "../phone/elevenlabs.js";

export function createApp(
  dataFactory: () => DataSource,
  config: Config,
  bridge: VoiceBridge = new ElevenLabsBridge(config),
) {
  const app = new Hono<{ Variables: { data: RequestDataSource } }>();
  app.use("*", async (c, next) => {
    c.set("data", new RequestDataSource(dataFactory()));
    return next();
  });
  app.onError((error, c) => {
    return c.json(
      { error: "Request failed" },
      error instanceof z.ZodError ? 400 : 500,
    );
  });
  app.get("/health", async (c) => {
    const runs = (await c.get("data").read("JobRuns"))
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
    if (!config.TWILIO_AUTH_TOKEN) {
      const voice = new twilio.twiml.VoiceResponse();
      voice.say(
        "Twilio dry run. Signature validation is not configured. Use local chat to test caller routing.",
      );
      return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
    }
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
        To: z.string().regex(/^\+[1-9]\d{7,14}$/),
        CallSid: z.string().optional(),
      })
      .parse(Object.fromEntries(new URLSearchParams(await c.req.text())));
    const data = c.get("data");
    const conversation = await createConversation({
      data,
      config,
      from: form.From,
      at: new Date(),
    });
    const { context, route } = conversation;
    if (route.route === "message") {
      await conversation.tools.invoke("handoff", { reason: route.reason });
      await conversation.finish();
    }
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
      await conversation.finish();
      return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
    }
    if (!config.TOOL_WEBHOOK_SECRET) {
      voice.say(
        "Voice tools dry run. The tool webhook secret is not configured.",
      );
      return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
    }
    const storedCall = (await data.read("Calls")).find(
      (row) => row.call_id === context.callId,
    );
    if (!storedCall) throw new Error("Call was not saved");
    const caller = (await data.read("Customers")).find(
      (row) => row.customer_id === context.customerId,
    );
    return c.body(
      await bridge.register(form.From, form.To, {
        caller_name:
          caller?.contact_name ?? context.party?.label ?? "Unknown caller",
        caller_company: caller?.company ?? "",
        open_items: route.reason,
        call_id: context.callId,
        call_token: issueCallToken(storedCall, config.TOOL_WEBHOOK_SECRET),
      }),
      200,
      { "Content-Type": "text/xml" },
    );
  });
  app.post("/twilio/whisper", async (c) => {
    const id = c.req.query("call_id");
    const row = (await c.get("data").read("Calls")).find(
      (r) => r.call_id === id,
    );
    const voice = new twilio.twiml.VoiceResponse();
    voice.say(row?.reason || "Colos customer call");
    return c.body(voice.toString(), 200, { "Content-Type": "text/xml" });
  });
  app.post("/tools/:name", async (c) => {
    if (
      !config.TWILIO_AUTH_TOKEN ||
      !config.TOOL_WEBHOOK_SECRET ||
      !equalSecret(
        c.req.header("x-tool-secret") ?? "",
        config.TOOL_WEBHOOK_SECRET,
      )
    )
      return c.json({ error: "Tool endpoint disabled or unauthorized" }, 401);
    const request = z
      .strictObject({
        call_id: z.string().uuid(),
        call_token: z.string(),
        input: z.unknown(),
      })
      .parse(await c.req.json());
    const data = c.get("data");
    const rows = await data.readMany(["Calls", "Phones"]);
    const call = rows.Calls.find((r) => r.call_id === request.call_id);
    if (
      !call ||
      !verifyCallToken(request.call_token, call, config.TOOL_WEBHOOK_SECRET)
    )
      return c.json({ error: "Invalid or expired call token" }, 403);
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
    const tools = createTools(ctx);
    if (!tools.names.includes(c.req.param("name")))
      return c.json({ error: "Unknown tool" }, 404);
    const output = await tools.invoke(c.req.param("name"), request.input);
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
      !equalSecret(
        c.req.header("authorization") ?? "",
        `Bearer ${config.CRON_SECRET}`,
      )
    )
      return c.json({ error: "Cron disabled or unauthorized" }, 401);
    return c.json(await refreshPrices(c.get("data"), config));
  });
  return app;
}
