import { z } from "zod";

export const cents = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? Number.NaN : value,
  z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
);
const id = z.string().min(1);
const utc = z.string().datetime({ offset: false });
const maybeUtc = z.union([utc, z.literal("")]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string();
export const schemas = {
  Customers: z.object({
    customer_id: id,
    company: id,
    contact_name: id,
    email: z.email(),
    created_at: utc,
  }),
  Phones: z.object({
    phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
    party_type: z.enum(["customer", "depot", "supplier"]),
    party_id: id,
    label: text,
  }),
  Depots: z.object({ depot_id: id, name: id, city: id, hours: id }),
  Suppliers: z.object({
    supplier_id: id,
    name: id,
    update_weekday: z.coerce.number().int().min(0).max(6),
    update_time_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    source: id,
  }),
  SupplierPrices: z.object({
    supplier_id: id,
    depot_id: id,
    container_type: id,
    cost_cents: cents,
    observed_at: utc,
    source_ref: id,
  }),
  PriceList: z.object({
    depot_id: id,
    container_type: id,
    list_cents: cents,
    effective_from: utc,
  }),
  Inventory: z.object({
    container_id: id,
    container_type: id,
    grade: z.enum(["new", "cargo_worthy", "wind_watertight"]),
    depot_id: id,
    supplier_id: id,
    status: z.enum(["available", "held", "sold", "picked_up"]),
    ready_for_pickup_at: maybeUtc,
  }),
  Orders: z.object({
    order_id: id,
    customer_id: id,
    supplier_id: id,
    depot_id: id,
    container_type: id,
    qty: z.coerce.number().int().positive(),
    agreed_unit_cents: cents,
    status: z.enum(["open", "confirmed", "ready", "delivered", "cancelled"]),
    created_at: utc,
  }),
  Issues: z.object({
    issue_id: id,
    customer_id: id,
    order_id: id,
    kind: z.enum(["late_delivery", "invoice", "damage", "other"]),
    status: z.enum(["open", "closed"]),
    summary: id,
    opened_at: utc,
  }),
  PricingRules: z
    .object({
      customer_id: id,
      kind: z.enum(["percent", "fixed"]),
      amount: cents,
      starts_on: date,
      ends_on: z.union([date, z.literal("")]),
    })
    .refine((r) => r.kind !== "percent" || r.amount <= 100, {
      message: "Percent discount must be between 0 and 100",
    }),
  Invoices: z.object({
    invoice_id: id,
    order_id: id,
    version: z.coerce.number().int().positive(),
    list_cents: cents,
    discount_cents: cents,
    final_cents: cents,
    cost_cents: cents,
    price_observed_at: utc,
    method: z.enum(["wire", "card"]),
    status: z.enum(["preview", "approved", "sent", "void"]),
    stripe_invoice_id: text,
    idempotency_key: id,
    approved_at: maybeUtc,
  }),
  Approvals: z.object({
    approval_id: id,
    kind: z.enum(["discount", "invoice", "price_change"]),
    ref_id: id,
    payload_json: z.string().refine((s) => {
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    }, "Must be JSON"),
    status: z.enum(["pending", "approved", "rejected"]),
    requested_at: utc,
    decided_at: maybeUtc,
  }),
  Outbox: z.object({
    message_id: id,
    channel: z.enum(["email", "sms", "callback", "alert"]),
    to: id,
    subject: text,
    body: text,
    status: z.enum(["draft", "pending", "sent", "failed"]),
    created_at: utc,
  }),
  Knowledge: z.object({
    doc_id: id,
    title: id,
    body_markdown: id,
    status: z.enum(["current", "superseded"]),
    updated_at: utc,
  }),
  Notes: z.object({
    note_id: id,
    customer_id: id,
    author: id,
    created_at: utc,
    text: id,
  }),
  Calls: z.object({
    call_id: id,
    from_e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
    route: z.enum(["person", "agent", "message"]),
    reason: text,
    summary: text,
    outcome: text,
    started_at: utc,
    state_json: z.string().default("{}"),
  }),
  JobRuns: z.object({
    run_id: id,
    job: id,
    started_at: utc,
    finished_at: maybeUtc,
    status: z.enum(["running", "success", "failed"]),
    detail: text,
  }),
} as const;
export type TableName = keyof typeof schemas;
export type Row<T extends TableName> = z.infer<(typeof schemas)[T]>;
export type Tables = { [K in TableName]: Row<K>[] };
export const tableNames = Object.keys(schemas) as TableName[];
export const headers: Record<TableName, string[]> = Object.fromEntries(
  tableNames.map((name) => [name, Object.keys(schemas[name].shape)]),
) as Record<TableName, string[]>;
export function parseRow<T extends TableName>(
  table: T,
  value: unknown,
): Row<T> {
  return schemas[table].parse(value) as Row<T>;
}
export function rowKey<T extends TableName>(table: T, row: Row<T>): string {
  const value = row as Record<string, unknown>;
  const keys =
    table === "SupplierPrices"
      ? [
          "supplier_id",
          "depot_id",
          "container_type",
          "observed_at",
          "source_ref",
        ]
      : table === "PriceList"
        ? ["depot_id", "container_type", "effective_from"]
        : table === "PricingRules"
          ? ["customer_id", "kind", "starts_on"]
          : [headers[table][0]];
  return keys.map((k) => String(value[k as string])).join("|");
}
