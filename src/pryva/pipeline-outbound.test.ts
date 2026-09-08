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

type Binding = { flowId: string; source?: string } | null;

function makePipeline(
  binding: Binding,
  matched: { originalMessage?: string; earPlan?: unknown; flowId?: string } | null = {
    originalMessage: "3. görseli beğenmedim",
    earPlan: null,
    // Default: inbound flow matches the binding so genuine-reply tests still hit Cortex.
    flowId: binding?.flowId,
  },
) {
  return {
    cfg: { pipeline: {} },
    ctxStore: {
      findByRecipient: () => matched,
      findLatest: vi.fn(() => ({
        originalMessage: "UNRELATED office-room inbound — must never be used",
        earPlan: null,
        flowId: "fl-office-room-borrow",
      })),
    },
    registry: {
      resolve: vi.fn(() =>
        binding ? { flowId: binding.flowId, source: binding.source ?? "owner_message" } : null,
      ),
    },
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

  it("falls back to fl-unbound (and warns) only when nothing binds — and skips Cortex", async () => {
    // No binding + no matched flow → fl-unbound attribution on the sending step,
    // but Cortex must NOT run (AND-gate fails; previously this burnt a QA call on
    // system pushes with wrong/empty original_message).
    const pipeline = makePipeline(null, null);
    await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(false);
    const step = calls().find(
      (c) => c.path === "/flows/log-step" && c.body.step_name === "ocw_message_sending",
    );
    expect(step?.opts.flowId).toBe("fl-unbound");
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
    expect(result?.content).toContain("Bu konuda bir güncelleme vermeye çalıştım ama emin değilim");

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

describe("onMessageSending T245 Cortex/Mouth AND-gate", () => {
  const SYSTEM_PUSH =
    "Ekip odasından: Zeytinyağlı enginar tarifi hazır — sahibine ilet, " +
    "bu bir sistem push metni ve QA kararı vermemelisin.";

  it("T496: runs Cortex (but NOT Mouth) for system-source push — proactive owner-facing", async () => {
    const pipeline = makePipeline(
      { flowId: "fl-system", source: "system" },
      { originalMessage: "eski owner mesajı", earPlan: null, flowId: "fl-old-owner" },
    );

    await onMessageSending(pipeline, { to: "telegram:1511273575", content: SYSTEM_PUSH }, {
      channelId: "telegram",
      sessionKey: "agent:main:main",
    } as never);

    // T496: Cortex now runs for proactive owner-facing sources.
    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    // Mouth stays gated on isReplyToMatchedInbound (Sinan 2026-07-11).
    expect(calls().some((c) => c.path === "/pipeline/mouth")).toBe(false);
    // findLatest must NOT be consulted for inbound matching.
    expect(
      (pipeline as unknown as { ctxStore: { findLatest: ReturnType<typeof vi.fn> } }).ctxStore
        .findLatest,
    ).not.toHaveBeenCalled();
  });

  it("skips Cortex when flow-match fails (owner-push inherits old inbound via findByRecipient)", async () => {
    // Same shape as the enginar bug: findByRecipient hits owner's LAST inbound (flow G)
    // but the push binding is a different/system flow → mismatch → skip.
    const pipeline = makePipeline(
      { flowId: "fl-push", source: "owner_message" },
      { originalMessage: "owner old question", earPlan: null, flowId: "fl-old-inbound" },
    );

    await onMessageSending(pipeline, { to: "telegram:1", content: SYSTEM_PUSH }, {
      channelId: "telegram",
      runId: "run-push",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(false);
  });

  it("runs Cortex for a genuine agent reply (source allowlist + flow match)", async () => {
    const pipeline = makePipeline(
      { flowId: "fl-turn", source: "owner_message" },
      { originalMessage: "3. görseli beğenmedim", earPlan: null, flowId: "fl-turn" },
    );

    await onMessageSending(pipeline, { to: "owner", content: HONEST }, {
      channelId: "whatsapp",
      sessionKey: "agent:main:main",
      runId: "run-7",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    expect(calls().find((c) => c.path === "/pipeline/cortex")?.opts.flowId).toBe("fl-turn");
  });

  it("T496: runs Cortex for proactive source even with no inbound match", async () => {
    const pipeline = makePipeline({ flowId: "fl-sys", source: "system" }, null);

    await onMessageSending(pipeline, { to: "telegram:9", content: SYSTEM_PUSH }, {
      channelId: "telegram",
    } as never);

    // T496: proactive owner-facing sources now get Cortex.
    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    // findLatest must NOT be consulted for inbound matching.
    expect(
      (pipeline as unknown as { ctxStore: { findLatest: ReturnType<typeof vi.fn> } }).ctxStore
        .findLatest,
    ).not.toHaveBeenCalled();
  });

  it("skips Cortex when no binding exists (fl-unbound, no source)", async () => {
    // No binding at all → source is undefined → neither reply nor proactive.
    const pipeline = makePipeline(null, null);

    await onMessageSending(pipeline, { to: "telegram:9", content: SYSTEM_PUSH }, {
      channelId: "telegram",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(false);
  });
});

describe("T496: Cortex gate widening for proactive owner-facing sources", () => {
  const PROACTIVE_DRAFT =
    "Hatırlatma: yarınki toplantı için hazırladığım içerik planını onaylamanız gerekiyor.";

  it("runs Cortex for heartbeat source (no matched inbound)", async () => {
    const pipeline = makePipeline({ flowId: "fl-hb", source: "heartbeat" }, null);

    await onMessageSending(pipeline, { to: "owner", content: PROACTIVE_DRAFT }, {
      channelId: "telegram",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    const cortex = calls().find((c) => c.path === "/pipeline/cortex");
    expect(cortex?.body.recipient_is_owner).toBe(true);
    expect(cortex?.body.original_message).toBe("");
  });

  it("runs Cortex for scheduled_todo source (the T435 defect path)", async () => {
    const pipeline = makePipeline({ flowId: "fl-sched", source: "scheduled_todo" }, null);

    await onMessageSending(pipeline, { to: "owner", content: PROACTIVE_DRAFT }, {
      channelId: "telegram",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
  });

  it("runs Cortex for inner_voice source", async () => {
    const pipeline = makePipeline({ flowId: "fl-iv", source: "inner_voice" }, null);

    await onMessageSending(pipeline, { to: "owner", content: PROACTIVE_DRAFT }, {
      channelId: "telegram",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
  });

  it("does NOT run Mouth for proactive source (Sinan 2026-07-11 guard)", async () => {
    const pipeline = makePipeline({ flowId: "fl-hb", source: "heartbeat" }, null);
    // Content with markdown that would trigger needsMouth.
    const MARKDOWN_DRAFT =
      "Hatırlatma: **yarınki toplantı** için içerik planını `onaylayın` — liste hazır.";

    await onMessageSending(pipeline, { to: "owner", content: MARKDOWN_DRAFT }, {
      channelId: "telegram",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    expect(calls().some((c) => c.path === "/pipeline/mouth")).toBe(false);
  });

  it("prefers reply AND-gate over proactive when both could match", async () => {
    // owner_message with matching flow → reply path, NOT proactive.
    const pipeline = makePipeline(
      { flowId: "fl-turn", source: "owner_message" },
      { originalMessage: "nasılsın?", earPlan: null, flowId: "fl-turn" },
    );

    await onMessageSending(pipeline, { to: "owner", content: PROACTIVE_DRAFT }, {
      channelId: "telegram",
      runId: "run-x",
    } as never);

    expect(calls().some((c) => c.path === "/pipeline/cortex")).toBe(true);
    const step = calls().find(
      (c) => c.path === "/flows/log-step" && c.body.step_name === "ocw_message_sending",
    );
    expect(step?.body?.metadata?.is_reply_to_matched_inbound).toBe(true);
    expect(step?.body?.metadata?.is_owner_facing_proactive).toBe(false);
  });
});
