// Optional external gate that lets a backend veto a heartbeat before any prompt
// or LLM work happens. Kept in its own module so the HTTP call is trivially
// unit-testable with an injected fetch implementation.

/** Skip reason used when the preflight endpoint could not be consulted. */
export const HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON = "preflight-unreachable";

/** Skip reason prefix applied when the endpoint explicitly denied the run. */
export const HEARTBEAT_PREFLIGHT_SKIP_PREFIX = "preflight:";

/** Default request timeout for the preflight probe. */
export const DEFAULT_HEARTBEAT_PREFLIGHT_TIMEOUT_MS = 3000;

export type HeartbeatPreflightDecision = { run: true } | { run: false; reason: string };

export type ResolveHeartbeatPreflightDecisionParams = {
  /** Absolute http(s) URL of the preflight endpoint. */
  url: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Request timeout in milliseconds (default 3000). */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Optional warning sink; receives (message, meta) on fail-closed outcomes. */
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
};

function denied(reason: string): HeartbeatPreflightDecision {
  return { run: false, reason };
}

/**
 * Ask the configured backend whether this heartbeat should run.
 *
 * Expected response body: `{ "run": boolean, "reason"?: string }`.
 *
 * Fails CLOSED: any network error, timeout, non-2xx status, or unparsable body
 * denies the run with {@link HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON}. If the
 * backend is down, everything the heartbeat could usefully do is down too, so
 * running would only burn tokens.
 */
export async function resolveHeartbeatPreflightDecision(
  params: ResolveHeartbeatPreflightDecisionParams,
): Promise<HeartbeatPreflightDecision> {
  const url = typeof params.url === "string" ? params.url.trim() : "";
  if (!url) {
    return { run: true };
  }
  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? params.timeoutMs
      : DEFAULT_HEARTBEAT_PREFLIGHT_TIMEOUT_MS;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    params.onWarn?.("heartbeat: preflight unavailable (no fetch implementation)", { url });
    return denied(HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = typeof params.token === "string" ? params.token.trim() : "";
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      params.onWarn?.("heartbeat: preflight returned non-2xx; skipping heartbeat", {
        url,
        error: `HTTP ${res.status}`,
      });
      return denied(HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      params.onWarn?.("heartbeat: preflight body was not valid JSON; skipping heartbeat", {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return denied(HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON);
    }
    if (!body || typeof body !== "object" || typeof (body as { run?: unknown }).run !== "boolean") {
      params.onWarn?.("heartbeat: preflight body missing boolean `run`; skipping heartbeat", {
        url,
        error: "invalid preflight payload",
      });
      return denied(HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON);
    }
    const payload = body as { run: boolean; reason?: unknown };
    if (payload.run) {
      return { run: true };
    }
    const rawReason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    return denied(`${HEARTBEAT_PREFLIGHT_SKIP_PREFIX}${rawReason || "denied"}`);
  } catch (err) {
    const aborted = controller.signal.aborted;
    params.onWarn?.(
      aborted
        ? "heartbeat: preflight timed out; skipping heartbeat"
        : "heartbeat: preflight request failed; skipping heartbeat",
      {
        url,
        error: aborted
          ? `timeout after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      },
    );
    return denied(HEARTBEAT_PREFLIGHT_UNREACHABLE_REASON);
  } finally {
    clearTimeout(timer);
  }
}
