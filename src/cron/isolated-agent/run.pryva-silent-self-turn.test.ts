// Pins the structural half of the Pryva silent self-turn gate (T347): a self-turn scheduled with
// deliveryMode "none" and NO explicit target must short-circuit to deliveryRequested:false BEFORE
// resolveDeliveryTarget is consulted. That is what makes a silent background turn structurally
// undeliverable: the "last"-channel fallback (resolveMessageChannelSelection → the single configured
// channel, recipient from allowFrom[0]) is never reached, so a tenant with exactly one linked
// channel cannot have a background turn message the owner.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";

const resolveDeliveryTargetMock = vi.hoisted(() => vi.fn());
vi.mock("./run-delivery.runtime.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

import { resolveCronDeliveryContext } from "./run.js";

const CFG = {} as OpenClawConfig;

/** How scheduleSelfWake({ silent: true }) lands as a cron job: mode "none", no explicit target. */
const SILENT_SELF_TURN_JOB = {
  sessionTarget: "session:agent:main:main",
  payload: { kind: "agentTurn" },
  delivery: { mode: "none" },
} as unknown as CronJob;

/** How a normal (announce) self-turn lands: reaches the resolver via the "last" channel. */
const ANNOUNCING_SELF_TURN_JOB = {
  sessionTarget: "session:agent:main:main",
  payload: { kind: "agentTurn" },
  delivery: { mode: "announce" },
} as unknown as CronJob;

describe("resolveCronDeliveryContext — Pryva silent self-turn is structurally undeliverable", () => {
  it("reports deliveryRequested:false and never consults the delivery resolver", async () => {
    resolveDeliveryTargetMock.mockClear();

    const result = await resolveCronDeliveryContext({
      cfg: CFG,
      job: SILENT_SELF_TURN_JOB,
      agentId: "agent-x",
    });

    expect(result.deliveryRequested).toBe(false);
    expect(result.resolvedDelivery.ok).toBe(false);
    // The critical assertion: the single-configured-channel fallback lives inside
    // resolveDeliveryTarget. Never calling it is what makes the turn unable to reach a channel.
    expect(resolveDeliveryTargetMock).not.toHaveBeenCalled();
  });

  it("still resolves delivery for a normal announcing self-turn (no regression)", async () => {
    resolveDeliveryTargetMock.mockClear();
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: true,
      channel: "telegram",
      to: "123",
      mode: "implicit",
    });

    const result = await resolveCronDeliveryContext({
      cfg: CFG,
      job: ANNOUNCING_SELF_TURN_JOB,
      agentId: "agent-x",
    });

    expect(result.deliveryRequested).toBe(true);
    expect(resolveDeliveryTargetMock).toHaveBeenCalledOnce();
  });

  it("honors an explicit target even under mode none (unchanged cron semantics)", async () => {
    resolveDeliveryTargetMock.mockClear();
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: true,
      channel: "telegram",
      to: "explicit-room",
      mode: "explicit",
    });

    const result = await resolveCronDeliveryContext({
      cfg: CFG,
      job: {
        sessionTarget: "session:agent:main:main",
        payload: { kind: "agentTurn" },
        delivery: { mode: "none", channel: "telegram", to: "explicit-room" },
      } as unknown as CronJob,
      agentId: "agent-x",
    });

    expect(resolveDeliveryTargetMock).toHaveBeenCalledOnce();
    expect(result.resolvedDelivery.ok).toBe(true);
  });
});
