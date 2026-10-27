// A missed flow-step post must be visible in the gateway log: warn, not debug
// (T1394 — a lost ocw_tool row previously left no trace at debug verbosity).
import { afterEach, describe, expect, it, vi } from "vitest";

const logWarn = vi.hoisted(() => vi.fn<(message: string) => void>());
const logDebug = vi.hoisted(() => vi.fn<(message: string) => void>());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn: logWarn,
    debug: logDebug,
  })),
}));

import { pryvaFetch, type ResolvedPryvaConfig } from "./backend.js";

const cfg: ResolvedPryvaConfig = {
  backendUrl: "http://127.0.0.1:9",
  internalToken: "test-token",
  pipeline: {
    enabled: true,
    disableEar: false,
    disableCortex: false,
    disableMouth: false,
    disableFastAck: false,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  logWarn.mockClear();
  logDebug.mockClear();
});

describe("pryvaFetch failure visibility", () => {
  it("warns on a non-2xx flow-step post instead of keeping it at debug", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );
    const result = await pryvaFetch(cfg, "POST", "/flows/log-step", {
      flow_id: "fl-testvisibility1",
    });
    expect(result).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]![0]).toContain("backend POST /flows/log-step -> 401");
    expect(logDebug).not.toHaveBeenCalled();
  });

  it("warns when the flow-step request itself throws and still returns null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connection refused");
      }),
    );
    const result = await pryvaFetch(cfg, "POST", "/flows/log-step");
    expect(result).toBeNull();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]![0]).toContain("backend POST /flows/log-step failed");
    expect(logDebug).not.toHaveBeenCalled();
  });
});
