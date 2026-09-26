# Result: optional per-attempt tool allowlist

## Status

done

## Branch and commit SHA

Branch: `pryva/laya-tool-schema-allowlist`

Implementation commit: `6d33a6da123482cc6df6011171fc5df188dab238`

Not pushed.

## Files changed

- `src/plugins/hook-before-agent-start.types.ts`
- `src/plugins/hooks.ts`
- `src/plugins/hooks.phase-hooks.test.ts`
- `src/agents/embedded-agent-runner/run/setup.ts`
- `src/agents/embedded-agent-runner/run/setup.test.ts`
- `src/agents/embedded-agent-runner/run.ts`
- `src/agents/embedded-agent-runner/run/types.ts`
- `src/agents/embedded-agent-runner/run/attempt.ts`
- `src/agents/embedded-agent-runner/run/attempt.tool-schema-allowlist.test.ts`
- `src/agents/embedded-agent-runner/run/attempt.spawn-workspace.test-support.ts`

## Seam

Field: `toolSchemaAllowlist?: string[]`

Hook that sets it: `before_model_resolve` result (`PluginHookBeforeModelResolveResult`), `src/plugins/hook-before-agent-start.types.ts:24`. Higher-priority hook wins, and an explicit `[]` is kept (`src/plugins/hooks.ts:364`). `resolveHookModelSelection` returns that array (`src/agents/embedded-agent-runner/run/setup.ts:115`). A legacy `before_agent_start` result can set the same field only when `before_model_resolve` did not. `runEmbeddedAgent` copies it onto the attempt (`src/agents/embedded-agent-runner/run.ts:2134`, param at `src/agents/embedded-agent-runner/run/types.ts:116`).

Function that applies it: `applyAttemptToolSchemaAllowlist` (`src/agents/embedded-agent-runner/run/attempt.ts:809`), called on the custom tools and client tools handed to the agent session (`src/agents/embedded-agent-runner/run/attempt.ts:2492`). That array is what the attempt puts on the session, and the test drives it through `runAgentLoop` into the model stream context. Absent or `undefined` does not filter. Present, including `[]`, is the whole schema list. Unknown names are dropped. Order stays the attempt's existing order.

## Default-off proof

Test: `leaves the model tool names unchanged when the allowlist is unset`

Command:

```
pnpm test src/agents/embedded-agent-runner/run/attempt.tool-schema-allowlist.test.ts
```

Assertion: `expect(result.modelToolNames).toEqual([["read", "message", "exec"], ["read", "message", "exec"]])`

Observed: that value, on both model calls of the attempt. The test passed.

## Filter proof

Same command as case 1. All five tests passed (`5 passed`).

2. `sends only the allowlisted schemas, in attempt order, on every model call`

Assertion: `expect(result.modelToolNames).toEqual([["read", "message"], ["read", "message"]])`

Observed: `[["read", "message"], ["read", "message"]]`. `exec` was in the fixture and is absent. The second call is the continuation after the tool result.

3. `sends no tool schemas when the allowlist is empty`

Assertion: `expect(result.modelToolNames).toEqual([[]])`

Observed: `[[]]`.

4. `drops unknown allowlist names and keeps the known name`

Assertion: `expect(result.modelToolNames).toEqual([["message"], ["message"]])`

Allowlist was `["not-a-tool", "message"]`. Observed: `[["message"], ["message"]]`. `not-a-tool` is absent.

5. `keeps prompt mode and the skills prompt when the allowlist is set`

Assertions:

- `expect(listed.promptMode).toBe(unset.promptMode)`
- `expect(listed.skillsPrompt).toBe(unset.skillsPrompt)`
- `expect(listed.promptMode).toBe("full")`
- `expect(listed.skillsPrompt).toBe(SKILLS_PROMPT)` where `SKILLS_PROMPT` is `<skill><name>laya-fixture</name></skill>`

Observed: both runs passed `promptMode: "full"` and that skills string into the system-prompt builder. The allowlist did not flip the run to minimal and did not clear the skills prompt.

Hook plumbing, not the model array: `pnpm test src/agents/embedded-agent-runner/run/setup.test.ts src/plugins/hooks.phase-hooks.test.ts` passed. `before_model_resolve` returning `["read", "message"]` comes back unchanged. An explicit `[]` from that hook beats a legacy `before_agent_start` list of `["exec"]`.

## What you did not change

Prompt mode, skills prompt, `tools.toolSearch`, and the tool inventory. `toolsAllow` is untouched, so it still forces minimal mode when a caller sets it. The schema allowlist filters only the tools given to the session. The system prompt is still built from the unfiltered tool list. No tool was added or removed from the product inventory. Codex and Copilot harnesses do not read this field; the OpenClaw embedded attempt does.

## What the Pryva plugin must pass

Return `toolSchemaAllowlist` from `before_model_resolve`.

```ts
api.on("before_model_resolve", () => ({
  toolSchemaAllowlist: ["read", "message"],
}));
```

Omit the field, or leave it `undefined`, to keep today's schemas. Pass `[]` for no schemas. Names that are not on the attempt are ignored. Put core tool names on the list when those schemas should be sent. The plugin chooses the names. This fork does not.
