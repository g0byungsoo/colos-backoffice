import { LocalDataSource } from "./local.js";
import { type SheetsConfig, SheetsDataSource } from "./sheets.js";

export * from "./interface.js";
export * from "./local.js";
export * from "./seed.js";
export * from "./sheets.js";
export function createDataSource(
  config: SheetsConfig & { DATA_SOURCE?: "local" | "sheets" },
) {
  return config.DATA_SOURCE === "local"
    ? new LocalDataSource()
    : new SheetsDataSource(config);
}
export * from "./doctor.js";
