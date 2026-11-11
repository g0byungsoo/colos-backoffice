import type { Row } from "./schemas.js";
export const reasons = [
  "availability",
  "pickup_status",
  "pickup_confirmation",
  "pricing",
  "policy",
  "existing_order_problem",
  "negotiation",
  "off_topic",
  "not_sure",
] as const;
export type Reason = (typeof reasons)[number];
export function localParts(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
      get("weekday"),
    ),
  };
}
export function isBusinessHours(
  at: Date,
  timezone = "America/Los_Angeles",
  businessHours = "08:00-18:00",
): boolean {
  const [start, end] = businessHours.split("-");
  const time = localParts(at, timezone).time;
  return Boolean(start && end && time >= start && time < end);
}
export type RouteDecision = {
  route: "person" | "agent" | "message";
  reason: string;
  priorityCallback: boolean;
};
export function routeCall(input: {
  phone?: Row<"Phones">;
  customer?: Row<"Customers">;
  issues: Row<"Issues">[];
  at: Date;
  timezone?: string;
  businessHours?: string;
}): RouteDecision {
  const { phone, customer, issues, at, timezone, businessHours } = input;
  const daytime = isBusinessHours(at, timezone, businessHours);
  if (phone?.party_type === "supplier" || phone?.party_type === "depot")
    return {
      route: "agent",
      reason: `${phone.party_type} factual call`,
      priorityCallback: false,
    };
  const open = customer
    ? issues.filter(
        (i) => i.customer_id === customer.customer_id && i.status === "open",
      )
    : [];
  if (open.length)
    return {
      route: daytime ? "person" : "message",
      reason: open
        .map((i) => i.summary)
        .join("; ")
        .replace(/\s+/g, " ")
        .slice(0, 240),
      priorityCallback: !daytime,
    };
  if (phone?.party_type === "customer" && customer && daytime)
    return {
      route: "person",
      reason: `Saved customer ${customer.company}`,
      priorityCallback: false,
    };
  return {
    route: "agent",
    reason: customer
      ? "Customer after hours"
      : "Unknown caller; verify order and company before account access",
    priorityCallback: false,
  };
}
