// Covers the log line written when the backend preflight cleanly denies a heartbeat.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

describe("runHeartbeatOnce preflight clean deny", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("logs the deny reason at info level", async () => {
    const info = vi.fn();
    const noop = vi.fn();
    const logger = {
      subsystem: "gateway/heartbeat",
      isEnabled: vi.fn(() => true),
      trace: noop,
      debug: noop,
      info,
      warn: noop,
      error: noop,
      fatal: noop,
      raw: noop,
      child: vi.fn(() => logger),
    };
    vi.doMock("../logging/subsystem.js", async () => {
      const actual =
        await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
      return { ...actual, createSubsystemLogger: vi.fn(() => logger) };
    });
    const { runHeartbeatOnce } = await import("./heartbeat-runner.js");

    const heartbeat = { every: "30m", preflight: { url: "http://127.0.0.1:9/preflight" } };
    const cfg = {
      agents: { defaults: { heartbeat }, list: [{ id: "main", heartbeat }] },
    } as OpenClawConfig;
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ run: false, reason: "no_channel" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const res = await runHeartbeatOnce({ cfg, deps: { fetchImpl } });

    expect(res).toEqual({ status: "skipped", reason: "preflight:no_channel" });
    expect(info).toHaveBeenCalledWith("heartbeat: skipped by preflight", {
      reason: "preflight:no_channel",
    });
  });
});
