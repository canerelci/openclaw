/**
 * Extract the assistant's last-turn reply text(s) from a session transcript.
 * Used by agent_end to capture auto-replies for flow tracing / ingest.
 */
export function extractLastAssistantTurn(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string })?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const texts: string[] = [];
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg?.role !== "assistant") {
      continue;
    }
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content.trim();
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b): b is { type: string; text: string } => {
          const block = b as { type?: string; text?: string };
          return block?.type === "text" && typeof block?.text === "string";
        })
        .map((b) => b.text)
        .join("\n")
        .trim();
    }
    if (text && text.length > 2 && !text.startsWith("{") && text.toUpperCase() !== "NO_REPLY") {
      texts.push(text);
    }
  }
  return texts;
}
