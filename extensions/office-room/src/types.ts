/**
 * Shared Office Room config, runtime account, API object, and target types.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

/** User-configurable settings for one Office Room account. */
export type OfficeRoomAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  token?: unknown;
  projectId?: string;
  participantName?: string;
  participantKind?: string;
  role?: string;
  repoPath?: string;
  purpose?: string;
  leadName?: string;
  summonedBy?: string;
  joinNotice?: string;
  agentId?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  defaultTo?: string;
  allowFrom?: string[];
  reconnectMs?: number;
  historyLimit?: number;
};

/** Root Office Room channel config with optional named accounts. */
export type OfficeRoomConfig = OfficeRoomAccountConfig & {
  accounts?: Record<string, Partial<OfficeRoomAccountConfig>>;
  defaultAccount?: string;
};

/** OpenClaw config narrowed to include Office Room channel settings. */
export type CoreConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    "office-room"?: OfficeRoomConfig;
  };
};

/** Normalized account snapshot consumed by runtime paths. */
export type ResolvedOfficeRoomAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  baseUrl: string;
  token: string;
  projectId: string;
  participantName: string;
  participantKind: string;
  role: string;
  repoPath?: string;
  purpose?: string;
  /**
   * Product Owner contract: the agent speaks with the lead developer only, so
   * broadcast replies are mentioned at the lead unless the turn targets someone
   * else explicitly. Empty means "no lead configured" (broadcast, no mention).
   */
  leadName?: string;
  summonedBy?: string;
  joinNotice?: string;
  agentId?: string;
  timeoutSeconds?: number;
  toolsAllow?: string[];
  defaultTo: string;
  allowFrom: string[];
  reconnectMs: number;
  historyLimit: number;
  config: OfficeRoomAccountConfig;
};

/** Room participant returned by the Office Room REST API. */
export type OfficeRoomParticipant = {
  name: string;
  projectId: string;
  kind: string;
  role: string;
  repoPath?: string | null;
  summonedBy?: string | null;
  purpose?: string | null;
  online: boolean;
  status: string;
  currentTodoRef?: string | null;
  joinedAt: string;
  lastSeenAt: string;
};

/** Reaction rollup attached to a room message. */
export type OfficeRoomReaction = {
  emoji: string;
  fromNames: string[];
  count: number;
};

/** Attachment attached to a room message. */
export type OfficeRoomAttachment = {
  id: string;
  name?: string;
  url?: string;
  contentType?: string;
  size?: number;
};

/**
 * Room message priority. `urgent` is the room's hard-steer signal: it jumps the
 * agent's pending queue and drops routine work that has not started yet.
 */
export type OfficeRoomUrgency = "normal" | "urgent";

/** Message object returned by the Office Room REST API and WebSocket stream. */
export type OfficeRoomMessage = {
  id: number;
  projectId: string;
  fromName: string;
  mentions: string[];
  urgency: OfficeRoomUrgency;
  body: string;
  todoRef?: string | null;
  replyToId?: number | null;
  replyTo?: unknown;
  reactions: OfficeRoomReaction[];
  attachments: OfficeRoomAttachment[];
  createdAt: string;
};

/** Presence change broadcast by the room. */
export type OfficeRoomPresence = {
  name: string;
  online?: boolean;
  status?: string;
};

/**
 * Server-to-client room event. The engine wraps every event in a
 * `{ type: "room", event: {...} }` envelope; this is the inner event.
 */
export type OfficeRoomEvent =
  | { type: "message"; projectId?: string; message: OfficeRoomMessage }
  | { type: "presence"; projectId?: string; presence?: OfficeRoomPresence; name?: string }
  | { type: "participant_joined"; projectId?: string; participant?: OfficeRoomParticipant }
  | { type: "dismiss"; projectId?: string; name?: string }
  | { type: string; projectId?: string; [key: string]: unknown };

/** WebSocket envelope emitted by the room stream. */
export type OfficeRoomEnvelope = {
  type: string;
  event?: OfficeRoomEvent;
};

/** Presence status accepted by the room presence endpoint. */
export type OfficeRoomStatus = "idle" | "running" | "cancelled" | "dead";

/** Parsed outbound destination for Office Room delivery. */
export type OfficeRoomTarget =
  /** Broadcast/mentioned message posted into the room. */
  | { chatType: "group"; kind: "room"; id: string }
  /** Directed message to one participant (still a room post + explicit mention). */
  | { chatType: "direct"; kind: "dm"; id: string };
