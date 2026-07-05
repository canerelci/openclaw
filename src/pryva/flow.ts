/**
 * Flow-id generation.
 *
 * A "flow" is one request's journey through the whole system; a single flow id
 * (`fl-<12 hex>`) travels from the inbound message through Ear/Cortex/Mouth, every
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
