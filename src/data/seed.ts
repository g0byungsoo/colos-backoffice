import { access } from "node:fs/promises";
import { join } from "node:path";
import type { sheets_v4 } from "googleapis";
import { headers, tableNames } from "../domain/schemas.js";
import { LocalDataSource, readSeed } from "./local.js";
import { type SheetsDataSource, withBackoff } from "./sheets.js";
export async function seed(
  source: LocalDataSource | SheetsDataSource,
  force = false,
): Promise<string[]> {
  if (source instanceof LocalDataSource) {
    for (const table of tableNames) {
      if (source.persist && !force) {
        try {
          await access(join(source.directory, `${table}.json`));
          if ((await source.read(table)).length)
            throw new Error(`${table} already contains data; use --force`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    for (const table of tableNames)
      await source.replace(
        table,
        await readSeed(table, source.seedDirectory),
        true,
      );
    return tableNames;
  }
  const api = await source.api();
  const spreadsheetId = source.config.GOOGLE_SHEET_ID;
  const metadata = await withBackoff(() =>
    api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" }),
  );
  const existing = new Map(
    metadata.data.sheets?.map((s) => [
      s.properties?.title,
      s.properties?.sheetId,
    ]) ?? [],
  );
  // Preflight every tab before mutating any existing data.
  const present = tableNames.filter((t) => existing.has(t));
  if (present.length && !force) {
    const values = await withBackoff(() =>
      api.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: present.map((t) => `'${t}'!A:ZZ`),
      }),
    );
    for (const [index, range] of (values.data.valueRanges ?? []).entries())
      if (
        (range.values?.slice(1) ?? []).some((row) => row.some((v) => v !== ""))
      )
        throw new Error(`${present[index]} already contains data; use --force`);
  }
  const missing = tableNames.filter((t) => !existing.has(t));
  if (missing.length) {
    const added = await withBackoff(() =>
      api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missing.map((title) => ({
            addSheet: { properties: { title } },
          })),
        },
      }),
    );
    for (const reply of added.data.replies ?? []) {
      const p = reply.addSheet?.properties;
      if (p?.title) existing.set(p.title, p.sheetId);
    }
  }
  const requests: sheets_v4.Schema$Request[] = tableNames.flatMap((table) => {
    const sheetId = existing.get(table);
    return [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
    ];
  });
  await withBackoff(() =>
    api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }),
  );
  if (force)
    await withBackoff(() =>
      api.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: tableNames.map((t) => `'${t}'!A:ZZ`) },
      }),
    );
  const data = await Promise.all(
    tableNames.map(async (table) => ({
      range: `'${table}'!A1`,
      values: [
        headers[table],
        ...(await readSeed(table)).map((row) =>
          headers[table].map((key) => (row as Record<string, unknown>)[key]),
        ),
      ],
    })),
  );
  await withBackoff(() =>
    api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data },
    }),
  );
  return tableNames;
}
