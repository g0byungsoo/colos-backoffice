import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import {
  headers,
  parseRow,
  type Row,
  rowKey,
  type TableName,
} from "../domain/schemas.js";
import { ConflictError, type DataSource } from "./interface.js";
export async function readSeed<T extends TableName>(
  table: T,
  seedDirectory = "data/seed",
): Promise<Row<T>[]> {
  const content = await readFile(join(seedDirectory, `${table}.csv`), "utf8");
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  }) as unknown[];
  const first = parse(content, { to_line: 1 }) as string[][];
  if (JSON.stringify(first[0]) !== JSON.stringify(headers[table]))
    throw new Error(`Invalid seed headers for ${table}`);
  return records.map((row) => parseRow(table, row));
}
export class LocalDataSource implements DataSource {
  private memory = new Map<TableName, unknown[]>();
  private queue = Promise.resolve();
  readonly directory: string;
  readonly persist: boolean;
  readonly seedDirectory: string;
  constructor(
    options: {
      directory?: string;
      persist?: boolean;
      seedDirectory?: string;
    } = {},
  ) {
    this.directory = options.directory ?? ".cache/local";
    this.persist = options.persist ?? true;
    this.seedDirectory = options.seedDirectory ?? "data/seed";
  }
  async read<T extends TableName>(table: T): Promise<Row<T>[]> {
    if (!this.persist && this.memory.has(table))
      return structuredClone(this.memory.get(table)) as Row<T>[];
    let rows: Row<T>[];
    if (this.persist) {
      try {
        rows = (
          JSON.parse(
            await readFile(join(this.directory, `${table}.json`), "utf8"),
          ) as unknown[]
        ).map((row) => parseRow(table, row));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        rows = await readSeed(table, this.seedDirectory);
      }
    } else {
      rows = await readSeed(table, this.seedDirectory);
      this.memory.set(table, rows);
    }
    return structuredClone(rows);
  }
  async readMany<T extends TableName>(
    tables: T[],
  ): Promise<{ [K in T]: Row<K>[] }> {
    return Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [table, await this.read(table)]),
      ),
    ) as { [K in T]: Row<K>[] };
  }
  private async store<T extends TableName>(table: T, rows: Row<T>[]) {
    if (!this.persist) {
      this.memory.set(table, structuredClone(rows));
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${table}.json`);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(rows, null, 2));
    await rename(temp, path);
  }
  private async mutate(action: () => Promise<void>) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  async replace<T extends TableName>(table: T, rows: Row<T>[], force = false) {
    return this.mutate(async () => {
      if (!force && (await this.read(table)).length)
        throw new Error(
          `${table} already contains data; use --force to replace it`,
        );
      await this.store(
        table,
        rows.map((row) => parseRow(table, row)),
      );
    });
  }
  async upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    expected?: Row<T>,
  ): Promise<void> {
    if (table === "SupplierPrices")
      throw new Error("SupplierPrices is append-only");
    return this.mutate(async () => {
      const clean = parseRow(table, row),
        rows = await this.read(table),
        key = rowKey(table, clean),
        index = rows.findIndex((r) => rowKey(table, r) === key);
      if (
        index >= 0 &&
        (!expected || JSON.stringify(rows[index]) !== JSON.stringify(expected))
      )
        throw new ConflictError(table);
      if (index < 0 && expected) throw new ConflictError(table);
      if (index < 0) rows.push(clean);
      else rows[index] = clean;
      await this.store(table, rows);
    });
  }
  async append<T extends TableName>(table: T, row: Row<T>): Promise<void> {
    return this.mutate(async () => {
      const clean = parseRow(table, row),
        rows = await this.read(table);
      if (rows.some((r) => rowKey(table, r) === rowKey(table, clean)))
        throw new Error(`Duplicate row in ${table}`);
      rows.push(clean);
      await this.store(table, rows);
    });
  }
}
