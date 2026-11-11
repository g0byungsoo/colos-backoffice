import { readFile } from "node:fs/promises";
import { google, type sheets_v4 } from "googleapis";
import { z } from "zod";
import {
  headers,
  parseRow,
  type Row,
  rowKey,
  type TableName,
  tableNames,
} from "../domain/schemas.js";
import { ConflictError, type DataSource } from "./interface.js";

const credentialSchema = z
  .object({
    client_email: z.email(),
    private_key: z.string().min(1),
    project_id: z.string().optional(),
  })
  .passthrough();
export type SheetsConfig = {
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_APPLICATION_CREDENTIALS?: string;
};
export async function readCredentials(config: SheetsConfig) {
  let raw = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw && config.GOOGLE_APPLICATION_CREDENTIALS)
    raw = await readFile(config.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  if (!raw)
    throw new Error(
      "Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS",
    );
  if (!raw.trim().startsWith("{"))
    raw = Buffer.from(raw, "base64").toString("utf8");
  try {
    return credentialSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "Invalid service account JSON; expected client_email and private_key",
    );
  }
}
export async function withBackoff<T>(
  action: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const e = error as { code?: number; response?: { status?: number } };
      if ((e.code !== 429 && e.response?.status !== 429) || attempt >= 5)
        throw error;
      await sleep(
        Math.min(32000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 200),
      );
    }
  }
}
export class SheetsDataSource implements DataSource {
  private apiPromise?: Promise<sheets_v4.Sheets>;
  constructor(readonly config: SheetsConfig) {}
  async api() {
    if (!this.apiPromise)
      this.apiPromise = (async () => {
        if (!this.config.GOOGLE_SHEET_ID)
          throw new Error("Set GOOGLE_SHEET_ID");
        const credentials = await readCredentials(this.config);
        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        return google.sheets({ version: "v4", auth });
      })();
    return this.apiPromise;
  }
  async readMany<T extends TableName>(
    tables: T[],
  ): Promise<{ [K in T]: Row<K>[] }> {
    if (!tables.length) return {} as { [K in T]: Row<K>[] };
    const api = await this.api();
    const response = await withBackoff(() =>
      api.spreadsheets.values.batchGet({
        spreadsheetId: this.config.GOOGLE_SHEET_ID,
        ranges: tables.map((t) => `'${t}'!A:ZZ`),
      }),
    );
    return Object.fromEntries(
      tables.map((table, index) => {
        const values = response.data.valueRanges?.[index]?.values ?? [];
        if (JSON.stringify(values[0]) !== JSON.stringify(headers[table]))
          throw new Error(
            `Invalid or missing headers for ${table}; run seed on a blank sheet`,
          );
        return [
          table,
          values
            .slice(1)
            .filter((row) => row.some((value) => value !== ""))
            .map((row) =>
              parseRow(
                table,
                Object.fromEntries(
                  headers[table].map((key, i) => [key, row[i] ?? ""]),
                ),
              ),
            ),
        ];
      }),
    ) as { [K in T]: Row<K>[] };
  }
  async read<T extends TableName>(table: T) {
    return (await this.readMany([table]))[table];
  }
  async upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    expected?: Row<T>,
  ): Promise<void> {
    if (table === "SupplierPrices")
      throw new Error("SupplierPrices is append-only");
    const clean = parseRow(table, row);
    const api = await this.api();
    const response = await withBackoff(() =>
      api.spreadsheets.values.get({
        spreadsheetId: this.config.GOOGLE_SHEET_ID,
        range: `'${table}'!A:ZZ`,
      }),
    );
    const values = response.data.values ?? [];
    if (JSON.stringify(values[0]) !== JSON.stringify(headers[table]))
      throw new Error(`Invalid headers for ${table}`);
    // Keep blank row positions so a human clearing a row cannot shift our write.
    const rows = values
      .slice(1)
      .map((values) =>
        values.some((value) => value !== "")
          ? parseRow(
              table,
              Object.fromEntries(
                headers[table].map((key, i) => [key, values[i] ?? ""]),
              ),
            )
          : undefined,
      );
    const index = rows.findIndex(
      (r) => r !== undefined && rowKey(table, r) === rowKey(table, clean),
    );
    if (
      index >= 0 &&
      (!expected || JSON.stringify(rows[index]) !== JSON.stringify(expected))
    )
      throw new ConflictError(table);
    if (index < 0 && expected) throw new ConflictError(table);
    if (index < 0) return this.append(table, clean);
    await withBackoff(() =>
      api.spreadsheets.values.update({
        spreadsheetId: this.config.GOOGLE_SHEET_ID,
        range: `'${table}'!A${index + 2}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [
            headers[table].map(
              (key) => (clean as Record<string, unknown>)[key],
            ),
          ],
        },
      }),
    );
  }
  async append<T extends TableName>(table: T, row: Row<T>): Promise<void> {
    const clean = parseRow(table, row);
    if (
      (await this.read(table)).some(
        (r) => rowKey(table, r) === rowKey(table, clean),
      )
    )
      throw new Error(`Duplicate row in ${table}`);
    const api = await this.api();
    await withBackoff(() =>
      api.spreadsheets.values.append({
        spreadsheetId: this.config.GOOGLE_SHEET_ID,
        range: `'${table}'!A:ZZ`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [
            headers[table].map(
              (key) => (clean as Record<string, unknown>)[key],
            ),
          ],
        },
      }),
    );
  }
  async checkHeaders() {
    await this.readMany(tableNames);
  }
}
// Construct once per request. Writes invalidate cached rows, and the underlying
// source always performs the final conflict read without using this cache.
export class RequestDataSource implements DataSource {
  private cache = new Map<TableName, unknown[]>();
  constructor(readonly source: DataSource) {}
  // End the request snapshot before the next turn or approval decision.
  clearCache(): void {
    this.cache.clear();
  }
  async read<T extends TableName>(table: T) {
    if (!this.cache.has(table))
      this.cache.set(table, await this.source.read(table));
    return structuredClone(this.cache.get(table)) as Row<T>[];
  }
  async readMany<T extends TableName>(tables: T[]) {
    const missing = [...new Set(tables)].filter((t) => !this.cache.has(t));
    if (missing.length) {
      const loaded = await this.source.readMany(missing);
      for (const t of missing) this.cache.set(t, loaded[t]);
    }
    return Object.fromEntries(
      tables.map((t) => [t, structuredClone(this.cache.get(t))]),
    ) as { [K in T]: Row<K>[] };
  }
  async upsert<T extends TableName>(table: T, row: Row<T>, expected?: Row<T>) {
    try {
      await this.source.upsert(table, row, expected);
    } finally {
      this.cache.delete(table);
    }
  }
  async append<T extends TableName>(table: T, row: Row<T>) {
    try {
      await this.source.append(table, row);
    } finally {
      this.cache.delete(table);
    }
  }
}
