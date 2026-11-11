import twilio from "twilio";
import { z } from "zod";
import type { Config } from "../config/index.js";

const registerSchema = z.object({
  agent_id: z.string(),
  from_number: z.string(),
  to_number: z.string(),
  direction: z.literal("inbound"),
  conversation_initiation_client_data: z.object({
    dynamic_variables: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean()]),
    ),
  }),
});
export interface VoiceBridge {
  register(
    from: string,
    to: string,
    variables: Record<string, string>,
  ): Promise<string>;
}
export class ElevenLabsBridge implements VoiceBridge {
  constructor(private config: Config) {}
  async register(
    from: string,
    to: string,
    variables: Record<string, string>,
  ): Promise<string> {
    if (!this.config.ELEVENLABS_API_KEY || !this.config.ELEVENLABS_AGENT_ID) {
      const voice = new twilio.twiml.VoiceResponse();
      voice.say(
        "Voice agent dry run. Use the local chat command to try the conversation.",
      );
      return voice.toString();
    }
    const body = registerSchema.parse({
      agent_id: this.config.ELEVENLABS_AGENT_ID,
      from_number: from,
      to_number: to,
      direction: "inbound",
      conversation_initiation_client_data: { dynamic_variables: variables },
    });
    const response = await fetch(
      "https://api.elevenlabs.io/v1/convai/twilio/register-call",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.config.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new Error(`ElevenLabs register failed: ${response.status}`);
    const raw = await response.text();
    const xml = raw.trim().startsWith('"')
      ? z.string().parse(JSON.parse(raw))
      : raw;
    if (!xml.includes("<Response"))
      throw new Error("ElevenLabs returned no TwiML");
    return xml;
  }
}
