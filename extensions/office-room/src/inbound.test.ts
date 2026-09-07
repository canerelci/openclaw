// Office Room tests cover the inbound dispatch into the agent runtime and the
// reply routed back to the sender.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitReplySessionInitialization,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntry,
} from "../../../src/config/sessions/session-accessor.js";
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

describe("C656: deterministic session init race window", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:office-room:channel:midmen";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-c656-race-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("a write between snapshot and commit produces stale-snapshot — the exact race that caused 'reply session initialization conflicted'", async () => {
    // Step 1: Seed a session entry (the seat has an existing session).
    await upsertSessionEntry(
      { sessionKey, storePath },
      { sessionId: "existing-session", updatedAt: 100 },
    );

    // Step 2: Take the initialization snapshot (this is session.ts:409).
    // In the real path, initSessionState reads the snapshot here.
    const snapshot = loadReplySessionInitializationSnapshot({ sessionKey, storePath });
    expect(snapshot.currentEntry).toBeDefined();

    // Step 3: Simulate the fire-and-forget meta task completing between
    // snapshot (:409) and commit (:823). In the old code, trackSessionMetaTask
    // fired recordSessionMetaFromInbound which does runExclusiveSessionStoreWrite
    // — it mutates the session entry (updatedAt, sender metadata, etc.).
    await upsertSessionEntry(
      { sessionKey, storePath },
      { sessionId: "existing-session", updatedAt: 200, model: "claude-sonnet-4-6" },
    );

    // Step 4: Attempt the commit (this is session.ts:823).
    // The revision no longer matches because the meta task changed the entry.
    const committed = await commitReplySessionInitialization({
      activeSessionKey: sessionKey,
      agentId: "main",
      expectedRevision: snapshot.revision,
      sessionEntry: { sessionId: "new-session", updatedAt: 300 },
      sessionKey,
      storePath,
    });

    // This is the stale-snapshot rejection. In initSessionState, this happens
    // twice (retry once at :861, then throw at :863), producing exactly:
    //   "reply session initialization conflicted for agent:main:office-room:channel:midmen"
    expect(committed).toMatchObject({
      ok: false,
      reason: "stale-snapshot",
    });
  });

  it("without afterRecord the meta task is unblocked during the snapshot-commit window", async () => {
    // This proves the mechanism at the extension level: without afterRecord,
    // a slow meta task is still running when dispatch would proceed to
    // initSessionState, creating the window demonstrated in the test above.
    dispatchReplyMock.mockReset();
    setOfficeRoomRuntime(createRuntime());

    await handleOfficeRoomInbound({
      account: createAccount(),
      config: {} as CoreConfig,
      message: createMessage(),
      access: { shouldDispatch: true, commandAuthorized: true },
    });

    const params = dispatchReplyMock.mock.calls[0]?.[0] as {
      record: { trackSessionMetaTask?: (task: Promise<unknown>) => void };
      afterRecord?: () => Promise<void>;
    };

    let metaResolved = false;
    const metaTask = new Promise<void>((resolve) => {
      setTimeout(() => {
        metaResolved = true;
        resolve();
      }, 50);
    });

    // Fire the meta task (old code path: fire-and-forget, no afterRecord).
    params.record.trackSessionMetaTask!(metaTask);

    // Without calling afterRecord, the meta task is still running —
    // this is the window where it would write to the session store
    // and invalidate the snapshot's revision.
    expect(metaResolved).toBe(false);

    // With afterRecord (the fix), the task completes before proceeding.
    await params.afterRecord!();
    expect(metaResolved).toBe(true);
  });
});

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

  it("awaits the session meta task before dispatch via afterRecord", async () => {
    dispatchReplyMock.mockReset();
    setOfficeRoomRuntime(createRuntime());

    await handleOfficeRoomInbound({
      account: createAccount(),
      config: {} as CoreConfig,
      message: createMessage(),
      access: { shouldDispatch: true, commandAuthorized: true },
    });

    const params = dispatchReplyMock.mock.calls[0]?.[0] as {
      record: { trackSessionMetaTask?: (task: Promise<unknown>) => void };
      afterRecord?: () => Promise<void>;
    };
    expect(params.record.trackSessionMetaTask).toBeTypeOf("function");
    expect(params.afterRecord).toBeTypeOf("function");

    let metaResolved = false;
    const metaTask = new Promise<void>((resolve) => {
      setTimeout(() => {
        metaResolved = true;
        resolve();
      }, 10);
    });
    params.record.trackSessionMetaTask!(metaTask);
    await params.afterRecord!();
    expect(metaResolved).toBe(true);
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
