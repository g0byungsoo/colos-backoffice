import OpenAI from "openai";
import type { Config } from "../config/index.js";
import { tableNames } from "../domain/schemas.js";
import { createDataSource } from "./index.js";
import { readCredentials, SheetsDataSource } from "./sheets.js";
export type DoctorCheck = { name: string; ok: boolean; detail: string };
export async function doctor(
  config: Config,
): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const source = createDataSource(config);
  if (config.OPENAI_API_KEY) {
    try {
      const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
      await client.models.retrieve(config.OPENAI_MODEL);
      checks.push({
        name: "OpenAI",
        ok: true,
        detail: `Key can access ${config.OPENAI_MODEL}`,
      });
    } catch {
      checks.push({
        name: "OpenAI",
        ok: false,
        detail:
          "Could not access configured model. Check the key, billing and model access.",
      });
    }
  } else
    checks.push({
      name: "OpenAI",
      ok: config.DATA_SOURCE === "local",
      detail:
        config.DATA_SOURCE === "local"
          ? "Dry-run: no key, deterministic local agent and embeddings"
          : "Missing OPENAI_API_KEY",
    });
  if (source instanceof SheetsDataSource) {
    let email = "the service account email";
    try {
      email = (await readCredentials(config)).client_email;
      await source.api();
      const api = await source.api();
      const sheet = await api.spreadsheets.get({
        spreadsheetId: config.GOOGLE_SHEET_ID,
        fields: "sheets.properties.title",
      });
      checks.push({
        name: "Sheet access",
        ok: true,
        detail: `Accessible to ${email}`,
      });
      const titles = new Set(
        sheet.data.sheets?.map((s) => s.properties?.title),
      );
      const present = tableNames.filter((t) => titles.has(t));
      if (present.length) await source.readMany(present);
      const missing = tableNames.filter((t) => !titles.has(t));
      checks.push({
        name: "Tab headers",
        ok: true,
        detail: missing.length
          ? `Missing tabs will be created by seed: ${missing.join(", ")}`
          : "All tab headers and rows validate",
      });
    } catch (error) {
      const code =
        (error as { code?: number; response?: { status?: number } }).response
          ?.status ?? (error as { code?: number }).code;
      checks.push({
        name: "Sheet access and headers",
        ok: false,
        detail:
          code === 403 || code === 404
            ? `Share GOOGLE_SHEET_ID with ${email} as an editor.`
            : `Sheet check failed: ${(error as Error).message}. Service account: ${email}`,
      });
    }
  } else {
    try {
      await source.readMany(tableNames);
      checks.push({
        name: "Local data",
        ok: true,
        detail: "All synthetic CSV headers and rows validate",
      });
    } catch (error) {
      checks.push({
        name: "Local data",
        ok: false,
        detail: (error as Error).message,
      });
    }
  }
  for (const [name, configured, detail] of [
    [
      "Stripe",
      Boolean(config.STRIPE_SECRET_KEY),
      config.STRIPE_SECRET_KEY?.startsWith("sk_test_")
        ? "Test key configured; sending verifies access"
        : "Use a Stripe test mode key",
    ],
    [
      "Twilio",
      Boolean(config.TWILIO_AUTH_TOKEN),
      "Webhook signatures will be checked",
    ],
    [
      "ElevenLabs",
      Boolean(config.ELEVENLABS_API_KEY && config.ELEVENLABS_AGENT_ID),
      "Agent registration configured; requires a live call to verify",
    ],
    ["Owner phone", Boolean(config.OWNER_PHONE), "Owner dialing configured"],
    [
      "Tool webhook",
      Boolean(config.TOOL_WEBHOOK_SECRET),
      "Shared-secret authentication configured",
    ],
    ["Cron", Boolean(config.CRON_SECRET), "Cron authentication configured"],
  ] as const)
    checks.push({
      name,
      ok:
        name === "Stripe" && configured
          ? !!config.STRIPE_SECRET_KEY?.startsWith("sk_test_")
          : true,
      detail: configured
        ? detail
        : "Dry-run: optional integration not configured",
    });
  return { ok: checks.every((check) => check.ok), checks };
}
