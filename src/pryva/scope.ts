/** Pure role-scope helpers kept dependency-free for the hot inbound path. */

export function isOutOfScopePlan(plan: Record<string, unknown> | null | undefined): boolean {
  return plan?.intent === "out_of_scope" && plan?.short_circuit_type === "out_of_scope";
}

export function scopePlanDirective(
  plan: Record<string, unknown> | null | undefined,
): string | null {
  if (!isOutOfScopePlan(plan) || typeof plan?.direct_reply !== "string") {
    return null;
  }
  const reply = plan.direct_reply.trim();
  if (!reply) {
    return null;
  }
  return (
    "  Mandatory scope response: call no tools and reply with exactly this one sentence, " +
    `nothing else: ${JSON.stringify(reply)}`
  );
}
