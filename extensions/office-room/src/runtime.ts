/**
 * Runtime store for host-provided OpenClaw services used by the Office Room
 * bundled plugin.
 */
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setOfficeRoomRuntime, getRuntime: getOfficeRoomRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "office-room",
    errorMessage: "Office Room runtime not initialized",
  });

export { getOfficeRoomRuntime, setOfficeRoomRuntime };
