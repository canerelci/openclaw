/**
 * Converts room messages addressed to this participant into OpenClaw agent
 * replies and routes the resulting text back into the room.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveOfficeRoomInboundAccess, type OfficeRoomInboundAccess } from "./access.js";
import { sendOfficeRoomText } from "./outbound.js";
import { getOfficeRoomRuntime } from "./runtime.js";
import { buildOfficeRoomTarget } from "./target.js";
import type { CoreConfig, OfficeRoomMessage, ResolvedOfficeRoomAccount } from "./types.js";

const CHANNEL_ID = "office-room" as const;

function resolveAccountAgentRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedOfficeRoomAccount;
  peerId: string;
}) {
  const runtime = getOfficeRoomRuntime();
  const peer = { kind: "channel" as const, id: params.peerId };
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer,
  });
  const agentId = params.account.agentId ?? route.agentId;
  if (agentId === route.agentId) {
    return route;
  }
  return {
    ...route,
    agentId,
    sessionKey: runtime.channel.routing.buildAgentSessionKey({
      agentId,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      peer,
    }),
  };
}

/**
 * Dispatches one room message addressed to this participant through the agent.
 * The reply is posted back into the room mentioning the sender, satisfying the
 * room's "directed messages carry a visible @Name" contract.
 */
export async function handleOfficeRoomInbound(params: {
  account: ResolvedOfficeRoomAccount;
  config: CoreConfig;
  message: OfficeRoomMessage;
  access?: OfficeRoomInboundAccess;
}) {
  const runtime = getOfficeRoomRuntime();
  const message = params.message;
  const access =
    params.access ??
    (await resolveOfficeRoomInboundAccess({
      account: params.account,
      config: params.config,
      message,
    }));
  if (!access.shouldDispatch) {
    return;
  }
  // Every room message lives in the one room conversation; the reply target is
  // the sender so the agent answers the participant who addressed it.
  const conversationId = params.account.projectId;
  const replyTarget = buildOfficeRoomTarget({
    chatType: "direct",
    kind: "dm",
    id: message.fromName,
  });
  const route = resolveAccountAgentRoute({
    cfg: params.config as OpenClawConfig,
    account: params.account,
    peerId: conversationId,
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "Office Room",
    from: message.fromName,
    timestamp: new Date(message.createdAt),
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: message.body,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.body,
    RawBody: message.body,
    CommandBody: message.body,
    From: replyTarget,
    To: replyTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: "group",
    // The gateway only dispatches addressed messages, so the agent always sees a
    // mention — room chatter between other participants never reaches here.
    WasMentioned: true,
    ConversationLabel: params.account.projectId,
    GroupChannel: conversationId,
    NativeChannelId: conversationId,
    SenderName: message.fromName,
    SenderId: message.fromName,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(message.id),
    MessageSidFull: String(message.id),
    ReplyToId: String(message.id),
    Timestamp: message.createdAt,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: replyTarget,
    CommandAuthorized: access.commandAuthorized,
  });
  await runtime.channel.inbound.dispatchReply({
    cfg: params.config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    toolsAllow: params.account.toolsAllow,
    delivery: {
      deliver: async (payload) => {
        const text =
          payload && typeof payload === "object" && "text" in payload
            ? ((payload as { text?: string }).text ?? "")
            : "";
        if (!text.trim()) {
          return;
        }
        await sendOfficeRoomText({
          cfg: params.config,
          accountId: params.account.accountId,
          to: replyTarget,
          text,
          replyToId: message.id,
          todoRef: message.todoRef ?? undefined,
        });
      },
      onError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`office-room dispatch failed: ${String(error)}`);
      },
    },
    replyPipeline: {},
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`office-room session record failed: ${String(error)}`);
      },
    },
  });
}
