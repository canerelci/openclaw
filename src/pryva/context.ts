/**
 * Per-conversation inbound pipeline context.
 *
 * Tracks the state of the current inbound turn (flow id, Ear plan, original
 * message) so later hooks in the same turn — before_prompt_build (inject Ear
 * plan), message_sending (Cortex/Mouth), telemetry — can correlate back to the
 * inbound message. Channel-agnostic: keyed by conversation id, or channel+sender
 * when no conversation id is supplied.
 */

export type PipelineInboundContext = {
  from: string;
  channel: string;
  conversationId: string | null;
  flowId: string;
  originalMessage: string;
  earPlan: Record<string, unknown> | null;
  earStarted: boolean;
  timestamp: number;
};

const STALE_MS = 10 * 60 * 1000;

function digitsOnly(id: string): string {
  return id.replace(/\D/g, "");
}

export class PipelineContextStore {
  private readonly map = new Map<string, PipelineInboundContext>();

  key(conversationId: string | null | undefined, channel: string, from: string): string {
    return conversationId || `${channel}:${from}`;
  }

  set(key: string, ctx: PipelineInboundContext): void {
    this.map.set(key, ctx);
  }

  get(key: string): PipelineInboundContext | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  entries(): IterableIterator<[string, PipelineInboundContext]> {
    return this.map.entries();
  }

  /**
   * Find the context for an outbound recipient. Exact channel+sender match
   * first, then a digit-fuzzy match (phone numbers vary in formatting across
   * inbound vs. outbound), within a recency window.
   */
  findByRecipient(to: string | undefined, channel?: string): PipelineInboundContext | null {
    if (!to) {
      return null;
    }
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [, ctx] of this.map) {
      if (ctx.timestamp <= cutoff) {
        continue;
      }
      if (ctx.from === to && (!channel || ctx.channel === channel)) {
        return ctx;
      }
    }
    const digits = digitsOnly(to);
    if (digits.length >= 8) {
      for (const [, ctx] of this.map) {
        if (ctx.timestamp <= cutoff || (channel && ctx.channel !== channel)) {
          continue;
        }
        const fromDigits = digitsOnly(ctx.from);
        if (
          fromDigits === digits ||
          fromDigits.endsWith(digits.slice(-10)) ||
          digits.endsWith(fromDigits.slice(-10))
        ) {
          return ctx;
        }
      }
    }
    return null;
  }

  /** Most recent inbound context within the recency window. */
  findLatest(windowMs = 5 * 60 * 1000): PipelineInboundContext | null {
    let best: PipelineInboundContext | null = null;
    const cutoff = Date.now() - windowMs;
    for (const [, ctx] of this.map) {
      if (ctx.timestamp > cutoff && (!best || ctx.timestamp > best.timestamp)) {
        best = ctx;
      }
    }
    return best;
  }

  cleanupStale(onEvict?: (key: string) => void): void {
    const cutoff = Date.now() - STALE_MS;
    for (const [key, ctx] of this.map) {
      if (ctx.timestamp < cutoff) {
        this.map.delete(key);
        onEvict?.(key);
      }
    }
  }
}
