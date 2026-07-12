/**
 * Outbound Office Room delivery: turns an agent reply into a room message with
 * the mention contract the engine expects.
 */
import { resolveOfficeRoomAccount } from "./accounts.js";
import { createOfficeRoomClient } from "./http-client.js";
import { parseOfficeRoomTarget } from "./target.js";
import type { CoreConfig, OfficeRoomMessage } from "./types.js";

/** Mentions the engine parses out of a body, e.g. `@Mira` -> `Mira`. */
function extractBodyMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/(^|\s)@([\w.-]+)/g)) {
    const name = match[2];
    if (name) {
      found.add(name);
    }
  }
  return [...found];
}

/**
 * The room requires a directed message to carry BOTH `mentions:[Name]` and a
 * visible `@Name` in the body. The agent writes prose, so we prepend the
 * mention when it forgot, and always send the explicit mentions array.
 */
export function buildRoomMessageBody(params: { text: string; mentionName?: string }): {
  body: string;
  mentions: string[];
} {
  const text = params.text.trim();
  const bodyMentions = extractBodyMentions(text);
  if (!params.mentionName) {
    return { body: text, mentions: bodyMentions };
  }
  const alreadyMentioned = bodyMentions.some(
    (name) => name.toLowerCase() === params.mentionName?.toLowerCase(),
  );
  const body = alreadyMentioned ? text : `@${params.mentionName} ${text}`;
  const mentions = alreadyMentioned
    ? bodyMentions
    : [params.mentionName, ...bodyMentions.filter((n) => n !== params.mentionName)];
  return { body, mentions };
}

/**
 * Sends text to a normalized Office Room target and returns the created message
 * id for receipt/session tracking.
 */
export async function sendOfficeRoomText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  replyToId?: string | number | null;
  urgency?: "normal" | "urgent";
  todoRef?: string;
}): Promise<{ to: string; messageId: string }> {
  const account = resolveOfficeRoomAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createOfficeRoomClient({
    baseUrl: account.baseUrl,
    projectId: account.projectId,
    token: account.token,
  });
  const parsed = parseOfficeRoomTarget(params.to);
  const { body, mentions } = buildRoomMessageBody({
    text: params.text,
    mentionName: parsed.kind === "dm" ? parsed.id : undefined,
  });
  const replyToId =
    params.replyToId == null ? undefined : Number.parseInt(String(params.replyToId), 10);
  const message: OfficeRoomMessage = await client.sendMessage({
    fromName: account.participantName,
    body,
    mentions,
    urgency: params.urgency ?? "normal",
    todoRef: params.todoRef,
    replyToId: Number.isFinite(replyToId) ? replyToId : undefined,
  });
  return { to: params.to, messageId: String(message.id) };
}
