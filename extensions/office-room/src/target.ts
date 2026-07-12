/**
 * Parser and formatter for Office Room outbound target strings.
 *
 * The room has exactly one conversation, so targets only distinguish a
 * broadcast post (`room`) from a directed post that mentions one participant
 * (`dm:<Name>`). A directed post is still a room message — the room has no
 * private transport — it just carries an explicit mention.
 */
import type { OfficeRoomTarget } from "./types.js";

/** Parses `room`, `dm:<Name>`, or a bare participant name. */
export function parseOfficeRoomTarget(raw: string): OfficeRoomTarget {
  const value = raw.trim();
  if (!value) {
    throw new Error("Office Room target is required");
  }
  const stripped = value.replace(/^(office-room|room):(?=dm:)/i, "");
  const [prefix, ...rest] = stripped.split(":");
  const body = rest.join(":").trim();
  if (/^(room|office-room)$/i.test(stripped)) {
    return { chatType: "group", kind: "room", id: "room" };
  }
  if (/^dm$/i.test(prefix) && body) {
    return { chatType: "direct", kind: "dm", id: body.replace(/^@/, "") };
  }
  if (!body) {
    // Bare participant name (`Mira`, `@Mira`) is a directed message.
    return { chatType: "direct", kind: "dm", id: stripped.replace(/^@/, "") };
  }
  throw new Error(`Unsupported Office Room target: ${raw}`);
}

/** Formats a parsed Office Room target back into canonical target syntax. */
export function buildOfficeRoomTarget(target: OfficeRoomTarget): string {
  return target.kind === "room" ? "room" : `dm:${target.id}`;
}

/** Normalizes user-entered Office Room target text for channel routing. */
export function normalizeOfficeRoomTarget(raw: string): string {
  return buildOfficeRoomTarget(parseOfficeRoomTarget(raw));
}

/** Reports whether a target string can be offered to the Office Room parser. */
export function looksLikeOfficeRoomTarget(raw: string): boolean {
  return raw.trim().length > 0;
}
