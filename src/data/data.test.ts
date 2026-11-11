import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tableNames } from "../domain/schemas.js";
import { ConflictError } from "./interface.js";
import { LocalDataSource } from "./local.js";
import { seed } from "./seed.js";
import { RequestDataSource, withBackoff } from "./sheets.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("local source", () => {
  it("validates all fixture rows and expected sizes", async () => {
    const db = new LocalDataSource({ persist: false });
    const rows = await db.readMany(tableNames);
    expect(rows.Customers).toHaveLength(30);
    expect(rows.Depots).toHaveLength(4);
    expect(rows.Suppliers).toHaveLength(5);
    expect(rows.Inventory).toHaveLength(60);
    expect(rows.Knowledge).toHaveLength(12);
    expect(rows.Notes).toHaveLength(150);
  });
  it("isolates reads and rejects a stale update after a human edit", async () => {
    const db = new LocalDataSource({ persist: false });
    const old = (await db.read("Customers"))[0];
    if (!old) throw new Error("No seed");
    await db.upsert("Customers", { ...old, contact_name: "Changed" }, old);
    await expect(
      db.upsert("Customers", { ...old, contact_name: "Overwritten" }, old),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await db.read("Customers"))[0]?.contact_name).toBe("Changed");
  });
  it("refuses blind overwrites and price updates", async () => {
    const db = new LocalDataSource({ persist: false });
    const old = (await db.read("Customers"))[0];
    const price = (await db.read("SupplierPrices"))[0];
    if (!old || !price) throw new Error("No seed");
    await expect(db.upsert("Customers", old)).rejects.toThrow("Concurrent");
    await expect(db.upsert("SupplierPrices", price, price)).rejects.toThrow(
      "append-only",
    );
    await expect(db.append("SupplierPrices", price)).rejects.toThrow(
      "Duplicate",
    );
  });
  it("persists writes between CLI invocations and refuses reseeding data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "colos-"));
    dirs.push(directory);
    const db = new LocalDataSource({ directory });
    await seed(db);
    await expect(seed(db)).rejects.toThrow("already contains data");
    const customer = (await db.read("Customers"))[0];
    if (!customer) throw new Error("No seed");
    await db.upsert(
      "Customers",
      { ...customer, contact_name: "Persistent" },
      customer,
    );
    expect(
      (await new LocalDataSource({ directory }).read("Customers"))[0]
        ?.contact_name,
    ).toBe("Persistent");
    await seed(db, true);
    expect((await db.read("Customers"))[0]?.contact_name).not.toBe(
      "Persistent",
    );
  });
  it("serializes separate local adapters before checking stale expected rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "colos-concurrent-"));
    dirs.push(directory);
    const first = new LocalDataSource({ directory });
    const second = new LocalDataSource({ directory });
    const old = (await first.read("Customers"))[0];
    const attempts = await Promise.allSettled([
      first.upsert("Customers", { ...old, contact_name: "First writer" }, old),
      second.upsert(
        "Customers",
        { ...old, contact_name: "Second writer" },
        old,
      ),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
      ConflictError,
    );
    expect((await first.read("Customers"))[0].contact_name).toBe(
      "First writer",
    );
  });
  it("batches cache misses and invalidates writes", async () => {
    const db = new LocalDataSource({ persist: false }),
      request = new RequestDataSource(db);
    const spy = vi.spyOn(db, "readMany");
    await request.readMany(["Customers", "Orders"]);
    await request.readMany(["Customers", "Orders"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const customer = (await request.read("Customers"))[0];
    if (!customer) throw new Error("No seed");
    await request.upsert(
      "Customers",
      { ...customer, contact_name: "New" },
      customer,
    );
    expect((await request.read("Customers"))[0]?.contact_name).toBe("New");
  });
  it("backs off on rate limiting and does not retry unrelated errors", async () => {
    const action = vi
        .fn()
        .mockRejectedValueOnce({ code: 429 })
        .mockRejectedValueOnce({ response: { status: 429 } })
        .mockResolvedValue("ok"),
      sleep = vi.fn().mockResolvedValue(undefined);
    expect(await withBackoff(action, sleep)).toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]?.[0]).toBeGreaterThanOrEqual(2000);
    const failure = vi.fn().mockRejectedValue(new Error("bad"));
    await expect(withBackoff(failure, sleep)).rejects.toThrow("bad");
    expect(failure).toHaveBeenCalledTimes(1);
  });
});

describe("Sheets optimistic writes", () => {
  it("preserves physical row numbers when a user cleared a preceding row", async () => {
    const { SheetsDataSource } = await import("./sheets.js");
    const { headers } = await import("../domain/schemas.js");
    const customer = (
      await new LocalDataSource({ persist: false }).read("Customers")
    )[0];
    if (!customer) throw new Error("Missing seed");
    const get = vi.fn().mockResolvedValue({
      data: {
        values: [
          headers.Customers,
          [],
          headers.Customers.map(
            (key) => customer[key as keyof typeof customer],
          ),
        ],
      },
    });
    const update = vi.fn().mockResolvedValue({});
    const source = new SheetsDataSource({ GOOGLE_SHEET_ID: "synthetic" });
    vi.spyOn(source, "api").mockResolvedValue({
      spreadsheets: { values: { get, update } },
    } as unknown as Awaited<ReturnType<typeof source.api>>);
    await source.upsert(
      "Customers",
      { ...customer, contact_name: "Updated" },
      customer,
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ range: "'Customers'!A3" }),
    );
    get.mockResolvedValue({
      data: {
        values: [
          headers.Customers,
          [],
          headers.Customers.map((key) =>
            key === "contact_name"
              ? "Human edit"
              : customer[key as keyof typeof customer],
          ),
        ],
      },
    });
    await expect(
      source.upsert(
        "Customers",
        { ...customer, contact_name: "Overwrite" },
        customer,
      ),
    ).rejects.toThrow("Concurrent");
    expect(update).toHaveBeenCalledTimes(1);
  });
});
