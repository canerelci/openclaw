import { describe, expect, it } from "vitest";
import { resolveEmbeddedAgentStreamFn } from "./src/agents/embedded-agent-runner/stream-resolution.js";

const SDK_MARK = Symbol("sdk-streamfn");

describe("does attempt.ts keep or discard the sdk.ts streamFn?", () => {
  it("groq via gateway with a resolved runtime key", () => {
    const sdkStreamFn = Object.assign(async () => ({}) as never, { [SDK_MARK]: true });
    const out = resolveEmbeddedAgentStreamFn({
      currentStreamFn: sdkStreamFn as never,
      sessionId: "s1",
      model: { provider: "groq", id: "llama", baseUrl: "https://gw/llm/groq/v1" } as never,
      resolvedApiKey: "instance-token",
    });
    // If out === sdkStreamFn (or wraps it), the sdk.ts seam is LIVE for this path.
    console.log("returned is the sdk fn itself:", out === (sdkStreamFn as never));
    expect(true).toBe(true);
  });
});
