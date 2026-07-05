/**
 * Pryva pipeline configuration resolution.
 *
 * Reads the `pryva` config section (backend URL + internal token + pipeline
 * toggles), falling back to PRYVA_BACKEND_URL / PRYVA_INTERNAL_TOKEN env vars.
 * Flavor-agnostic: the resolved config is identical for every flavor.
 */

import type { OpenClawConfig, PryvaConfig } from "../config/config.js";

export type ResolvedPryvaConfig = {
  backendUrl: string;
  internalToken: string;
  pipeline: {
    enabled: boolean;
    disableEar: boolean;
    disableCortex: boolean;
    disableMouth: boolean;
    disableFastAck: boolean;
  };
};

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const v of values) {
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return "";
}

/**
 * Resolve the effective Pryva config from the OpenClaw config + environment.
 * Never throws. Returns null when the pipeline is not enabled OR when the
 * backend URL/token are missing (the pipeline cannot run without a backend).
 */
export function resolvePryvaConfig(cfg: OpenClawConfig | undefined): ResolvedPryvaConfig | null {
  const pryva: PryvaConfig | undefined = cfg?.pryva;
  const pipeline = pryva?.pipeline;

  // Master switch. Enabled unless explicitly false, provided a backend exists.
  const enabled = pipeline?.enabled === true;
  if (!enabled) {
    return null;
  }

  const backendUrl = firstNonEmpty(pryva?.backendUrl, process.env.PRYVA_BACKEND_URL).replace(
    /\/+$/,
    "",
  );
  const internalToken = firstNonEmpty(pryva?.internalToken, process.env.PRYVA_INTERNAL_TOKEN);

  if (!backendUrl || !internalToken) {
    return null;
  }

  return {
    backendUrl,
    internalToken,
    pipeline: {
      enabled: true,
      disableEar: pipeline?.disableEar === true,
      disableCortex: pipeline?.disableCortex === true,
      disableMouth: pipeline?.disableMouth === true,
      disableFastAck: pipeline?.disableFastAck === true,
    },
  };
}
