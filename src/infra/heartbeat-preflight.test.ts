// Covers the external heartbeat preflight gate (backend veto before any LLM work).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveHeartbeatPreflightDecision } from "./heartbeat-preflight.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { resetSystemEventsForTest } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveHeartbeatPreflightDecision", () => {
  it("allows the run when the endpoint answers run:true", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ run: true }));

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/api/v1/heartbeat/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toEqual({ run: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tenant.example/api/v1/heartbeat/preflight");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Accept).toBe("application/json");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("sends the bearer token when configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ run: true }));

    await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      token: "s3cret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
  });

  it("denies with the backend reason when the endpoint answers run:false", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ run: false, reason: "no-due-work" }));

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toEqual({ run: false, reason: "preflight:no-due-work" });
  });

  it("denies with preflight:denied when run:false carries no reason", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ run: false }));

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toEqual({ run: false, reason: "preflight:denied" });
  });

  it("fails closed on timeout", async () => {
    const onWarn = vi.fn();
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onWarn,
    });

    expect(decision).toEqual({ run: false, reason: "preflight-unreachable" });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]?.[1]).toMatchObject({
      url: "https://tenant.example/preflight",
    });
    expect(String(onWarn.mock.calls[0]?.[1]?.error)).toContain("timeout");
  });

  it("fails closed on a network error", async () => {
    const onWarn = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onWarn,
    });

    expect(decision).toEqual({ run: false, reason: "preflight-unreachable" });
    expect(onWarn.mock.calls[0]?.[1]).toMatchObject({
      url: "https://tenant.example/preflight",
      error: "ECONNREFUSED",
    });
  });

  it("fails closed on HTTP 500", async () => {
    const onWarn = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ run: true }, { status: 500 }));

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onWarn,
    });

    expect(decision).toEqual({ run: false, reason: "preflight-unreachable" });
    expect(onWarn.mock.calls[0]?.[1]).toMatchObject({ error: "HTTP 500" });
  });

  it("fails closed on an unparsable body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toEqual({ run: false, reason: "preflight-unreachable" });
  });

  it("fails closed when the body has no boolean run field", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));

    const decision = await resolveHeartbeatPreflightDecision({
      url: "https://tenant.example/preflight",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(decision).toEqual({ run: false, reason: "preflight-unreachable" });
  });
});

const noopOutbound = {
  deliveryMode: "direct" as const,
  sendText: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
  sendMedia: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
};

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram", outbound: noopOutbound });
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
});

afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

beforeEach(() => {
  resetSystemEventsForTest();
  resetCronActiveJobs();
});

function createHeartbeatConfig(preflight?: Record<string, unknown>): OpenClawConfig {
  return {
    agents: {
      defaults: {
        heartbeat: preflight ? { every: "30m", preflight } : { every: "30m" },
        model: { primary: "test/model" },
      },
    },
    channels: {
      telegram: { enabled: true, token: "fake", allowFrom: ["123"] },
    },
  } as unknown as OpenClawConfig;
}

async function seedSession(storePath: string, cfg: OpenClawConfig) {
  return seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "123",
  });
}

describe("heartbeat runner preflight gate", () => {
  it("makes no preflight call when no url is configured", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig();
      await seedSession(storePath, cfg);
      const fetchImpl = vi.fn(async () => jsonResponse({ run: false }));
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        } as HeartbeatDeps,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it("skips before any reply work when the backend answers run:false", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({ url: "https://tenant.example/preflight" });
      await seedSession(storePath, cfg);
      const fetchImpl = vi.fn(async () => jsonResponse({ run: false, reason: "nothing-due" }));

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: "preflight:nothing-due" });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("gates manual/immediate wakes the same way", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({ url: "https://tenant.example/preflight" });
      await seedSession(storePath, cfg);
      const fetchImpl = vi.fn(async () => jsonResponse({ run: false, reason: "paused" }));

      for (const intent of ["immediate", "manual"] as const) {
        const result = await runHeartbeatOnce({
          cfg,
          intent,
          deps: {
            getQueueSize: vi.fn((_lane?: string) => 0),
            nowMs: () => Date.now(),
            getReplyFromConfig: replySpy,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          } as HeartbeatDeps,
        });
        expect(result).toEqual({ status: "skipped", reason: "preflight:paused" });
      }

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("fails closed at the runner level when the backend is unreachable", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({ url: "https://tenant.example/preflight" });
      await seedSession(storePath, cfg);
      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: "preflight-unreachable" });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("runs normally when the backend answers run:true", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatConfig({
        url: "https://tenant.example/preflight",
        token: "tok",
        timeoutMs: 1500,
      });
      await seedSession(storePath, cfg);
      const fetchImpl = vi.fn(async () => jsonResponse({ run: true }));
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        } as HeartbeatDeps,
      });

      expect(result.status).toBe("ran");
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });
});
