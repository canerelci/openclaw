/**
 * Gateway loop for the Office Room: registers the participant, backfills missed
 * messages, streams room events over the WebSocket, and keeps presence truthful.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { RawData } from "ws";
import { isAddressedToParticipant, resolveOfficeRoomInboundAccess } from "./access.js";
import { resolveOfficeRoomAccount } from "./accounts.js";
import { createOfficeRoomClient, type OfficeRoomClient } from "./http-client.js";
import { handleOfficeRoomInbound } from "./inbound.js";
import type {
  CoreConfig,
  OfficeRoomEnvelope,
  OfficeRoomEvent,
  OfficeRoomMessage,
  OfficeRoomStatus,
  ResolvedOfficeRoomAccount,
} from "./types.js";

function decodeSocketMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

/**
 * Decodes one socket frame. `undefined` means "not a room event" — the stream
 * also carries control frames such as `{"type":"subscribed"}` that have no
 * `event` and must be skipped silently. `null` means the frame was unparseable
 * and is worth a warning.
 */
function parseRoomEvent(data: RawData): OfficeRoomEvent | null | undefined {
  let envelope: OfficeRoomEnvelope;
  try {
    envelope = JSON.parse(decodeSocketMessage(data)) as OfficeRoomEnvelope;
  } catch {
    return null;
  }
  return envelope?.event ?? undefined;
}

/**
 * Serializes agent turns and lets an `urgent` message jump the queue.
 *
 * The channel runtime owns turn cancellation, so a plugin cannot interrupt a
 * running turn. What it can do is reprioritize what runs NEXT: an urgent message
 * is placed at the head of the pending queue and drops any non-urgent work that
 * has not started, which is the room's "hard steer" contract.
 */
class RoomTurnQueue {
  private pending: Array<{ message: OfficeRoomMessage; urgent: boolean }> = [];
  private draining = false;

  constructor(
    private readonly run: (message: OfficeRoomMessage) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(message: OfficeRoomMessage) {
    const urgent = message.urgency === "urgent";
    if (urgent) {
      // Hard steer: drop queued-but-unstarted routine work and go first.
      this.pending = this.pending.filter((entry) => entry.urgent);
      this.pending.unshift({ message, urgent });
    } else {
      this.pending.push({ message, urgent });
    }
    void this.drain();
  }

  private async drain() {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) {
          break;
        }
        try {
          await this.run(next.message);
        } catch (error) {
          this.onError(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** True while a turn is running or queued — drives room presence. */
  get busy(): boolean {
    return this.draining || this.pending.length > 0;
  }
}

async function safePresence(params: {
  client: OfficeRoomClient;
  account: ResolvedOfficeRoomAccount;
  status: OfficeRoomStatus;
  online: boolean;
  log?: ChannelGatewayContext<ResolvedOfficeRoomAccount>["log"];
}) {
  try {
    await params.client.presence(params.account.participantName, {
      online: params.online,
      status: params.status,
    });
  } catch (error) {
    // Presence is advisory: a failed update must not tear down a healthy room
    // session, and the next update (or rejoin) reconciles it.
    params.log?.warn?.(
      `[${params.account.accountId}] Office Room presence update failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function startOfficeRoomGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedOfficeRoomAccount>,
) {
  const account = resolveOfficeRoomAccount({
    cfg: ctx.cfg,
    accountId: ctx.account.accountId,
  });
  if (!account.configured) {
    throw new Error(`Office Room is not configured for account "${account.accountId}"`);
  }
  const client = createOfficeRoomClient({
    baseUrl: account.baseUrl,
    projectId: account.projectId,
    token: account.token,
  });
  const config = ctx.cfg as CoreConfig;

  let lastSeenId = 0;
  // A room `dismiss` and a gateway abort are the same thing — stop running. Model
  // both as one signal so the socket loop has a single exit condition.
  const stop = new AbortController();
  const stopOnAbort = () => stop.abort();
  ctx.abortSignal.addEventListener("abort", stopOnAbort, { once: true });

  const queue = new RoomTurnQueue(
    async (message) => {
      await safePresence({ client, account, status: "running", online: true, log: ctx.log });
      try {
        await handleOfficeRoomInbound({ account, config, message });
      } finally {
        if (!queue.busy) {
          await safePresence({ client, account, status: "idle", online: true, log: ctx.log });
        }
      }
    },
    (error) => {
      ctx.log?.warn?.(
        `[${account.accountId}] Office Room turn failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    },
  );

  async function considerMessage(message: OfficeRoomMessage) {
    if (message.id > lastSeenId) {
      lastSeenId = message.id;
    }
    if (message.fromName === account.participantName) {
      return;
    }
    if (!isAddressedToParticipant(message, account.participantName)) {
      return;
    }
    const access = await resolveOfficeRoomInboundAccess({ account, config, message });
    if (!access.shouldDispatch) {
      return;
    }
    queue.enqueue(message);
  }

  async function processEvent(event: OfficeRoomEvent) {
    if (event.type === "dismiss") {
      const name = typeof event.name === "string" ? event.name : undefined;
      if (name && name.toLowerCase() === account.participantName.toLowerCase()) {
        stop.abort();
      }
      return;
    }
    if (event.type !== "message") {
      return;
    }
    const message = (event as { message?: OfficeRoomMessage }).message;
    if (!message) {
      return;
    }
    await considerMessage(message);
  }

  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });

  try {
    await client.join({
      name: account.participantName,
      kind: account.participantKind,
      role: account.role,
      repoPath: account.repoPath,
      summonedBy: account.summonedBy,
      purpose: account.purpose,
      status: "idle",
      online: true,
    });

    // First backlog read only establishes the resume cursor: replaying room
    // history into a fresh session would re-answer messages already handled.
    const backlog = await client.messages({ limit: account.historyLimit });
    for (const message of backlog) {
      if (message.id > lastSeenId) {
        lastSeenId = message.id;
      }
    }

    if (account.joinNotice) {
      await client.sendMessage({
        fromName: account.participantName,
        body: account.joinNotice,
        mentions: account.leadName ? [account.leadName] : [],
      });
    }

    while (!stop.signal.aborted) {
      const socket = client.websocket();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let removeStopListener: (() => void) | undefined;
        const finishSocketCycle = () => {
          if (settled) {
            return;
          }
          settled = true;
          removeStopListener?.();
          removeStopListener = undefined;
          resolve();
        };
        const closeSocket = () => {
          socket.close();
          finishSocketCycle();
        };
        // Covers both a gateway abort and a room dismiss: either one closes the
        // socket and ends the loop.
        stop.signal.addEventListener("abort", closeSocket, { once: true });
        removeStopListener = () => stop.signal.removeEventListener("abort", closeSocket);

        socket.on("open", () => {
          // Catch up on anything posted while the socket was down. The engine
          // restarts often enough that a reconnect without backfill silently
          // drops directed work.
          void (async () => {
            const missed = await client.messages({
              sinceId: lastSeenId,
              limit: account.historyLimit,
            });
            for (const message of missed) {
              await considerMessage(message);
            }
          })().catch((error: unknown) => {
            ctx.log?.warn?.(
              `[${account.accountId}] Office Room backfill failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        });

        socket.on("message", (data) => {
          void (async () => {
            const event = parseRoomEvent(data);
            if (event === null) {
              ctx.log?.warn?.(`[${account.accountId}] skipped malformed Office Room event`);
              return;
            }
            if (!event) {
              return;
            }
            await processEvent(event);
          })().catch(reject);
        });

        socket.on("close", finishSocketCycle);
        socket.on("error", (error) => {
          if (settled || stop.signal.aborted) {
            finishSocketCycle();
            return;
          }
          ctx.log?.warn?.(
            `[${account.accountId}] Office Room websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          finishSocketCycle();
          socket.close();
        });
      });

      if (!stop.signal.aborted) {
        await new Promise((resolve) => {
          setTimeout(resolve, account.reconnectMs);
        });
      }
    }
  } finally {
    ctx.abortSignal.removeEventListener("abort", stopOnAbort);
    // Room presence must not keep showing a live participant once the gateway is
    // gone — a ghost row makes the room believe work is being steered.
    await safePresence({ client, account, status: "dead", online: false, log: ctx.log });
    ctx.setStatus({ accountId: account.accountId, running: false });
  }
}
