import { z } from "zod";

export const toolInputs = {
  verify_identity: z.object({ order_id: z.string(), company: z.string() }),
  availability: z.object({
    container_type: z.string().nullable(),
    depot_id: z.string().nullable(),
  }),
  pickup_status: z.object({ order_id: z.string() }),
  pricing: z.object({ depot_id: z.string(), container_type: z.string() }),
  search: z.object({ query: z.string() }),
  handoff: z.object({ reason: z.string() }),
  pickup_confirmation: z.object({ order_id: z.string(), message: z.string() }),
  negotiate_offer: z.object({
    order_id: z.string(),
    offer_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
} as const;
export type ToolName = keyof typeof toolInputs;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolInputs)[N]>;
