import { afterEach, describe, expect, it, vi } from "vitest";
import { messageSendingHookCancelReason } from "../infra/outbound/deliver-types.js";
import { resetGroupListenDedupForTests, onGroupMessageObserved } from "./group-listen.js";
import { classifyGroupOutboundTarget, decideGroupOutboundGate } from "./group-outbound-gate.js";
import { onMessageSending } from "./pipeline-outbound.js";
import type { PryvaPipeline } from "./pipeline.js";

const cfg = {
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

function pipeline(flowId?: string): PryvaPipeline {
  return {
    cfg,
    log: { debug() {}, warn() {}, info() {}, error() {} },
    ctxStore: { findByRecipient: () => null },
    registry: {
      resolve: () => (flowId ? { flowId, source: "owner_message" } : null),
    },
  } as unknown as PryvaPipeline;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetGroupListenDedupForTests();
});

describe("group listen", () => {
  it("posts each distinct allowed message once and does not attach a flow id", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const event = {
      channel: "whatsapp",
      groupId: "123@g.us",
      groupName: "Launch",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      messageId: "m1",
      senderId: "+111",
      senderName: "Ada",
      text: "ship it",
      hasMedia: false,
      timestamp: 1_700_000_000,
    };

    await onGroupMessageObserved(pipeline(), event);
    await onGroupMessageObserved(pipeline(), event);
    await onGroupMessageObserved(pipeline(), { ...event, messageId: "m2", text: "again" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:9/api/v1/pipeline/group-listen");
    expect(new Headers(init.headers).get("X-Flow-Id")).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({
      channel: "whatsapp",
      group_id: "123@g.us",
      group_session_key: "agent:main:whatsapp:group:123@g.us",
      message_id: "m1",
      text: "ship it",
      has_media: false,
      timestamp: "2023-11-14T22:13:20.000Z",
    });
  });

  it("does not post when the session key or group id is missing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await onGroupMessageObserved(pipeline(), {
      channel: "telegram",
      groupId: "-1001",
      sessionKey: "  ",
      text: "nope",
      hasMedia: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("group outbound gate", () => {
  it("classifies WhatsApp groups and negative Telegram chats only", () => {
    expect(classifyGroupOutboundTarget("whatsapp", "123@g.us")).toEqual({
      channel: "whatsapp",
      groupId: "123@g.us",
    });
    expect(classifyGroupOutboundTarget("whatsapp", "whatsapp:15551212")).toBeNull();
    expect(classifyGroupOutboundTarget("telegram", "telegram:-100123")).toEqual({
      channel: "telegram",
      groupId: "-100123",
    });
    expect(classifyGroupOutboundTarget("telegram", "1511273575")).toBeNull();
    expect(classifyGroupOutboundTarget("discord", "123@g.us")).toBeNull();
  });

  it("refuses when the gate says no, and when the backend is unreachable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ allow: false, reason: "not yet" }))
      .mockRejectedValueOnce(new Error("down"));
    vi.stubGlobal("fetch", fetchMock);

    const denied = await decideGroupOutboundGate(pipeline(), {
      channel: "whatsapp",
      groupId: "123@g.us",
      text: "hello group",
    });
    const unreachable = await decideGroupOutboundGate(pipeline(), {
      channel: "telegram",
      groupId: "-100",
      text: "hello group",
    });

    expect(denied).toEqual({ allow: false, reason: "not yet" });
    expect(unreachable).toEqual({
      allow: false,
      reason: "Group send refused: backend unreachable.",
    });
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(firstInit.headers).get("X-Flow-Id")).toBeNull();
  });

  it("sends the posting turn's flow id and the group name, and never fl-unbound", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ allow: true }))
      .mockResolvedValueOnce(jsonResponse({ allow: false, reason: "held" }))
      .mockResolvedValueOnce(jsonResponse({ allow: true }));
    vi.stubGlobal("fetch", fetchMock);

    await onGroupMessageObserved(pipeline(), {
      channel: "whatsapp",
      groupId: "123@g.us",
      groupName: "Launch",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      messageId: "m-name",
      text: "earlier",
      hasMedia: false,
    });
    await decideGroupOutboundGate(pipeline(), {
      channel: "whatsapp",
      groupId: "123@g.us",
      text: "the answer",
      flowId: "fl-postingturn",
    });
    const fromTurnResult = await onMessageSending(
      pipeline("fl-from-registry"),
      { to: "123@g.us", content: "from the turn" },
      { channelId: "whatsapp" },
    );
    expect(fromTurnResult).toEqual({ cancel: true, cancelReason: "held" });
    await decideGroupOutboundGate(pipeline(), {
      channel: "whatsapp",
      groupId: "123@g.us",
      text: "the answer",
      groupName: "Launch",
      flowId: "fl-unbound",
    });

    const named = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(named[0]).toBe("http://127.0.0.1:9/api/v1/pipeline/group-outbound-gate");
    expect(new Headers(named[1].headers).get("X-Flow-Id")).toBe("fl-postingturn");
    expect(JSON.parse(String(named[1].body))).toMatchObject({
      channel: "whatsapp",
      group_id: "123@g.us",
      text: "the answer",
    });
    const fromTurn = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(new Headers(fromTurn[1].headers).get("X-Flow-Id")).toBe("fl-from-registry");
    expect(JSON.parse(String(fromTurn[1].body)).group_name).toBe("Launch");
    const unbound = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(new Headers(unbound[1].headers).get("X-Flow-Id")).toBeNull();
  });

  it("cancels the message_sending hook with the refusal before delivery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ allow: false, reason: "quiet hours" })),
    );

    const result = await onMessageSending(
      pipeline(),
      { to: "123@g.us", content: "hello group" },
      { channelId: "whatsapp" },
    );

    expect(result).toEqual({ cancel: true, cancelReason: "quiet hours" });
  });

  it("returns the hook refusal the agent should see", () => {
    expect(
      messageSendingHookCancelReason({
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        payloadOutcomes: [
          {
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
            hookEffect: { cancelReason: "quiet hours" },
          },
        ],
      }),
    ).toBe("quiet hours");
    expect(
      messageSendingHookCancelReason({
        status: "suppressed",
        reason: "empty_after_message_sending_hook",
      }),
    ).toBeUndefined();
  });
});
