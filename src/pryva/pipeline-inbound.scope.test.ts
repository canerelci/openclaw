import { describe, expect, it } from "vitest";
import { isOutOfScopePlan, scopePlanDirective } from "./scope.js";

describe("Ear role-scope plan", () => {
  it("forces exactly the Ear-generated rejection and forbids tools", () => {
    const plan = {
      intent: "out_of_scope",
      short_circuit: true,
      short_circuit_type: "out_of_scope",
      direct_reply: "Bu benim uzmanlık alanım değil.",
      response_language: "tr",
    };
    const block = scopePlanDirective(plan);

    expect(isOutOfScopePlan(plan)).toBe(true);
    expect(block).toContain("call no tools");
    expect(block).toContain("exactly this one sentence");
    expect(block).toContain('"Bu benim uzmanlık alanım değil."');
  });

  it("does not add the mandatory scope response to a normal request", () => {
    const plan = {
      intent: "request",
      short_circuit: false,
      key_points: ["Prepare the social post"],
    };
    const block = scopePlanDirective(plan);

    expect(isOutOfScopePlan(plan)).toBe(false);
    expect(block).toBeNull();
  });
});
