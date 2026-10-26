// The gateway loads its registry with activate:false. The native pipeline
// still has to be on that registry, or a gateway run never binds a flow.
import { describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "./loader.js";

describe("gateway plugin load", () => {
  it("registers the native pipeline when activation is deferred", () => {
    const registry = loadOpenClawPlugins({
      activate: false,
      runtimeSideEffects: true,
      cache: false,
      onlyPluginIds: ["not-a-plugin"],
      config: {
        pryva: {
          pipeline: { enabled: true },
          backendUrl: "http://127.0.0.1:9",
          internalToken: "token",
        },
      },
    });
    expect(registry.plugins.some((plugin) => plugin.id === "pryva-pipeline")).toBe(true);
  });
});
