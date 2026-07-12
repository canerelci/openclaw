// Office Room tests cover gateway join/presence, mention gating, backfill, urgent
// steering, and dismiss shutdown.
import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeRoomMessage, ResolvedOfficeRoomAccount } from "./types.js";

class FakeSocket extends EventEmitter {
  close = vi.fn(() => {
    this.emit("close");
  });
}

const mocks = vi.hoisted(() => ({
  client: {
    join: vi.fn(),
    presence: vi.fn(),
    messages: vi.fn(),
    sendMessage: vi.fn(),
    websocket: vi.fn(),
  },
  handleOfficeRoomInbound: vi.fn(),
  resolveOfficeRoomInboundAccess: vi.fn(),
}));

vi.mock("./access.js", async () => {
  const actual = await vi.importActual<typeof import("./access.js")>("./access.js");
  return {
    isAddressedToParticipant: actual.isAddressedToParticipant,
    resolveOfficeRoomInboundAccess: mocks.resolveOfficeRoomInboundAccess,
  };
});

vi.mock("./http-client.js", () => ({
  createOfficeRoomClient: vi.fn(() => mocks.client),
}));

vi.mock("./inbound.js", () => ({
  handleOfficeRoomInbound: mocks.handleOfficeRoomInbound,
}));

import { startOfficeRoomGatewayAccount } from "./gateway.js";

function roomMessage(overrides: Partial<OfficeRoomMessage>): OfficeRoomMessage {
  return {
    id: 1,
    projectId: "organ-bank",
    fromName: "Mira",
    mentions: [],
    urgency: "normal",
    body: "",
    reactions: [],
    attachments: [],
    createdAt: "2026-07-12T18:00:00.000Z",
    ...overrides,
  };
}

function frame(message: OfficeRoomMessage): Buffer {
  return Buffer.from(JSON.stringify({ type: "room", event: { type: "message", message } }));
}

function createGatewayContext(
  abortSignal: AbortSignal,
): ChannelGatewayContext<ResolvedOfficeRoomAccount> {
  return {
    cfg: {
      channels: {
        "office-room": {
          baseUrl: "http://127.0.0.1:4319",
          projectId: "organ-bank",
          participantName: "Pryva",
          leadName: "Mira",
          reconnectMs: 100,
        },
      },
    } as ChannelGatewayContext<ResolvedOfficeRoomAccount>["cfg"],
    accountId: "default",
    account: { accountId: "default" } as ResolvedOfficeRoomAccount,
    runtime: {} as ChannelGatewayContext<ResolvedOfficeRoomAccount>["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () =>
      ({ accountId: "default" }) as ReturnType<
        ChannelGatewayContext<ResolvedOfficeRoomAccount>["getStatus"]
      >,
    setStatus: vi.fn(),
  };
}

describe("Office Room gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.join.mockResolvedValue({ name: "Pryva" });
    mocks.client.presence.mockResolvedValue(undefined);
    mocks.client.messages.mockResolvedValue([]);
    mocks.client.sendMessage.mockResolvedValue({ id: 1 });
    mocks.resolveOfficeRoomInboundAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
  });

  it("joins the room as the configured participant", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));

    await vi.waitFor(() => expect(mocks.client.join).toHaveBeenCalledTimes(1));
    expect(mocks.client.join).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Pryva", kind: "openclaw", role: "product-owner" }),
    );

    abort.abort();
    await run;
  });

  it("dispatches only messages addressed to the participant", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit("message", frame(roomMessage({ id: 2, mentions: ["Iris"], body: "@Iris ping" })));
    socket.emit(
      "message",
      frame(roomMessage({ id: 3, mentions: ["Pryva"], body: "@Pryva take T42" })),
    );

    await vi.waitFor(() => expect(mocks.handleOfficeRoomInbound).toHaveBeenCalledTimes(1));
    expect(mocks.handleOfficeRoomInbound.mock.calls[0]?.[0].message.id).toBe(3);

    abort.abort();
    await run;
  });

  it("ignores its own messages so a reply cannot loop back into a turn", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      frame(roomMessage({ id: 4, fromName: "Pryva", mentions: ["Pryva"], body: "@Pryva self" })),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(mocks.handleOfficeRoomInbound).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("runs an urgent message before routine work already queued behind it", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const order: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      mocks.handleOfficeRoomInbound.mockImplementation(
        async (params: { message: OfficeRoomMessage }) => {
          order.push(params.message.id);
          if (params.message.id === 10) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirst = release;
            });
          }
        },
      );
    });
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      frame(roomMessage({ id: 10, mentions: ["Pryva"], body: "@Pryva first" })),
    );
    await firstStarted;

    socket.emit(
      "message",
      frame(roomMessage({ id: 11, mentions: ["Pryva"], body: "@Pryva routine" })),
    );
    socket.emit(
      "message",
      frame(roomMessage({ id: 12, mentions: ["Pryva"], urgency: "urgent", body: "@Pryva stop" })),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    releaseFirst?.();

    // The urgent message jumps the queue and drops the unstarted routine one.
    await vi.waitFor(() => expect(order).toEqual([10, 12]));

    abort.abort();
    await run;
  });

  it("backfills messages missed while the socket was down", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    mocks.client.messages
      .mockResolvedValueOnce([roomMessage({ id: 40 })])
      .mockResolvedValueOnce([
        roomMessage({ id: 41, mentions: ["Pryva"], body: "@Pryva missed this" }),
      ]);
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit("open");

    await vi.waitFor(() => expect(mocks.handleOfficeRoomInbound).toHaveBeenCalledTimes(1));
    // Backfill resumes from the highest id seen in the startup backlog, so the
    // startup message is not replayed and the missed one is.
    expect(mocks.client.messages).toHaveBeenLastCalledWith(
      expect.objectContaining({ sinceId: 40 }),
    );
    expect(mocks.handleOfficeRoomInbound.mock.calls[0]?.[0].message.id).toBe(41);

    abort.abort();
    await run;
  });

  it("shuts down and marks itself dead on a dismiss naming this participant", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const run = startOfficeRoomGatewayAccount(createGatewayContext(abort.signal));
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "room", event: { type: "dismiss", name: "Pryva" } })),
    );

    await run;
    expect(mocks.client.presence).toHaveBeenLastCalledWith("Pryva", {
      online: false,
      status: "dead",
    });
  });

  it("ignores the subscribe control frame without warning", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startOfficeRoomGatewayAccount(ctx);
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    // The engine opens every room stream with this control frame; it carries no
    // `event` and must not be reported as malformed.
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "subscribed", topic: "room", projectId: "organ-bank" })),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(ctx.log?.warn).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("skips malformed frames without tearing down the socket", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startOfficeRoomGatewayAccount(ctx);
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit("message", Buffer.from("{not json"));
    await vi.waitFor(() => expect(ctx.log?.warn).toHaveBeenCalled());
    expect(mocks.handleOfficeRoomInbound).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });
});
