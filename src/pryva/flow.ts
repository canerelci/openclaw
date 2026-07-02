/**
 * Flow-id generation + outbound flow handoff.
 *
 * A "flow" is one request's journey through the whole system; a single flow id
 * (`fl-<12 hex>`) travels from inbound message through Ear/Cortex/Mouth, every
 * LLM turn, and every backend call. The id is minted on inbound and threaded via
 * the per-conversation pipeline context.
 */

/** Mint a new flow id: `fl-` + 12 lowercase hex chars. */
export function generateFlowId(): string {
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 6; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return "fl-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hands a flow id from `message_sending` to `message_sent` for one outbound
 * delivery, keyed by "channel:recipient". Bridges the two hooks so an outbound
 * message keeps the same flow id across both.
 */
export class OutboundFlowHandoff {
  private readonly map = new Map<string, { flowId: string; ts: number }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 2 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  private key(channel: string | undefined, recipient: string | undefined): string {
    return `${channel || ""}:${recipient || ""}`;
  }

  set(channel: string | undefined, recipient: string | undefined, flowId: string): void {
    this.map.set(this.key(channel, recipient), { flowId, ts: Date.now() });
  }

  take(channel: string | undefined, recipient: string | undefined): string | null {
    const k = this.key(channel, recipient);
    const entry = this.map.get(k);
    if (!entry) {
      return null;
    }
    this.map.delete(k);
    if (Date.now() - entry.ts > this.ttlMs) {
      return null;
    }
    return entry.flowId;
  }

  cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, e] of this.map) {
      if (e.ts < cutoff) {
        this.map.delete(k);
      }
    }
  }
}
