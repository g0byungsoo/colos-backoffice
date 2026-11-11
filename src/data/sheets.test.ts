import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { headers, tableNames } from "../domain/schemas.js";
import { LocalDataSource } from "./local.js";
import { seed } from "./seed.js";
import {
  RequestDataSource,
  readCredentials,
  SheetsDataSource,
  withBackoff,
} from "./sheets.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function sourceWith(api: unknown) {
  const source = new SheetsDataSource({ GOOGLE_SHEET_ID: "test-sheet" });
  vi.spyOn(source, "api").mockResolvedValue(
    api as Awaited<ReturnType<typeof source.api>>,
  );
  return source;
}
describe("Sheets seeding boundaries", () => {
  it("refuses unknown first-row data before creating or changing tabs", async () => {
    const batchUpdate = vi.fn();
    const source = sourceWith({
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: {
            sheets: [{ properties: { title: "Customers", sheetId: 7 } }],
          },
        }),
        batchUpdate,
        values: {
          batchGet: vi.fn().mockResolvedValue({
            data: {
              valueRanges: [{ values: [["Do not overwrite this note"]] }],
            },
          }),
        },
      },
    });
    await expect(seed(source)).rejects.toThrow("already contains data");
    expect(batchUpdate).not.toHaveBeenCalled();
  });
  it("creates missing tabs and writes validated rows with bold frozen headers", async () => {
    const batchUpdate = vi.fn().mockImplementation(async ({ requestBody }) => ({
      data: {
        replies: requestBody.requests
          .filter((request: { addSheet?: unknown }) => request.addSheet)
          .map(
            (
              request: { addSheet: { properties: { title: string } } },
              i: number,
            ) => ({
              addSheet: {
                properties: {
                  title: request.addSheet.properties.title,
                  sheetId: i + 1,
                },
              },
            }),
          ),
      },
    }));
    const write = vi.fn().mockResolvedValue({});
    const source = sourceWith({
      spreadsheets: {
        get: vi.fn().mockResolvedValue({ data: { sheets: [] } }),
        batchUpdate,
        values: { batchUpdate: write },
      },
    });
    expect(await seed(source)).toEqual(tableNames);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    const formatting = batchUpdate.mock.calls[1][0].requestBody.requests;
    for (const sheetId of tableNames.map((_, i) => i + 1)) {
      expect(formatting).toContainEqual({
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      });
      expect(formatting).toContainEqual({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      });
    }
    const writes = write.mock.calls[0][0].requestBody.data;
    expect(writes).toHaveLength(tableNames.length);
    for (const table of tableNames)
      expect(
        writes.find((item: { range: string }) => item.range === `'${table}'!A1`)
          .values[0],
      ).toEqual(headers[table]);
  });
  it("refuses populated rows before every mutation", async () => {
    const mutate = vi.fn();
    const source = sourceWith({
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: { sheets: [{ properties: { title: "Calls", sheetId: 1 } }] },
        }),
        batchUpdate: mutate,
        values: {
          batchGet: vi.fn().mockResolvedValue({
            data: {
              valueRanges: [{ values: [headers.Calls, ["saved-call"]] }],
            },
          }),
          batchUpdate: mutate,
        },
      },
    });
    await expect(seed(source)).rejects.toThrow("Calls already contains data");
    expect(mutate).not.toHaveBeenCalled();
  });
});
describe("validated reads and request snapshots", () => {
  it("rejects wrong tab headers without returning unvalidated data", async () => {
    const source = sourceWith({
      spreadsheets: {
        values: {
          batchGet: vi.fn().mockResolvedValue({
            data: { valueRanges: [{ values: [["wrong"]] }] },
          }),
        },
      },
    });
    await expect(source.read("Customers")).rejects.toThrow(
      "Invalid or missing headers",
    );
  });
  it("clears snapshots at turn boundaries and invalidates after failed conflicts", async () => {
    const data = new LocalDataSource({ persist: false });
    const request = new RequestDataSource(data);
    const original = (await request.read("Customers"))[0];
    await data.upsert(
      "Customers",
      { ...original, contact_name: "Human edit" },
      original,
    );
    await expect(
      request.upsert(
        "Customers",
        { ...original, contact_name: "Stale" },
        original,
      ),
    ).rejects.toThrow("Concurrent");
    expect((await request.read("Customers"))[0].contact_name).toBe(
      "Human edit",
    );
    const current = (await data.read("Customers"))[0];
    await data.upsert(
      "Customers",
      { ...current, contact_name: "Next turn" },
      current,
    );
    request.clearCache();
    expect((await request.read("Customers"))[0].contact_name).toBe("Next turn");
  });
  it("deduplicates batch misses and returns copies", async () => {
    const data = new LocalDataSource({ persist: false });
    const request = new RequestDataSource(data);
    const spy = vi.spyOn(data, "readMany");
    const rows = await request.readMany(["Customers", "Orders", "Customers"]);
    rows.Customers[0].company = "Locally changed";
    expect(spy).toHaveBeenCalledWith(["Customers", "Orders"]);
    expect((await request.read("Customers"))[0].company).not.toBe(
      "Locally changed",
    );
  });
  it("limits rate-limit retries", async () => {
    const action = vi.fn().mockRejectedValue({ response: { status: 429 } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withBackoff(action, sleep)).rejects.toEqual({
      response: { status: 429 },
    });
    expect(action).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });
});
describe("service account formats", () => {
  it("accepts raw JSON, base64 and a key file without network", async () => {
    const credential = {
      client_email: "synthetic@example.com",
      private_key: "synthetic-test-value",
    };
    const raw = JSON.stringify(credential);
    const directory = await mkdtemp(join(tmpdir(), "colos-key-"));
    dirs.push(directory);
    const path = join(directory, "key.json");
    await writeFile(path, raw);
    for (const config of [
      { GOOGLE_SERVICE_ACCOUNT_JSON: raw },
      { GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(raw).toString("base64") },
      { GOOGLE_APPLICATION_CREDENTIALS: path },
    ])
      expect(await readCredentials(config)).toEqual(credential);
  });
  it("does not echo malformed credential contents", async () => {
    await expect(
      readCredentials({
        GOOGLE_SERVICE_ACCOUNT_JSON:
          '{"private_key":"secret-test-marker",broken',
      }),
    ).rejects.toThrow("Invalid service account JSON");
    try {
      await readCredentials({
        GOOGLE_SERVICE_ACCOUNT_JSON:
          '{"private_key":"secret-test-marker",broken',
      });
    } catch (error) {
      expect(String(error)).not.toContain("secret-test-marker");
    }
  });
});
