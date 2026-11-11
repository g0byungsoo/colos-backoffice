import { localParts } from "./routing.js";

/** Explicit offsets are instants. Bare CLI timestamps are local wall time. */
export function parseCallTime(
  value: string | undefined,
  timezone: string,
): Date {
  if (!value) return new Date();
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const result = new Date(value);
    if (!Number.isFinite(result.getTime()))
      throw new Error("Invalid call time");
    return result;
  }
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (!parts)
    throw new Error(
      "Use an ISO timestamp with an offset, or local YYYY-MM-DDTHH:mm",
    );
  const target = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(target)) throw new Error("Invalid call time");
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const wall = localParts(new Date(guess), timezone);
    const difference = target - Date.parse(`${wall.date}T${wall.time}:00Z`);
    if (!difference && `${wall.date}T${wall.time}` === value)
      return new Date(guess);
    guess += difference;
  }
  throw new Error(
    "Local call time does not exist in the configured timezone; use an explicit offset",
  );
}
