/**
 * Fail-closed check before a WhatsApp or Telegram group send leaves.
 *
 * message_sending already runs for message-tool sends. The target's group-ness
 * is not on that event, so this classifies `to` + channel. A direct message is
 * not gated. Timeout, non-2xx, and a missing `allow: true` all refuse.
 */

import { pryvaFetchClosed } from "./backend.js";
import { UNBOUND_FLOW_ID } from "./flow-registry.js";
import type { PryvaPipeline } from "./pipeline.js";

const GATE_TIMEOUT_MS = 3_000;

const TARGET_PREFIXES = ["whatsapp:group:", "telegram:group:", "whatsapp:", "telegram:", "group:"];

export type GroupOutboundTarget = {
  channel: "whatsapp" | "telegram";
  groupId: string;
};

export type GroupOutboundDecision = { allow: true } | { allow: false; reason: string };

function stripTargetPrefixes(to: string): string {
  let value = to.trim();
  let changed = true;
  while (changed) {
    changed = false;
    const lower = value.toLowerCase();
    for (const prefix of TARGET_PREFIXES) {
      if (lower.startsWith(prefix)) {
        value = value.slice(prefix.length).trim();
        changed = true;
        break;
      }
    }
  }
  return value;
}

/** WhatsApp groups keep @g.us. Telegram groups are negative chat ids. */
export function classifyGroupOutboundTarget(
  channelId: string | undefined,
  to: string | undefined,
): GroupOutboundTarget | null {
  if (!to?.trim()) {
    return null;
  }
  const channel = (channelId ?? "").trim().toLowerCase();
  const raw = to.trim();
  const id = stripTargetPrefixes(raw);
  const prefixedWhatsApp = raw.toLowerCase().includes("whatsapp:");
  const prefixedTelegram = raw.toLowerCase().includes("telegram:");
  if ((channel === "whatsapp" || channel === "" || prefixedWhatsApp) && id.endsWith("@g.us")) {
    if (channel === "telegram") {
      return null;
    }
    return { channel: "whatsapp", groupId: id };
  }
  if (channel === "telegram" || (channel === "" && prefixedTelegram) || prefixedTelegram) {
    if (channel !== "" && channel !== "telegram") {
      return null;
    }
    if (!/^-?\d+$/.test(id)) {
      return null;
    }
    const numeric = Number(id);
    if (!Number.isSafeInteger(numeric) || numeric >= 0) {
      return null;
    }
    return { channel: "telegram", groupId: id };
  }
  return null;
}

export async function decideGroupOutboundGate(
  pipeline: PryvaPipeline,
  target: GroupOutboundTarget & { text: string; groupName?: string; flowId?: string },
): Promise<GroupOutboundDecision> {
  const flowId = target.flowId?.trim();
  // fl-unbound is an alarm, not a turn. Sending it would make the backend
  // treat the post as part of a flow that was never started.
  const boundFlowId = flowId && flowId !== UNBOUND_FLOW_ID ? flowId : undefined;
  const groupName = target.groupName?.trim();
  const closed = await pryvaFetchClosed(
    pipeline.cfg,
    "POST",
    "/pipeline/group-outbound-gate",
    {
      channel: target.channel,
      group_id: target.groupId,
      text: target.text,
      ...(groupName ? { group_name: groupName } : {}),
    },
    { timeoutMs: GATE_TIMEOUT_MS, ...(boundFlowId ? { flowId: boundFlowId } : {}) },
  );
  if (!closed.ok) {
    return { allow: false, reason: closed.reason };
  }
  const body = closed.body;
  if (body && typeof body === "object" && (body as { allow?: unknown }).allow === true) {
    return { allow: true };
  }
  const reason = (body as { reason?: unknown } | null)?.reason;
  return {
    allow: false,
    reason: typeof reason === "string" && reason.trim() ? reason.trim() : "Group send refused.",
  };
}
