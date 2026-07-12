/**
 * Bundled channel entry metadata for the Office Room plugin.
 */
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "office-room",
  name: "Office Room",
  description: "Office Room channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "officeRoomPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setOfficeRoomRuntime",
  },
});
