import { createHmac, timingSafeEqual } from "node:crypto";
import type { Row } from "../domain/schemas.js";

export const CALL_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
type CallIdentity = Pick<Row<"Calls">, "call_id" | "from_e164" | "started_at">;
function signature(call: CallIdentity, expires: number, secret: string) {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify([call.call_id, call.from_e164, call.started_at, expires]),
    )
    .digest("hex");
}
export function issueCallToken(call: CallIdentity, secret: string): string {
  if (!secret) throw new Error("Call tokens require the tool secret");
  const expires = Date.parse(call.started_at) + CALL_TOKEN_TTL_MS;
  if (!Number.isSafeInteger(expires))
    throw new Error("Invalid call start time");
  return `${expires}.${signature(call, expires, secret)}`;
}
export function verifyCallToken(
  token: string,
  call: CallIdentity,
  secret: string,
  now = Date.now(),
): boolean {
  const parts = /^(\d+)\.([a-f0-9]{64})$/.exec(token);
  if (!parts || !secret) return false;
  const expires = Number(parts[1]);
  const started = Date.parse(call.started_at);
  if (
    !Number.isSafeInteger(expires) ||
    !Number.isFinite(started) ||
    started > now ||
    expires <= now ||
    expires !== started + CALL_TOKEN_TTL_MS
  )
    return false;
  return equalSecret(parts[2], signature(call, expires, secret));
}
