import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import Stripe from "stripe";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/index.js";
import { invoiceMath, isPriceStale } from "../domain/pricing.js";
import { localParts } from "../domain/routing.js";
import { schemas } from "../domain/schemas.js";
import { refreshPrices } from "./prices.js";

type InvoiceOptions = { now?: Date; method?: "wire" | "card" };
export async function currentPricing(
  data: DataSource,
  config: Config,
  orderId: string,
  now: Date,
) {
  const snapshot = await data.readMany([
    "Orders",
    "Suppliers",
    "SupplierPrices",
    "PriceList",
    "PricingRules",
    "Customers",
  ]);
  const order = snapshot.Orders.find((r) => r.order_id === orderId);
  if (!order || order.status === "cancelled")
    throw new Error("Order unavailable");
  const supplier = snapshot.Suppliers.find(
    (s) => s.supplier_id === order.supplier_id,
  );
  if (!supplier) throw new Error("Supplier missing");
  const selectCost = (rows: typeof snapshot.SupplierPrices) =>
    rows
      .filter(
        (p) =>
          p.supplier_id === order.supplier_id &&
          p.depot_id === order.depot_id &&
          p.container_type === order.container_type &&
          new Date(p.observed_at) <= now,
      )
      .sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
  let cost = selectCost(snapshot.SupplierPrices);
  const stale = (observedAt: string) =>
    isPriceStale({
      observedAt,
      at: now,
      updateWeekday: supplier.update_weekday,
      updateTimeLocal: supplier.update_time_local,
      timezone: config.TIMEZONE,
    });
  if (!cost || stale(cost.observed_at)) {
    const refresh = await refreshPrices(data, config, {
      supplierId: supplier.supplier_id,
      now,
    });
    if (refresh.status !== "success")
      throw new Error("Stale supplier price: refresh failed; invoice refused");
    cost = selectCost(await data.read("SupplierPrices"));
  }
  if (!cost || stale(cost.observed_at))
    throw new Error(
      "Stale supplier price: snapshot still predates scheduled update; invoice refused",
    );
  const list = snapshot.PriceList.filter(
    (p) =>
      p.depot_id === order.depot_id &&
      p.container_type === order.container_type &&
      new Date(p.effective_from) <= now,
  ).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  if (!list) throw new Error("No effective list price");
  const customer = snapshot.Customers.find(
    (c) => c.customer_id === order.customer_id,
  );
  if (!customer) throw new Error("Customer missing");
  return {
    order,
    supplier,
    cost,
    list,
    customer,
    rules: snapshot.PricingRules.filter(
      (r) => r.customer_id === order.customer_id,
    ),
  };
}
async function calculate(
  data: DataSource,
  config: Config,
  orderId: string,
  options: InvoiceOptions,
) {
  const now = options.now ?? new Date();
  const pricing = await currentPricing(data, config, orderId, now);
  const math = invoiceMath({
    listCents: pricing.list.list_cents,
    costCents: pricing.cost.cost_cents,
    qty: pricing.order.qty,
    rules: pricing.rules,
    date: localParts(now, config.TIMEZONE).date,
    floorMarginCents: config.FLOOR_MARGIN_CENTS,
  });
  // Price rules own the amount. Orders retain negotiation history and do not override them.
  const payload = {
    order_id: orderId,
    customer: pricing.customer,
    supplier_id: pricing.supplier.supplier_id,
    depot_id: pricing.order.depot_id,
    container_type: pricing.order.container_type,
    ...math,
    price_observed_at: pricing.cost.observed_at,
    price_source: pricing.cost.source_ref,
    method: options.method ?? "wire",
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return { ...payload, fingerprint };
}
function matchesPreview(
  invoice: import("../domain/schemas.js").Row<"Invoices">,
  preview: Awaited<ReturnType<typeof calculate>>,
) {
  return (
    invoice.idempotency_key === `colos-${preview.fingerprint}` &&
    invoice.list_cents === preview.listCents &&
    invoice.discount_cents === preview.discountCents &&
    invoice.final_cents === preview.finalCents &&
    invoice.cost_cents === preview.costCents &&
    invoice.price_observed_at === preview.price_observed_at &&
    invoice.method === preview.method
  );
}
export async function previewInvoice(
  data: DataSource,
  config: Config,
  orderId: string,
  options: InvoiceOptions = {},
) {
  const preview = await calculate(data, config, orderId, options);
  const invoices = (await data.read("Invoices")).filter(
    (r) => r.order_id === orderId,
  );
  const existing = invoices.find(
    (r) =>
      r.idempotency_key === `colos-${preview.fingerprint}` &&
      r.status !== "void",
  );
  if (existing) {
    if (!matchesPreview(existing, preview))
      throw new Error("Stored invoice no longer matches its preview");
    const approval = (await data.read("Approvals")).find(
      (r) => r.approval_id === `APP-${existing.invoice_id}`,
    );
    if (!approval && existing.status === "preview")
      await data.upsert("Approvals", {
        approval_id: `APP-${existing.invoice_id}`,
        kind: "invoice",
        ref_id: existing.invoice_id,
        payload_json: JSON.stringify(preview),
        status: "pending",
        requested_at: (options.now ?? new Date()).toISOString(),
        decided_at: "",
      });
    return { ...preview, invoice: existing };
  }
  const version = Math.max(0, ...invoices.map((r) => r.version)) + 1;
  const invoice = schemas.Invoices.parse({
    invoice_id: `INV-${orderId}-${version}`,
    order_id: orderId,
    version,
    list_cents: preview.listCents,
    discount_cents: preview.discountCents,
    final_cents: preview.finalCents,
    cost_cents: preview.costCents,
    price_observed_at: preview.price_observed_at,
    method: preview.method,
    status: "preview",
    stripe_invoice_id: "",
    idempotency_key: `colos-${preview.fingerprint}`,
    approved_at: "",
  });
  await data.upsert("Invoices", invoice);
  await data.upsert("Approvals", {
    approval_id: `APP-${invoice.invoice_id}`,
    kind: "invoice",
    ref_id: invoice.invoice_id,
    payload_json: JSON.stringify(preview),
    status: "pending",
    requested_at: (options.now ?? new Date()).toISOString(),
    decided_at: "",
  });
  return { ...preview, invoice };
}
export async function approveInvoice(
  data: DataSource,
  config: Config,
  orderId: string,
  options: InvoiceOptions = {},
) {
  const candidates = (await data.read("Invoices"))
    .filter(
      (r) =>
        r.order_id === orderId &&
        (!options.method || r.method === options.method),
    )
    .sort((a, b) => b.version - a.version);
  const invoice = candidates[0];
  if (!invoice) throw new Error("Run invoice:preview before approving");
  if (invoice.status === "sent") return { invoice, already_sent: true };
  const preview = await calculate(data, config, orderId, {
    ...options,
    method: invoice.method,
  });
  if (!matchesPreview(invoice, preview))
    throw new Error(
      "Invoice changed since preview. Run invoice:preview and review it again.",
    );
  const approval = (await data.read("Approvals")).find(
    (r) => r.approval_id === `APP-${invoice.invoice_id}`,
  );
  if (
    !approval ||
    JSON.parse(approval.payload_json).fingerprint !== preview.fingerprint
  )
    throw new Error("Approval does not match invoice");
  const decidedAt = (options.now ?? new Date()).toISOString();
  await data.upsert(
    "Approvals",
    { ...approval, status: "approved", decided_at: decidedAt },
    approval,
  );
  const approved = {
    ...invoice,
    status: "approved" as const,
    approved_at: decidedAt,
  };
  await data.upsert("Invoices", approved, invoice);
  return { ...preview, invoice: approved };
}
async function writeWire(
  preview: Awaited<ReturnType<typeof calculate>>,
  invoiceId: string,
  config: Config,
) {
  if (!/^[A-Za-z0-9_-]+$/.test(invoiceId))
    throw new Error("Unsafe invoice file name");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile("fixtures/invoices/wire-template.xlsx");
  const sheet = workbook.getWorksheet("Invoice");
  if (!sheet) throw new Error("Wire template has no Invoice sheet");
  sheet.getCell("B3").value = invoiceId;
  sheet.getCell("B4").value = preview.customer.company;
  sheet.getCell("B5").value = preview.customer.email;
  sheet.getCell("B6").value = preview.order_id;
  sheet.getCell("B7").value = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: config.TIMEZONE,
  }).format(new Date(preview.price_observed_at));
  sheet.getCell("A10").value = preview.container_type;
  sheet.getCell("B10").value = preview.qty;
  sheet.getCell("C10").value = preview.listCents;
  sheet.getCell("D10").value = preview.discountCents;
  sheet.getCell("E10").value = preview.finalCents;
  sheet.getCell("F10").value = {
    formula: "B10*E10",
    result: preview.totalCents,
  };
  const directory = join(config.RUNTIME_DIR, "out");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${invoiceId}.xlsx`);
  await workbook.xlsx.writeFile(path);
  return path;
}
async function sendInvoiceUnlocked(
  data: DataSource,
  config: Config,
  orderId: string,
  options: InvoiceOptions = {},
) {
  let invoice = (await data.read("Invoices"))
    .filter(
      (r) =>
        r.order_id === orderId &&
        (!options.method || r.method === options.method),
    )
    .sort((a, b) => b.version - a.version)[0];
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status === "sent")
    return {
      invoice,
      already_sent: true,
      mode: invoice.method === "wire" ? "dry-run" : "test",
    };
  if (invoice.status !== "approved")
    throw new Error("Owner approval required before sending");
  const approval = (await data.read("Approvals")).find(
    (a) =>
      a.ref_id === invoice.invoice_id &&
      a.kind === "invoice" &&
      a.status === "approved",
  );
  const preview = await calculate(data, config, orderId, {
    ...options,
    method: invoice.method,
  });
  if (
    !approval ||
    !matchesPreview(invoice, preview) ||
    JSON.parse(approval.payload_json).fingerprint !== preview.fingerprint
  )
    throw new Error(
      "Invoice changed after approval. Preview and approve again.",
    );
  let stripeId = invoice.stripe_invoice_id;
  let path: string | null = null;
  if (invoice.method === "card") {
    if (!config.STRIPE_SECRET_KEY)
      return {
        invoice,
        mode: "dry-run",
        detail: "Stripe is not configured; no invoice created or sent.",
      };
    if (!config.STRIPE_SECRET_KEY.startsWith("sk_test_"))
      throw new Error("Only Stripe test keys are allowed");
    const stripe = new Stripe(config.STRIPE_SECRET_KEY);
    const key = invoice.idempotency_key;
    let draft: Awaited<ReturnType<typeof stripe.invoices.retrieve>>;
    if (stripeId) {
      draft = await stripe.invoices.retrieve(stripeId);
      if (draft.metadata?.colos_invoice_id !== invoice.invoice_id)
        throw new Error("Stripe invoice identity mismatch");
    } else {
      const customer = await stripe.customers.create(
        {
          email: preview.customer.email,
          name: preview.customer.company,
          metadata: { colos_customer_id: preview.customer.customer_id },
        },
        { idempotencyKey: `${key}-customer` },
      );
      draft = await stripe.invoices.create(
        {
          customer: customer.id,
          collection_method: "send_invoice",
          days_until_due: 7,
          auto_advance: false,
          metadata: { colos_invoice_id: invoice.invoice_id },
        },
        { idempotencyKey: `${key}-invoice` },
      );
      stripeId = draft.id;
      const saved = { ...invoice, stripe_invoice_id: stripeId };
      await data.upsert("Invoices", saved, invoice);
      invoice = saved;
    }
    const customerId =
      typeof draft.customer === "string" ? draft.customer : draft.customer?.id;
    if (!customerId || draft.livemode)
      throw new Error("Expected a Stripe test invoice with a customer");
    if (draft.status === "draft") {
      const items = await stripe.invoiceItems.list({
        invoice: draft.id,
        limit: 100,
      });
      if (items.has_more || items.data.length > 1)
        throw new Error("Unexpected Stripe invoice items");
      if (items.data.length === 0) {
        await stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: draft.id,
            amount: preview.totalCents,
            currency: "usd",
            description: `${preview.qty} x ${preview.container_type}, order ${orderId}`,
            metadata: { colos_invoice_id: invoice.invoice_id },
          },
          { idempotencyKey: `${key}-item` },
        );
      } else if (
        items.data[0]?.amount !== preview.totalCents ||
        items.data[0]?.currency !== "usd" ||
        items.data[0]?.metadata?.colos_invoice_id !== invoice.invoice_id
      ) {
        throw new Error("Stripe invoice item differs from approved preview");
      }
      draft = await stripe.invoices.finalizeInvoice(
        draft.id,
        {},
        { idempotencyKey: `${key}-finalize` },
      );
    }
    if (draft.total !== preview.totalCents || draft.currency !== "usd")
      throw new Error("Stripe invoice total differs from approved preview");
    if (draft.status === "open")
      await stripe.invoices.sendInvoice(
        draft.id,
        {},
        { idempotencyKey: `${key}-send` },
      );
    else if (draft.status !== "paid")
      throw new Error(
        `Stripe invoice cannot be sent in status ${draft.status}`,
      );
    stripeId = draft.id;
  } else {
    path = await writeWire(preview, invoice.invoice_id, config);
  }
  const sent = {
    ...invoice,
    status: "sent" as const,
    stripe_invoice_id: stripeId,
  };
  const existingMessage = (await data.read("Outbox")).find(
    (row) => row.message_id === `SEND-${invoice.invoice_id}`,
  );
  await data.upsert(
    "Outbox",
    {
      message_id: `SEND-${invoice.invoice_id}`,
      channel: "email",
      to: preview.customer.email,
      subject: `Invoice ${invoice.invoice_id}`,
      body: path
        ? `Wire invoice prepared: ${path}. Dry-run: email delivery is not configured. No bank details are supplied in this synthetic rebuild.`
        : `Stripe test invoice ${stripeId} issued.`,
      status: path ? "pending" : "sent",
      created_at:
        existingMessage?.created_at ??
        (options.now ?? new Date()).toISOString(),
    },
    existingMessage,
  );
  await data.upsert("Invoices", sent, invoice);
  return { invoice: sent, path, mode: path ? "dry-run" : "test" };
}

// Serialize local calls sharing a source. Sheets still requires a single billing worker.
const sends = new WeakMap<DataSource, Map<string, Promise<unknown>>>();
export async function sendInvoice(
  data: DataSource,
  config: Config,
  orderId: string,
  options: InvoiceOptions = {},
) {
  let queue = sends.get(data);
  if (!queue) {
    queue = new Map();
    sends.set(data, queue);
  }
  const previous = queue.get(orderId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => sendInvoiceUnlocked(data, config, orderId, options));
  queue.set(orderId, next);
  try {
    return await next;
  } finally {
    if (queue.get(orderId) === next) queue.delete(orderId);
  }
}
