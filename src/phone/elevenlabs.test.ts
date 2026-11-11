import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../config/index.js";
import { equalSecret, issueCallToken, verifyCallToken } from "./auth.js";
import { ElevenLabsBridge } from "./elevenlabs.js";

afterEach(() => vi.unstubAllGlobals());
describe("voice bridge", () => {
  it("dry runs without optional credentials and makes no request", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const bridge = new ElevenLabsBridge(getConfig({ DATA_SOURCE: "local" }));
    expect(await bridge.register("+15555550199", "+15555550100", {})).toContain(
      "dry run",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "uses the documented register-call payload and TwiML response (JSON: %s)",
    async (json) => {
      const xml =
        '<Response><Connect><Stream url="wss://example.com/mock"/></Connect></Response>';
      const request = vi
        .fn()
        .mockResolvedValue(new Response(json ? JSON.stringify(xml) : xml));
      vi.stubGlobal("fetch", request);
      const bridge = new ElevenLabsBridge(
        getConfig({
          DATA_SOURCE: "local",
          ELEVENLABS_API_KEY: "synthetic-key",
          ELEVENLABS_AGENT_ID: "synthetic-agent",
        }),
      );
      expect(
        await bridge.register("+15555550199", "+15555550100", {
          caller_name: "Unknown",
          call_id: "synthetic-call",
        }),
      ).toBe(xml);
      const [url, options] = request.mock.calls[0];
      expect(url).toBe(
        "https://api.elevenlabs.io/v1/convai/twilio/register-call",
      );
      expect(JSON.parse(options.body)).toEqual({
        agent_id: "synthetic-agent",
        from_number: "+15555550199",
        to_number: "+15555550100",
        direction: "inbound",
        conversation_initiation_client_data: {
          dynamic_variables: {
            caller_name: "Unknown",
            call_id: "synthetic-call",
          },
        },
      });
    },
  );
  it("rejects non-TwiML successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    const bridge = new ElevenLabsBridge(
      getConfig({
        DATA_SOURCE: "local",
        ELEVENLABS_API_KEY: "synthetic-key",
        ELEVENLABS_AGENT_ID: "synthetic-agent",
      }),
    );
    await expect(
      bridge.register("+15555550199", "+15555550100", {}),
    ).rejects.toThrow("no TwiML");
  });
});
describe("call tokens", () => {
  const call = {
    call_id: "synthetic-call",
    from_e164: "+15555550199",
    started_at: "2026-11-11T03:00:00Z",
  };
  it("rejects tokens copied to another call or caller", () => {
    const token = issueCallToken(call, "synthetic-secret");
    const now = Date.parse(call.started_at);
    expect(verifyCallToken(token, call, "synthetic-secret", now)).toBe(true);
    expect(
      verifyCallToken(
        token,
        { ...call, call_id: "other" },
        "synthetic-secret",
        now,
      ),
    ).toBe(false);
    expect(
      verifyCallToken(
        token,
        { ...call, from_e164: "+15555550102" },
        "synthetic-secret",
        now,
      ),
    ).toBe(false);
  });
  it("compares bytes safely for differing UTF-8 encodings", () => {
    expect(equalSecret("µ", "a")).toBe(false);
    expect(equalSecret("abc", "abc")).toBe(true);
  });
});
