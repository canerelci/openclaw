/**
 * Allowed-group messages that mention gating skipped.
 *
 * Posts /pipeline/group-listen and returns. No flow id, no flow_start, no agent
 * run. Fail-open: a dropped listen is a missed observation, not a leaked send.
 */

import type { PluginHookGroupMessageObservedEvent } from "../plugins/hook-message.types.js";
import { pryvaFetch } from "./backend.js";
import type { PryvaPipeline } from "./pipeline.js";

const LISTEN_TIMEOUT_MS = 2_000;
const DEDUP_MS = 5 * 60 * 1000;
const MAX_DEDUP_KEYS = 500;

const seenAt = new Map<string, number>();
const groupNames = new Map<string, string>();

function groupNameKey(channel: string, groupId: string): string {
  return `${channel.trim().toLowerCase()}:${groupId.trim()}`;
}

/** Remember a group title from a listen or an inbound turn. The outbound gate sends it when set. */
export function rememberGroupName(
  channel: string | undefined,
  groupId: string | undefined,
  name: string | undefined,
): void {
  const trimmed = name?.trim();
  if (!channel?.trim() || !groupId?.trim() || !trimmed) {
    return;
  }
  groupNames.set(groupNameKey(channel, groupId), trimmed);
}

export function rememberedGroupName(
  channel: string | undefined,
  groupId: string | undefined,
): string | undefined {
  if (!channel?.trim() || !groupId?.trim()) {
    return undefined;
  }
  return groupNames.get(groupNameKey(channel, groupId));
}

export function resetGroupListenDedupForTests(): void {
  seenAt.clear();
  groupNames.clear();
}

function remember(key: string, now: number): boolean {
  const previous = seenAt.get(key);
  if (previous !== undefined && now - previous < DEDUP_MS) {
    return false;
  }
  seenAt.set(key, now);
  if (seenAt.size > MAX_DEDUP_KEYS) {
    for (const [entry, at] of seenAt) {
      if (now - at >= DEDUP_MS) {
        seenAt.delete(entry);
      }
    }
  }
  return true;
}

function toIsoTimestamp(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const ms = value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export async function onGroupMessageObserved(
  pipeline: PryvaPipeline,
  event: PluginHookGroupMessageObservedEvent,
): Promise<void> {
  const channel = event.channel?.trim();
  const groupId = event.groupId?.trim();
  const sessionKey = event.sessionKey?.trim();
  if (!channel || !groupId || !sessionKey) {
    return;
  }
  const messageId = event.messageId?.trim();
  const dedupKey = messageId
    ? `${channel}:${groupId}:${messageId}`
    : `${channel}:${groupId}:${event.senderId ?? ""}:${event.text ?? ""}`;
  rememberGroupName(channel, groupId, event.groupName);
  if (!remember(dedupKey, Date.now())) {
    return;
  }
  await pryvaFetch(
    pipeline.cfg,
    "POST",
    "/pipeline/group-listen",
    {
      channel,
      group_id: groupId,
      group_name: event.groupName?.trim() || undefined,
      group_session_key: sessionKey,
      message_id: messageId || undefined,
      sender_id: event.senderId?.trim() || undefined,
      sender_name: event.senderName?.trim() || undefined,
      text: event.text ?? "",
      has_media: event.hasMedia === true,
      timestamp: toIsoTimestamp(event.timestamp),
    },
    { timeoutMs: LISTEN_TIMEOUT_MS },
  );
}
