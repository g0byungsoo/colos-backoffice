import "dotenv/config";
import { z } from "zod";

const optional = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().optional(),
);
export const envSchema = z.object({
  OPENAI_API_KEY: optional,
  GOOGLE_SHEET_ID: optional,
  GOOGLE_SERVICE_ACCOUNT_JSON: optional,
  GOOGLE_APPLICATION_CREDENTIALS: optional,
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_JUDGE_MODEL: z.string().default("gpt-5.6-terra"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  DATA_SOURCE: z.enum(["sheets", "local"]).default("sheets"),
  TIMEZONE: z
    .string()
    .default("America/Los_Angeles")
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
  BUSINESS_HOURS: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    .default("08:00-18:00"),
  OWNER_PHONE: optional,
  FLOOR_MARGIN_CENTS: z.coerce.number().int().min(5000).default(5000),
  STRIPE_SECRET_KEY: optional,
  TWILIO_AUTH_TOKEN: optional,
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_AGENT_ID: optional,
  TOOL_WEBHOOK_SECRET: optional,
  CRON_SECRET: optional,
  RAG_RERANK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  RUNTIME_DIR: z.string().default("."),
  PORT: z.coerce.number().int().positive().default(3000),
});
export type Config = z.infer<typeof envSchema>;
export function getConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
