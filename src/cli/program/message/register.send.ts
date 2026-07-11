// Message send command registration, including media and presentation/delivery options.
import type { Command } from "commander";
import type { MessageCliHelpers } from "./helpers.js";

/** Register `message send` and route execution through shared message helpers. */
export function registerMessageSendCommand(message: Command, helpers: MessageCliHelpers) {
  helpers
    .withMessageBase(
      helpers
        .withRequiredMessageTarget(
          message
            .command("send")
            .description("Send a message")
            .option("-m, --message <text>", "Message body (required unless --media is set)"),
        )
        .option(
          "--media <path-or-url>",
          "Attach media (image/audio/video/document). Accepts local paths or URLs.",
        )
        .option(
          "--presentation <json>",
          "Shared presentation payload as JSON (text, context, dividers, buttons, selects)",
        )
        .option("--delivery <json>", "Shared delivery preferences as JSON")
        .option("--pin", "Request that the delivered message be pinned when supported", false)
        .option("--reply-to <id>", "Reply-to message id")
        .option("--thread-id <id>", "Thread id (Telegram forum thread)")
        .option("--gif-playback", "Treat video media as GIF playback (WhatsApp only).", false)
        .option(
          "--force-document",
          "Send media as document to avoid channel compression (Telegram, WhatsApp). Applies to images, GIFs, and videos.",
          false,
        )
        .option(
          "--silent",
          "Send message silently without notification (Telegram + Discord)",
          false,
        )
        .option(
          "--flow-id <id>",
          "Pryva flow id this send belongs to (flawless-flow I1) — binds the outbound pipeline's telemetry to this flow instead of surfacing as fl-unbound. No-op if the pryva pipeline plugin isn't loaded.",
        )
        .option("--flow-source <source>", "Flow source tag to log if --flow-id is set."),
    )
    .action(async (opts) => {
      await helpers.runMessageAction("send", opts);
    });
}
