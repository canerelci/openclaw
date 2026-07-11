import { beforeEach, describe, expect, it, vi } from "vitest";

const pryvaFetch = vi.fn();
vi.mock("./backend.js", () => ({ pryvaFetch: (...args: unknown[]) => pryvaFetch(...args) }));

const { onMessageSending } = await import("./pipeline-outbound.js");
const { noteToolCall } = await import("./stalling.js");

// Markdown marker so Mouth actually runs (needsMouth is structural only — not length).
const HONEST =
  "Anladım, logo yerleşimini düzeltmek için markanın logo dosyasını ve görsel kurallarını " +
  "kontrol etmem lazım — **logo dosyasını** atabilir misin?";
const PROMISE = "Hemen yenisini hazırlıyorum, birkaç dakika içinde geliyor.";

type FetchCall = { path: string; body: Record<string, unknown>; opts: { flowId?: string } };

function calls(): FetchCall[] {
  return pryvaFetch.mock.calls.map((c) => ({
    path: c[2] as string,
    body: c[3] as Record<string, unknown>,
    opts: (c[4] ?? {}) as { flowId?: string },
  }));
}

function makePipeline(binding: { flowId: string } | null) {
  return {
    cfg: { pipeline: {} },
    ctxStore: {
      findByRecipient: () => ({ originalMessage: "3. görseli beğenmedim", earPlan: null }),
      findLatest: () => null,
    },
    registry: { resolve: vi.fn(() => binding) },
    log: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  } as never;
}

beforeEach(() => {
  pryvaFetch.mockReset();
  pryvaFetch.mockResolvedValue(null);
});

describe("onMessageSending flow attribution", () => {
  it("attributes Cortex/Mouth to the producing run's flow, resolved by runId", async () => {
    const pipeline = makePipeline({ flowId: "fl-real" });
    await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
      sessionKey: "agent:main:main",
      runId: "run-7",
    } as never);

    const resolve = (pipeline as unknown as { registry: { resolve: ReturnType<typeof vi.fn> } })
      .registry.resolve;
    expect(resolve).toHaveBeenCalledWith("run-7", undefined, "agent:main:main");

    const cortex = calls().find((c) => c.path === "/pipeline/cortex");
    expect(cortex?.opts.flowId).toBe("fl-real");
    expect(cortex?.opts.flowId).not.toBe("fl-unbound");
  });

  it("falls back to fl-unbound (and warns) only when nothing binds", async () => {
    const pipeline = makePipeline(null);
    await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
    } as never);

    const cortex = calls().find((c) => c.path === "/pipeline/cortex");
    expect(cortex?.opts.flowId).toBe("fl-unbound");
    expect(
      (pipeline as unknown as { log: { warn: ReturnType<typeof vi.fn> } }).log.warn,
    ).toHaveBeenCalledWith(expect.stringContaining("outbound unbound"));
  });
});

describe("onMessageSending error-reply neutralization", () => {
  const BILLING_ERROR =
    "⚠️ Anthropic returned a billing error — your API key has run out of credits or has an " +
    "insufficient balance. Check your Anthropic billing dashboard and top up or switch to a " +
    "different API key.";

  it("replaces operator-facing error copy with brand-neutral text and skips Cortex/Mouth", async () => {
    const pipeline = makePipeline({ flowId: "fl-real" });

    const result = await onMessageSending(
      pipeline,
      { to: "owner", content: BILLING_ERROR, isError: true },
      { channelId: "whatsapp", sessionKey: "agent:main:main", runId: "run-billing" } as never,
    );

    expect(result?.content).toBeDefined();
    expect(result?.content).not.toContain("Anthropic");
    expect(result?.content).not.toContain("credits");
    expect(result?.content).not.toContain("billing dashboard");
    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(false);
    expect(calls().some((c) => c.path === "/pipeline/mouth")).toBe(false);
  });

  it("localizes the neutral copy to Turkish when the original error text is Turkish", async () => {
    const pipeline = makePipeline({ flowId: "fl-real" });
    const trError =
      "Üzgünüz, API sağlayıcımız bir faturalama hatası döndü. API anahtarınızın kredileri " +
      "bitti veya yetersiz bakiyesi var.";

    const result = await onMessageSending(
      pipeline,
      { to: "owner", content: trError, isError: true },
      { channelId: "whatsapp", runId: "run-billing-tr" } as never,
    );

    expect(result?.content).toMatch(/[ığşçöüİĞŞÇÖÜ]/);
    expect(result?.content).not.toContain("faturalama");
    expect(result?.content).not.toContain("API anahtar");
  });

  it("logs a flow-step for the neutralization, attributed to the producing flow", async () => {
    const pipeline = makePipeline({ flowId: "fl-real" });

    await onMessageSending(pipeline, { to: "owner", content: BILLING_ERROR, isError: true }, {
      channelId: "whatsapp",
      runId: "run-billing",
    } as never);

    const step = calls().find(
      (c) => c.path === "/flows/log-step" && c.body.step_name === "ocw_error_reply_neutralized",
    );
    expect(step?.opts.flowId).toBe("fl-real");
  });
});

describe("onMessageSending empty-promise backstop", () => {
  it("demotes a promise that MOUTH reintroduced into an honest draft (fl-6cb0e7d6fda4)", async () => {
    // Real prod shape: the agent's final reply was honest, Cortex blocked without a rewrite,
    // and Mouth handed back an empty promise. The backstop must run after Mouth, not before.
    pryvaFetch.mockImplementation(async (_cfg, _m, path: string) => {
      if (path === "/pipeline/cortex") {
        return { action: "block" };
      }
      if (path === "/pipeline/mouth") {
        return { polished: PROMISE };
      }
      return null;
    });
    const pipeline = makePipeline({ flowId: "fl-real" });

    const result = await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
      sessionKey: "agent:main:main",
      runId: "run-no-tools",
    } as never);

    expect(result?.content).not.toContain("hazırlıyorum");
    expect(result?.content).toContain("Kusura bakma, bunu şu an yapamadım.");

    const blocked = calls().filter(
      (c) => c.path === "/flows/log-step" && c.body.step_name === "ocw_empty_promise_blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.opts.flowId).toBe("fl-real");
  });

  it("leaves a promise alone when the run actually did work", async () => {
    pryvaFetch.mockImplementation(async (_cfg, _m, path: string) => {
      if (path === "/pipeline/mouth") {
        return { polished: PROMISE };
      }
      return null;
    });
    noteToolCall("run-did-work", "image_gen");
    const pipeline = makePipeline({ flowId: "fl-real" });

    const result = await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
      runId: "run-did-work",
    } as never);

    expect(result?.content).toBe(PROMISE);
    expect(calls().some((c) => c.body?.step_name === "ocw_empty_promise_blocked")).toBe(false);
  });
});
