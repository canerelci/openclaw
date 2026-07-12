/**
 * Thin Office Room REST/websocket client used by gateway, presence, and
 * outbound delivery code.
 */
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { WebSocket } from "ws";
import type {
  OfficeRoomMessage,
  OfficeRoomParticipant,
  OfficeRoomStatus,
  OfficeRoomAttachment,
} from "./types.js";

type ClientOptions = {
  baseUrl: string;
  projectId: string;
  /** Optional: the engine ships without auth; when set, sent as a bearer token. */
  token?: string;
  fetch?: typeof fetch;
};

const OFFICE_ROOM_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

/** Envelope every Office Room REST endpoint wraps its payload in. */
type OfficeRoomEnvelopeResponse<T> = { ok: boolean; data: T; error?: string };

/**
 * Creates a typed client for the Office Room REST + WebSocket API.
 */
export function createOfficeRoomClient(options: ClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetch ?? fetch;
  const projectPath = `/api/projects/${encodeURIComponent(options.projectId)}`;

  function authHeaders(): Record<string, string> {
    // The engine is auth-free today; only send the header when a token exists so
    // an empty config does not put "Bearer " on every request.
    return options.token ? { Authorization: `Bearer ${options.token}` } : {};
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestHeaders = new Headers(init.headers);
    requestHeaders.set("Accept", "application/json");
    for (const [key, value] of Object.entries(authHeaders())) {
      requestHeaders.set(key, value);
    }
    if (init.body && !(init.body instanceof FormData)) {
      requestHeaders.set("Content-Type", "application/json");
    }
    const response = await fetcher(`${baseUrl}${path}`, { ...init, headers: requestHeaders });
    if (!response.ok) {
      const detail = await readResponseTextLimited(response, OFFICE_ROOM_ERROR_BODY_LIMIT_BYTES);
      throw new Error(`Office Room ${response.status}: ${detail}`);
    }
    const payload = (await response.json()) as OfficeRoomEnvelopeResponse<T>;
    if (payload && typeof payload === "object" && "ok" in payload) {
      if (!payload.ok) {
        throw new Error(`Office Room request failed: ${payload.error ?? "unknown error"}`);
      }
      return payload.data;
    }
    return payload as unknown as T;
  }

  return {
    join: async (participant: {
      name: string;
      kind: string;
      role: string;
      repoPath?: string;
      summonedBy?: string;
      purpose?: string;
      status?: OfficeRoomStatus;
      online?: boolean;
    }): Promise<OfficeRoomParticipant> =>
      await request<OfficeRoomParticipant>(`${projectPath}/room/join`, {
        method: "POST",
        body: JSON.stringify({
          name: participant.name,
          kind: participant.kind,
          role: participant.role,
          repo_path: participant.repoPath,
          summoned_by: participant.summonedBy,
          purpose: participant.purpose,
          status: participant.status ?? "idle",
          online: participant.online ?? true,
        }),
      }),

    presence: async (
      name: string,
      presence: { online: boolean; status: OfficeRoomStatus },
    ): Promise<void> => {
      await request<unknown>(
        `${projectPath}/room/participants/${encodeURIComponent(name)}/presence`,
        { method: "POST", body: JSON.stringify(presence) },
      );
    },

    participants: async (): Promise<OfficeRoomParticipant[]> =>
      await request<OfficeRoomParticipant[]>(`${projectPath}/room/participants`),

    messages: async (params: {
      limit?: number;
      sinceId?: number;
      beforeId?: number;
    }): Promise<OfficeRoomMessage[]> => {
      const query = new URLSearchParams();
      if (params.limit != null) {
        query.set("limit", String(params.limit));
      }
      if (params.sinceId != null) {
        query.set("since_id", String(params.sinceId));
      }
      if (params.beforeId != null) {
        query.set("before_id", String(params.beforeId));
      }
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return await request<OfficeRoomMessage[]>(`${projectPath}/room/messages${suffix}`);
    },

    sendMessage: async (message: {
      fromName: string;
      body: string;
      mentions?: string[];
      urgency?: "normal" | "urgent";
      todoRef?: string;
      replyToId?: number;
      attachmentIds?: string[];
    }): Promise<OfficeRoomMessage> =>
      await request<OfficeRoomMessage>(`${projectPath}/room/messages`, {
        method: "POST",
        body: JSON.stringify({
          from_name: message.fromName,
          body: message.body,
          mentions: message.mentions ?? [],
          urgency: message.urgency ?? "normal",
          todo_ref: message.todoRef,
          reply_to_id: message.replyToId,
          attachment_ids: message.attachmentIds,
        }),
      }),

    react: async (messageId: number, fromName: string, emoji: string): Promise<void> => {
      await request<unknown>(
        `${projectPath}/room/messages/${encodeURIComponent(String(messageId))}/reactions`,
        { method: "POST", body: JSON.stringify({ from_name: fromName, emoji }) },
      );
    },

    uploadAttachment: async (file: Blob, filename: string): Promise<OfficeRoomAttachment> => {
      const form = new FormData();
      form.append("file", file, filename);
      return await request<OfficeRoomAttachment>(`${projectPath}/room/attachments`, {
        method: "POST",
        body: form,
      });
    },

    websocket: (): WebSocket => {
      const url = new URL(`${baseUrl}/ws/projects/${encodeURIComponent(options.projectId)}/room`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url, { headers: authHeaders() });
    },
  };
}

/** Client shape returned by `createOfficeRoomClient`. */
export type OfficeRoomClient = ReturnType<typeof createOfficeRoomClient>;
