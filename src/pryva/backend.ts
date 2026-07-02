/**
 * Pryva backend HTTP client (native).
 *
 * Thin, fail-open JSON client used by the native pipeline to reach the Pryva
 * backend (Ear/Cortex/Mouth, flow logging, usage, message ingest). Attaches the
 * platform bearer token and the X-Flow-Id header so every hop is traceable.
 * Never throws — returns null on any error so the pipeline degrades gracefully
 * and never blocks message delivery.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedPryvaConfig } from "./config.js";

const log = createSubsystemLogger("pryva");

const DEFAULT_TIMEOUT_MS = 30_000;

export type PryvaFetchOptions = {
  flowId?: string;
  timeoutMs?: number;
};

/**
 * POST/GET JSON to the Pryva backend. Returns the parsed JSON body, or null on
 * any failure (network, non-2xx, parse). The path is appended to the configured
 * backend URL under the /api/v1 prefix (matching the backend's router mount).
 */
export async function pryvaFetch(
  cfg: ResolvedPryvaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: PryvaFetchOptions = {},
): Promise<unknown> {
  const url = `${cfg.backendUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.internalToken}`,
    };
    if (opts.flowId) {
      headers["X-Flow-Id"] = opts.flowId;
    }
    const response = await globalThis.fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      log.debug(`backend ${method} ${path} -> ${response.status}`);
      return null;
    }
    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text) as unknown;
  } catch (err) {
    log.debug(`backend ${method} ${path} failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
