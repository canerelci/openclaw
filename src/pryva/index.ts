/**
 * Pryva — native, flavor-agnostic message pipeline baked into this OpenClaw fork.
 *
 * Ear/Cortex/Mouth, flow tracing, LLM/tool telemetry, outbound sanitization, and
 * fast-ack, registered as always-on first-party plugin hooks (config-gated by
 * `pryva.pipeline.enabled`). Flavor specifics (brand kit, owner/contact identity,
 * persona) stay in the per-flavor extensions.
 */

export { resolvePryvaConfig, type ResolvedPryvaConfig } from "./config.js";
export { registerPryvaPipelineHooks } from "./register.js";
