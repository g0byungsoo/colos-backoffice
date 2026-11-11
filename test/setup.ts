import http from "node:http";
import https from "node:https";
import { vi } from "vitest";

// Tests never inherit service credentials from the developer's shell or .env.
for (const key of [
  "OPENAI_API_KEY",
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "STRIPE_SECRET_KEY",
  "TWILIO_AUTH_TOKEN",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_AGENT_ID",
])
  process.env[key] = "";
const deny = () => {
  throw new Error("Network access is disabled in unit tests");
};
vi.stubGlobal("fetch", deny);
vi.spyOn(http, "request").mockImplementation(deny);
vi.spyOn(http, "get").mockImplementation(deny);
vi.spyOn(https, "request").mockImplementation(deny);
vi.spyOn(https, "get").mockImplementation(deny);
