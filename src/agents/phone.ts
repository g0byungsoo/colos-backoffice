import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { Agent, AgentsError, Runner } from "@openai/agents";
import { z } from "zod";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/interface.js";
import { RequestDataSource } from "../data/sheets.js";
import { type Reason, reasons, routeCall } from "../domain/routing.js";
import {
  allowedMoney,
  inputGuardrail,
  outputGuardrail,
  unsafeInput,
} from "./guardrails.js";
import { type CallContext, createTools, type ToolCall } from "./tools.js";
import { captureUsage } from "./usage.js";
export type TurnResult = {
  text: string;
  toolCalls: ToolCall[];
  retrievedIds: string[];
  handoff: boolean;
  reason: Reason;
  tokenUsage: { input: number; output: number };
  ms: number;
};
function offlineIntent(text: string): Reason {
  if (/late|wrong invoice|problem|damaged|upset|complaint/i.test(text))
    return "existing_order_problem";
  if (/offer|pay you|lowball|discount on|negotiate/i.test(text))
    return "negotiation";
  if (/confirm.*pickup|pickup.*confirm/i.test(text))
    return "pickup_confirmation";
  if (/ready|status|my order/i.test(text)) return "pickup_status";
  if (/price|cost|how much/i.test(text)) return "pricing";
  if (/stock|available|availability/i.test(text)) return "availability";
  if (
    /policy|payment|wire|card|pickup|release|hours|grade|delivery|damage|hold|cancel|notes|note|terms|cargo worthy|watertight|contacted|driver|gate/i.test(
      text,
    )
  )
    return "policy";
  if (/weather|joke|football|politics/i.test(text)) return "off_topic";
  return "not_sure";
}
export async function createConversation(options: {
  data: DataSource;
  config: Config;
  from: string;
  at: Date | string;
  offline?: boolean;
  onTool?: (call: ToolCall) => void;
}) {
  const { from } = options;
  const offline = options.offline ?? !options.config.OPENAI_API_KEY;
  const config = offline
    ? { ...options.config, OPENAI_API_KEY: undefined }
    : options.config;
  const data = new RequestDataSource(options.data);
  const runner = new Runner({ tracingDisabled: true });
  const at = new Date(options.at);
  if (Number.isNaN(at.getTime())) throw new Error("Invalid call time");
  const rows = await data.readMany(["Phones", "Customers", "Issues"]);
  const party = rows.Phones.find((p) => p.phone_e164 === from);
  const customer =
    party?.party_type === "customer"
      ? rows.Customers.find((c) => c.customer_id === party.party_id)
      : undefined;
  const route = routeCall({
    phone: party,
    customer,
    issues: rows.Issues,
    at,
    timezone: config.TIMEZONE,
    businessHours: config.BUSINESS_HOURS,
  });
  const ctx: CallContext = {
    data,
    config,
    from,
    at,
    customerId: customer?.customer_id,
    party,
    allowed: new Set(),
    toolCalls: [],
    retrievedIds: [],
    handoff: false,
    offline,
    callId: randomUUID(),
    onTool: options.onTool,
  };
  const tools = createTools(ctx);
  const history: { role: string; text: string }[] = [];
  let verifiedOrder: string | undefined;
  let lastReason: Reason = "not_sure";
  let lastText = "";
  const prompts = {
    phone: await readFile("prompts/phone.md", "utf8"),
    intent: await readFile("prompts/intent.md", "utf8"),
  };
  async function persist() {
    const previous = (await data.read("Calls")).find(
      (r) => r.call_id === ctx.callId,
    );
    await data.upsert(
      "Calls",
      {
        call_id: ctx.callId,
        from_e164: from,
        route: route.route,
        reason: lastReason === "not_sure" ? route.reason : lastReason,
        summary: lastText.slice(0, 500),
        outcome: ctx.handoff
          ? "handoff"
          : route.route === "person"
            ? "owner_route"
            : "answered",
        started_at: at.toISOString(),
        state_json: JSON.stringify({
          customerId: ctx.customerId,
          allowed: [...ctx.allowed],
        }),
      },
      previous,
    );
  }
  if (route.route === "message")
    await tools.invoke("handoff", { reason: route.reason });
  await persist();
  await appendLog({ event: "route", route, toolCalls: ctx.toolCalls });
  async function turn(text: string): Promise<TurnResult> {
    data.clearCache();
    const start = performance.now();
    ctx.toolCalls = [];
    ctx.retrievedIds = [];
    const tokens = { input: 0, output: 0 };
    let reply = "";
    const addUsage = (
      responses: { usage: { inputTokens: number; outputTokens: number } }[],
    ) => {
      for (const r of responses) {
        tokens.input += r.usage.inputTokens;
        tokens.output += r.usage.outputTokens;
      }
    };
    try {
      if (unsafeInput(text)) {
        reply = /\b(fuck|idiot|kill yourself)\b/i.test(text)
          ? "I can help with container questions. Please keep the conversation respectful."
          : "I cannot follow those instructions. I can help with container questions.";
        lastReason = "off_topic";
      } else if (route.route === "person") {
        ctx.handoff = true;
        reply = `Connecting you to the owner. ${route.reason}`;
        lastReason = "existing_order_problem";
      } else {
        if (ctx.offline) lastReason = offlineIntent(text);
        else {
          const classified = await runner.run(
            new Agent({
              name: "Call reason",
              model: config.OPENAI_MODEL,
              modelSettings: config.OPENAI_MODEL.startsWith("gpt-5")
                ? { reasoning: { effort: "low" } }
                : {},
              instructions: prompts.intent,
              outputType: z.object({ reason: z.enum(reasons) }),
              inputGuardrails: [
                {
                  ...inputGuardrail,
                  execute: async () => ({
                    tripwireTriggered: unsafeInput(text),
                    outputInfo: "Current caller message checked.",
                  }),
                },
              ],
            }),
            JSON.stringify({
              caller_type: party?.party_type ?? "unknown",
              verified_customer_id: ctx.customerId ?? null,
              message: text,
            }),
            { maxTurns: 2 },
          );
          lastReason = classified.finalOutput?.reason ?? "not_sure";
          addUsage(classified.rawResponses);
        }
        if (
          route.route === "message" ||
          lastReason === "existing_order_problem"
        )
          reply = (await tools.invoke("handoff", { reason: text })).message;
        else if (ctx.offline) {
          const order =
            text.match(/\bO\d{3}\b/i)?.[0].toUpperCase() ?? verifiedOrder;
          if (order && !ctx.customerId) {
            const customers = await data.read("Customers");
            const company = customers.find((c) =>
              text.toLowerCase().includes(c.company.toLowerCase()),
            );
            if (company) {
              const verified = await tools.invoke("verify_identity", {
                order_id: order,
                company: company.company,
              });
              if (verified.ok) verifiedOrder = order;
            }
          }
          const depot = text.match(/\bD\d{2}\b/i)?.[0].toUpperCase();
          const type = text.match(/\b(?:20|40)(?:HC|GP)\b/i)?.[0].toUpperCase();
          if (ctx.handoff)
            reply =
              "A person will review your message. I cannot promise a resolution time.";
          else if (lastReason === "availability")
            reply = (
              await tools.invoke("availability", {
                container_type: type ?? null,
                depot_id: depot ?? null,
              })
            ).message;
          else if (lastReason === "pricing")
            reply =
              depot && type
                ? (
                    await tools.invoke("pricing", {
                      depot_id: depot,
                      container_type: type,
                    })
                  ).message
                : "Which depot and container type do you need?";
          else if (lastReason === "pickup_status")
            reply =
              order && ctx.customerId
                ? (await tools.invoke("pickup_status", { order_id: order }))
                    .message
                : "What is your order number and company name?";
          else if (lastReason === "pickup_confirmation")
            reply = order
              ? (
                  await tools.invoke("pickup_confirmation", {
                    order_id: order,
                    message: text,
                  })
                ).message
              : "What order is this pickup for?";
          else if (lastReason === "negotiation") {
            const amount = text.match(/\$([\d,]+(?:\.\d{1,2})?)/);
            reply =
              order && amount
                ? (
                    await tools.invoke("negotiate_offer", {
                      order_id: order,
                      offer_cents: Math.round(
                        Number(amount[1].replaceAll(",", "")) * 100,
                      ),
                    })
                  ).message
                : "Please give your order number, company and offer.";
          } else if (lastReason === "policy") {
            const found = await tools.invoke("search", { query: text });
            const hits = found.data as { text: string; source_id: string }[];
            reply = hits.length
              ? `${hits[0].text} [${hits[0].source_id}]`
              : "I could not find a current policy for that question.";
          } else
            reply =
              lastReason === "off_topic"
                ? "I can help with shipping containers."
                : "What can I help you with: stock, pickup, pricing or an existing order?";
        } else {
          const agent = new Agent({
            name: "Colos phone",
            model: config.OPENAI_MODEL,
            modelSettings: config.OPENAI_MODEL.startsWith("gpt-5")
              ? { reasoning: { effort: "low" } }
              : {},
            instructions: `${prompts.phone}\nCaller context: ${JSON.stringify({ company: customer?.company, verified_customer_id: ctx.customerId, party_type: party?.party_type, reason: lastReason })}`,
            tools: tools.sdkTools,
            inputGuardrails: [
              {
                ...inputGuardrail,
                execute: async () => ({
                  tripwireTriggered: unsafeInput(text),
                  outputInfo: "Current caller message checked.",
                }),
              },
            ],
            outputGuardrails: [
              outputGuardrail(
                ctx.allowed,
                lastReason === "pricing" || lastReason === "negotiation",
              ),
            ],
          });
          try {
            const answer = await runner.run(
              agent,
              JSON.stringify([...history, { role: "user", text }]),
              { maxTurns: 10 },
            );
            reply = String(
              answer.finalOutput ?? "I could not complete that request.",
            );
            addUsage(answer.rawResponses);
          } catch (error) {
            reply =
              "I could not safely answer. Please ask the owner to confirm.";
            if (error instanceof AgentsError && error.state) {
              tokens.input += error.state.usage.inputTokens;
              tokens.output += error.state.usage.outputTokens;
            }
            await appendLog({
              error: error instanceof Error ? error.name : "AgentError",
            });
          }
        }
      }
    } catch (error) {
      if (error instanceof AgentsError && error.state) {
        tokens.input += error.state.usage.inputTokens;
        tokens.output += error.state.usage.outputTokens;
      }
      reply = "I could not safely answer. Please ask the owner to confirm.";
      await appendLog({
        error: error instanceof Error ? error.name : "AgentError",
        toolCalls: ctx.toolCalls,
        retrievedIds: ctx.retrievedIds,
      });
    }
    const committed = [...ctx.toolCalls]
      .reverse()
      .find(
        (call) =>
          (call.name === "negotiate_offer" ||
            call.name === "pickup_confirmation") &&
          (call.output as { ok?: boolean }).ok,
      );
    if (committed) reply = (committed.output as { message: string }).message;
    if (ctx.handoff && route.route !== "person") {
      const handoff = [...ctx.toolCalls]
        .reverse()
        .find((call) => call.name === "handoff");
      if (handoff) reply = (handoff.output as { message: string }).message;
    }
    if (
      !allowedMoney(
        reply,
        ctx.allowed,
        lastReason === "pricing" || lastReason === "negotiation",
      )
    )
      reply = "I need a current pricing lookup before quoting an amount.";
    history.push({ role: "user", text }, { role: "assistant", text: reply });
    lastText = reply;
    const result: TurnResult = {
      text: reply,
      toolCalls: [...ctx.toolCalls],
      retrievedIds: [...ctx.retrievedIds],
      handoff: ctx.handoff,
      reason: lastReason,
      tokenUsage: tokens,
      ms: performance.now() - start,
    };
    await persist();
    await appendLog({ input: text, ...result });
    return result;
  }
  async function appendLog(value: unknown) {
    await mkdir(`${config.RUNTIME_DIR}/.logs`, { recursive: true });
    await appendFile(
      `${config.RUNTIME_DIR}/.logs/${ctx.callId}.jsonl`,
      `${JSON.stringify({ at: at.toISOString(), mode: ctx.offline ? "offline" : "live", ...(value as object) })}\n`,
    );
  }
  async function measuredTurn(text: string) {
    const { value, usage } = await captureUsage(() => turn(text));
    value.tokenUsage.input += usage.input;
    value.tokenUsage.output += usage.output;
    await appendLog({ event: "turn_usage", tokenUsage: value.tokenUsage });
    return value;
  }
  return { route, turn: measuredTurn, finish: persist, context: ctx, tools };
}
