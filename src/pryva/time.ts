/**
 * Timezone-aware "current time" anchor injected into every prompt so the agent
 * never infers the current time from stale conversation history.
 */

export function currentTimeContext(timezone: string): string {
  const tz = timezone || "UTC";
  const now = new Date();
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "shortOffset",
    }).format(now);
  } catch {
    local = now.toISOString();
  }
  return (
    `[CURRENT TIME]\nNow: ${local} (${tz}) | UTC: ${now.toISOString().slice(0, 19)}Z\n` +
    "Use this for all time math. Never infer the current time from conversation history."
  );
}
