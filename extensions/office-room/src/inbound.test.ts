// Office Room tests cover the inbound dispatch into the agent runtime and the
// reply routed back to the sender.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { handleOfficeRoomInbound } from "./inbound.js";
import { setOfficeRoomRuntime } from "./runtime.js";
import type { CoreConfig, OfficeRoomMessage, ResolvedOfficeRoomAccount } from "./types.js";

const sendOfficeRoomTextMock = vi.hoisted(() => vi.fn());

vi.mock("./outbound.js", () => ({
  sendOfficeRoomText: sendOfficeRoomTextMock,
}));

const dispatchReplyMock = vi.fn<(params: Record<string, unknown>) => Promise<void>>();

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    channel: {
      routing: {
        resolveAgentRoute({
          accountId,
          peer,
        }: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) {
          return {
            agentId: "main",
            channel: "office-room",
            accountId: accountId ?? "default",
            sessionKey: `agent:main:office-room:${peer?.id ?? "room"}`,
            mainSessionKey: "agent:main:main",
            lastRoutePolicy: "session",
            matchedBy: "default",
          };
        },
      },
      inbound: {
        dispatchReply: dispatchReplyMock,
      },
    },
  } as unknown as PluginRuntime);
}

function createAccount(
  overrides: Partial<ResolvedOfficeRoomAccount> = {},
): ResolvedOfficeRoomAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:4319",
    token: "",
    projectId: "organ-bank",
    participantName: "Pryva",
    participantKind: "openclaw",
    role: "product-owner",
    leadName: "Mira",
    defaultTo: "dm:Mira",
    allowFrom: ["*"],
    reconnectMs: 1_500,
    historyLimit: 100,
    config: { allowFrom: ["*"] },
    ...overrides,
  };
}

function createMessage(overrides: Partial<OfficeRoomMessage> = {}): OfficeRoomMessage {
  return {
    id: 123,
    projectId: "organ-bank",
    fromName: "Mira",
    mentions: ["Pryva"],
    urgency: "normal",
    body: "@Pryva take T42 and report back.",
    todoRef: "T42",
    reactions: [],
    attachments: [],
    createdAt: "2026-07-12T18:00:00.000Z",
    ...overrides,
  };
}

describe("handleOfficeRoomInbound", () => {
  it("dispatches an addressed room message and replies to the sender in the room", async () => {
    dispatchReplyMock.mockReset();
    sendOfficeRoomTextMock.mockReset();
    setOfficeRoomRuntime(createRuntime());
    const config = {} as CoreConfig;

    await handleOfficeRoomInbound({
      account: createAccount(),
      config,
      message: createMessage(),
      access: { shouldDispatch: true, commandAuthorized: true },
    });

    expect(dispatchReplyMock).toHaveBeenCalledTimes(1);
    const params = dispatchReplyMock.mock.calls[0]?.[0] as {
      channel: string;
      ctxPayload: Record<string, unknown>;
      delivery: { deliver: (payload: unknown) => Promise<void> };
    };
    expect(params.channel).toBe("office-room");
    // The reply target is the sender, so the agent answers whoever addressed it.
    expect(params.ctxPayload.From).toBe("dm:Mira");
    expect(params.ctxPayload.SenderName).toBe("Mira");
    expect(params.ctxPayload.WasMentioned).toBe(true);
    expect(params.ctxPayload.MessageSid).toBe("123");

    await params.delivery.deliver({ text: "Reproduced it; patch is in messages.ts." });
    expect(sendOfficeRoomTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "dm:Mira",
        text: "Reproduced it; patch is in messages.ts.",
        replyToId: 123,
        todoRef: "T42",
      }),
    );
  });

  it("does not dispatch when ingress denies the sender", async () => {
    dispatchReplyMock.mockReset();
    setOfficeRoomRuntime(createRuntime());

    await handleOfficeRoomInbound({
      account: createAccount(),
      config: {} as CoreConfig,
      message: createMessage(),
      access: { shouldDispatch: false, commandAuthorized: false },
    });

    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });

  it("skips empty agent output instead of posting a content-free room message", async () => {
    dispatchReplyMock.mockReset();
    sendOfficeRoomTextMock.mockReset();
    setOfficeRoomRuntime(createRuntime());

    await handleOfficeRoomInbound({
      account: createAccount(),
      config: {} as CoreConfig,
      message: createMessage(),
      access: { shouldDispatch: true, commandAuthorized: true },
    });
    const params = dispatchReplyMock.mock.calls[0]?.[0] as {
      delivery: { deliver: (payload: unknown) => Promise<void> };
    };

    await params.delivery.deliver({ text: "   " });
    expect(sendOfficeRoomTextMock).not.toHaveBeenCalled();
  });
});
