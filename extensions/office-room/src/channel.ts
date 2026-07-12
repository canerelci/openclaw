/**
 * Office Room channel plugin definition: target parsing, account config, status,
 * gateway startup, and outbound delivery wiring.
 */
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  DEFAULT_ACCOUNT_ID,
  listOfficeRoomAccountIds,
  resolveDefaultOfficeRoomAccountId,
  resolveOfficeRoomAccount,
} from "./accounts.js";
import { officeRoomConfigSchema } from "./config-schema.js";
import { startOfficeRoomGatewayAccount } from "./gateway.js";
import { sendOfficeRoomText } from "./outbound.js";
import {
  buildOfficeRoomTarget,
  looksLikeOfficeRoomTarget,
  normalizeOfficeRoomTarget,
  parseOfficeRoomTarget,
} from "./target.js";
import type { CoreConfig, ResolvedOfficeRoomAccount } from "./types.js";

const CHANNEL_ID = "office-room" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

const officeRoomMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendOfficeRoomText({
        cfg: ctx.cfg as CoreConfig,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId,
      });
      const replyToId = ctx.replyToId ?? undefined;
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: CHANNEL_ID, messageId: result.messageId }],
          replyToId,
          kind: "text",
        }),
      };
    },
  },
});

/**
 * Channel plugin instance registered by the bundled Office Room entry.
 */
export const officeRoomPlugin: ChannelPlugin<ResolvedOfficeRoomAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta,
    capabilities: {
      // The room is a single group conversation. A `dm:<Name>` target is still a
      // room post carrying an explicit mention, not a private transport.
      chatTypes: ["group"],
      threads: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.office-room"] },
    configSchema: officeRoomConfigSchema,
    config: {
      listAccountIds: (cfg) => listOfficeRoomAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveOfficeRoomAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultOfficeRoomAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveOfficeRoomAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveOfficeRoomAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
    },
    messaging: {
      targetPrefixes: ["office-room", "room"],
      normalizeTarget: normalizeOfficeRoomTarget,
      inferTargetChatType: () => "group",
      targetResolver: {
        looksLikeId: looksLikeOfficeRoomTarget,
        hint: "<room|dm:Name>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const account = resolveOfficeRoomAccount({ cfg: cfg as CoreConfig, accountId });
        const parsed = parseOfficeRoomTarget(target);
        // Every target shares the one room conversation, so all outbound routes
        // land on the same session the gateway feeds inbound messages into.
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: { kind: "channel", id: account.projectId },
          chatType: "group",
          from: `office-room:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: buildOfficeRoomTarget(parsed),
        });
      },
      resolveSessionConversation: ({ rawId }) => {
        const parsed = parseOfficeRoomTarget(rawId);
        return {
          id: parsed.kind === "room" ? "room" : parsed.id,
          baseConversationId: parsed.kind === "room" ? "room" : parsed.id,
          parentConversationCandidates: [parsed.kind === "room" ? "room" : parsed.id],
        };
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedOfficeRoomAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      buildChannelSummary: ({ snapshot }) => ({
        ok: snapshot.configured,
        label: snapshot.configured ? "configured" : "missing config",
        detail: snapshot.baseUrl ?? "",
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name ?? account.participantName,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl,
      }),
    }),
    gateway: {
      startAccount: startOfficeRoomGatewayAccount,
    },
    message: officeRoomMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, replyToId }) =>
        await sendOfficeRoomText({
          cfg: cfg as CoreConfig,
          accountId,
          to,
          text,
          replyToId,
        }),
    },
  },
});
