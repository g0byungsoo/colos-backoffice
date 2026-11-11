import { randomUUID } from "node:crypto";
import { z } from "zod";
import { draftNegotiation, suspiciousEmail } from "../agents/negotiator.js";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/index.js";
import { decideOffer } from "../domain/pricing.js";
import { currentPricing } from "./invoices.js";

export const offerSchema = z.object({
  order_id: z.string().min(1),
  offer_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  email: z.string(),
});
// A small explicit envelope keeps model-generated numbers outside the money path.
export function parseOfferEmail(email: string) {
  if (
    [...email.matchAll(/^Order:/gim)].length !== 1 ||
    [...email.matchAll(/^Offer(?:-Cents)?:/gim)].length !== 1
  ) {
    throw new Error(
      "Provide exactly one Order and one Offer or Offer-Cents header",
    );
  }
  const order = /^Order:\s*([A-Za-z0-9_-]+)\s*$/im.exec(email)?.[1];
  const cents = /^Offer-Cents:\s*(\d+)\s*$/im.exec(email)?.[1];
  const dollars = /^Offer:\s*\$(\d+)(?:\.(\d{2}))?\s*$/im.exec(email);
  const offer = cents
    ? Number(cents)
    : dollars
      ? Number(dollars[1]) * 100 + Number(dollars[2] ?? 0)
      : undefined;
  return offerSchema.parse({ order_id: order, offer_cents: offer, email });
}
export async function negotiate(
  data: DataSource,
  config: Config,
  email: string,
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const offer = parseOfferEmail(email);
  const pricing = await currentPricing(data, config, offer.order_id, now);
  const decision = decideOffer({
    offerCents: offer.offer_cents,
    listCents: pricing.list.list_cents,
    costCents: pricing.cost.cost_cents,
    floorMarginCents: config.FLOOR_MARGIN_CENTS,
  });
  const generated = await draftNegotiation(config, decision, email);
  const customer = (await data.read("Customers")).find(
    (c) => c.customer_id === pricing.order.customer_id,
  );
  if (!customer) throw new Error("Order customer not found");
  const messageId = randomUUID();
  await data.upsert("Outbox", {
    message_id: messageId,
    channel: "email",
    to: customer.email,
    subject: `Offer for ${offer.order_id}: ${decision}`,
    body: generated.draft,
    status: "draft",
    created_at: now.toISOString(),
  });
  let approvalId: string | null = null;
  if (decision === "needs_approval") {
    approvalId = randomUUID();
    await data.upsert("Approvals", {
      approval_id: approvalId,
      kind: "discount",
      ref_id: offer.order_id,
      payload_json: JSON.stringify({
        offer_cents: offer.offer_cents,
        list_cents: pricing.list.list_cents,
        cost_cents: pricing.cost.cost_cents,
        price_observed_at: pricing.cost.observed_at,
        message_id: messageId,
      }),
      status: "pending",
      requested_at: now.toISOString(),
      decided_at: "",
    });
  }
  return {
    decision,
    ...generated,
    offer_cents: offer.offer_cents,
    cost_cents: pricing.cost.cost_cents,
    floor_cents: pricing.cost.cost_cents + config.FLOOR_MARGIN_CENTS,
    approval_id: approvalId,
    message_id: messageId,
    input_flagged: suspiciousEmail(email),
  };
}
