import type { Row, TableName } from "../domain/schemas.js";
export interface DataSource {
  read<T extends TableName>(table: T): Promise<Row<T>[]>;
  readMany<T extends TableName>(tables: T[]): Promise<{ [K in T]: Row<K>[] }>;
  upsert<T extends TableName>(
    table: T,
    row: Row<T>,
    expected?: Row<T>,
  ): Promise<void>;
  append<T extends TableName>(table: T, row: Row<T>): Promise<void>;
}
export class ConflictError extends Error {
  constructor(table: string) {
    super(`Concurrent edit in ${table}; re-read and review before retrying`);
    this.name = "ConflictError";
  }
}
