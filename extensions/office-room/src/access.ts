/**
 * Maps Office Room senders onto the shared channel ingress allowlist/command
 * authorization contract.
 */
import {
  resolveStableChannelMessageIngress,
  type StableChannelIngressIdentityParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getOfficeRoomRuntime } from "./runtime.js";
import type { CoreConfig, OfficeRoomMessage, ResolvedOfficeRoomAccount } from "./types.js";

const CHANNEL_ID = "office-room" as const;

/**
 * Room identity is the participant display name — the room has no user ids, and
 * names are unique per room by engine contract.
 */
function normalizeOfficeRoomParticipant(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = trimmed.replace(/^(office-room|room):/i, "").trim();
  const directTarget = withoutProvider.match(/^dm:(.+)$/i);
  const name = directTarget?.[1]?.trim() || withoutProvider;
  return name.replace(/^@/, "").toLowerCase() || null;
}

const officeRoomIngressIdentity = {
  key: "user-id",
  normalizeEntry: normalizeOfficeRoomParticipant,
  normalizeSubject: normalizeOfficeRoomParticipant,
  isWildcardEntry: (entry) => normalizeOfficeRoomParticipant(entry) === "*",
  entryIdPrefix: "office-room-participant",
} satisfies StableChannelIngressIdentityParams;

/**
 * Dispatch and command authorization decision for one inbound room message.
 */
export type OfficeRoomInboundAccess = {
  shouldDispatch: boolean;
  commandAuthorized: boolean;
};

/**
 * Resolves whether a room message should enter the agent pipeline and whether
 * its command-style body may run tools.
 */
export async function resolveOfficeRoomInboundAccess(params: {
  account: ResolvedOfficeRoomAccount;
  config: CoreConfig;
  message: OfficeRoomMessage;
}): Promise<OfficeRoomInboundAccess> {
  const runtime = getOfficeRoomRuntime();
  const cfg = params.config as OpenClawConfig;
  const shouldCheckCommand = runtime.channel.commands.shouldComputeCommandAuthorized(
    params.message.body,
    cfg,
  );
  const resolved = await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    identity: officeRoomIngressIdentity,
    cfg,
    subject: { stableId: params.message.fromName },
    conversation: { kind: "group", id: params.account.projectId },
    allowFrom: params.account.allowFrom,
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    command: shouldCheckCommand ? { cfg, modeWhenAccessGroupsOff: "configured" } : false,
  });

  return {
    shouldDispatch: resolved.ingress.admission === "dispatch",
    commandAuthorized: resolved.commandAccess.requested
      ? resolved.commandAccess.authorized
      : resolved.senderAccess.allowed,
  };
}

/**
 * True when the message addresses this participant. The engine also parses
 * `@Name` out of the body, so we accept either signal; an unmentioned room
 * message is room chatter between other participants and must not wake the
 * agent.
 */
export function isAddressedToParticipant(
  message: OfficeRoomMessage,
  participantName: string,
): boolean {
  const self = participantName.trim().toLowerCase();
  if (!self) {
    return false;
  }
  if (message.mentions?.some((name) => name.trim().toLowerCase() === self)) {
    return true;
  }
  return new RegExp(`(^|\\s)@${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(
    message.body ?? "",
  );
}
