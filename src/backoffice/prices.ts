import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load } from "cheerio";
import { z } from "zod";
import { reviewPriceChanges } from "../agents/price-reviewer.js";
import type { Config } from "../config/index.js";
import type { DataSource } from "../data/index.js";
import { schemas } from "../domain/schemas.js";

const parsedPageSchema = z.object({
  observed_at: z.iso.datetime(),
  prices: z
    .array(
      z.object({
        depot_id: z.string().min(1),
        container_type: z.string().min(1),
        cost_cents: z.number().int().positive(),
      }),
    )
    .min(1),
});
export function parseSupplierPage(html: string) {
  const $ = load(html);
  const table = $("table[data-supplier-prices]");
  if (
    table.length !== 1 ||
    table
      .find("thead th")
      .map((_, el) => $(el).text().trim())
      .get()
      .join("|") !== "Depot|Container|Cost cents"
  )
    throw new Error(
      "Supplier layout changed: expected price table and headers",
    );
  const parsed = parsedPageSchema.parse({
    observed_at: table.attr("data-observed-at"),
    prices: table
      .find("tbody tr")
      .map((_, el) => {
        const cells = $(el)
          .find("td")
          .map((_, cell) => $(cell).text().trim())
          .get();
        if (cells.length !== 3 || !/^\d+$/.test(cells[2] ?? ""))
          throw new Error("Malformed supplier price row");
        return {
          depot_id: cells[0],
          container_type: cells[1],
          cost_cents: Number(cells[2]),
        };
      })
      .get(),
  });
  const ids = parsed.prices.map((p) => `${p.depot_id}|${p.container_type}`);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate supplier product");
  return parsed;
}
export async function refreshPrices(
  data: DataSource,
  config: Config,
  options: {
    supplierId?: string;
    now?: Date;
    week?: 1 | 2;
    sourceOverride?: string;
  } = {},
) {
  const now = options.now ?? new Date();
  const runId = randomUUID();
  const run = schemas.JobRuns.parse({
    run_id: runId,
    job: "prices",
    started_at: now.toISOString(),
    finished_at: "",
    status: "running",
    detail: "",
  });
  await data.upsert("JobRuns", run);
  const snapshot = await data.readMany([
    "Suppliers",
    "SupplierPrices",
    "Depots",
  ]);
  const suppliers = snapshot.Suppliers.filter(
    (s) => !options.supplierId || s.supplier_id === options.supplierId,
  );
  const results: {
    supplier_id: string;
    appended: number;
    error?: string;
    mode?: string;
  }[] = [];
  if (!suppliers.length) {
    const detail = "Supplier not found";
    await data.upsert(
      "JobRuns",
      {
        ...run,
        status: "failed",
        finished_at: new Date().toISOString(),
        detail,
      },
      run,
    );
    await data.upsert("Outbox", {
      message_id: randomUUID(),
      channel: "alert",
      to: config.OWNER_PHONE ?? "owner",
      subject: "Price refresh failed",
      body: detail,
      status: "pending",
      created_at: now.toISOString(),
    });
    return {
      status: "failed" as const,
      results: [
        { supplier_id: options.supplierId ?? "", appended: 0, error: detail },
      ],
    };
  }
  for (const supplier of suppliers) {
    let appended = 0;
    try {
      const source =
        options.sourceOverride ??
        (options.week
          ? supplier.source.replace(/week[12]/, `week${options.week}`)
          : supplier.source);
      if (!source.startsWith("fixtures/suppliers/") || source.includes(".."))
        throw new Error("Only bundled synthetic supplier pages are supported");
      const page = parseSupplierPage(await readFile(source, "utf8"));
      if (new Date(page.observed_at) > now)
        throw new Error("Supplier snapshot is from the future");
      if (
        page.prices.some(
          (p) => !snapshot.Depots.some((d) => d.depot_id === p.depot_id),
        )
      )
        throw new Error("Unknown depot on supplier page");
      const changes = page.prices.map((p) => ({
        ...p,
        next_cents: p.cost_cents,
        previous_cents:
          snapshot.SupplierPrices.filter(
            (old) =>
              old.supplier_id === supplier.supplier_id &&
              old.depot_id === p.depot_id &&
              old.container_type === p.container_type,
          ).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0]
            ?.cost_cents ?? null,
      }));
      const review = await reviewPriceChanges(config, changes);
      if (review.needs_review) {
        await data.upsert("Approvals", {
          approval_id: randomUUID(),
          kind: "price_change",
          ref_id: supplier.supplier_id,
          payload_json: JSON.stringify({ source, changes, review }),
          status: "pending",
          requested_at: now.toISOString(),
          decided_at: "",
        });
        throw new Error(`Price change needs review: ${review.reason}`);
      }
      for (const p of page.prices) {
        const latest = snapshot.SupplierPrices.filter(
          (old) =>
            old.supplier_id === supplier.supplier_id &&
            old.depot_id === p.depot_id &&
            old.container_type === p.container_type,
        ).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
        if (latest && latest.observed_at >= page.observed_at) continue;
        await data.append("SupplierPrices", {
          ...p,
          supplier_id: supplier.supplier_id,
          observed_at: page.observed_at,
          source_ref: source,
        });
        appended++;
      }
      results.push({
        supplier_id: supplier.supplier_id,
        appended,
        mode: review.mode,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await data.upsert("Outbox", {
        message_id: randomUUID(),
        channel: "alert",
        to: config.OWNER_PHONE ?? "owner",
        subject: `Price refresh failed: ${supplier.name}`,
        body: message,
        status: "pending",
        created_at: now.toISOString(),
      });
      results.push({
        supplier_id: supplier.supplier_id,
        appended,
        error: message,
      });
    }
  }
  const status = results.some((r) => r.error) ? "failed" : "success";
  await data.upsert(
    "JobRuns",
    {
      ...run,
      status,
      finished_at: new Date().toISOString(),
      detail: JSON.stringify(results),
    },
    run,
  );
  return { status, results };
}
