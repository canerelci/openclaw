import type { AgentTool, AgentToolResult, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { runAgentLoop } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
// The allowlist is proved on the tool array runAgentLoop places on the model
// stream context, using the customTools the attempt just handed to the session.
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();
const SKILLS_PROMPT = "<skill><name>laya-fixture</name></skill>";
const FIXTURE_NAMES = ["read", "message", "exec"] as const;

const loopModel: Model = {
  id: "gpt-5.5",
  name: "gpt-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
};

const loopUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

function fixtureTools(): AgentTool[] {
  return FIXTURE_NAMES.map((name) => ({
    name,
    label: name,
    description: `${name} fixture`,
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<unknown>> => ({
      content: [{ type: "text", text: `${name} ok` }],
      details: {},
    }),
  }));
}

function assistantMessage(
  message: Pick<AssistantMessage, "content" | "stopReason">,
): AssistantMessage {
  return {
    role: "assistant",
    content: message.content,
    stopReason: message.stopReason,
    api: loopModel.api,
    provider: loopModel.provider,
    model: loopModel.id,
    usage: loopUsage,
    timestamp: 1,
  };
}

function stopStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end();
  });
  return stream;
}

async function runAllowlistAttempt(toolSchemaAllowlist?: string[]): Promise<{
  modelToolNames: string[][];
  promptMode: unknown;
  skillsPrompt: unknown;
}> {
  resetEmbeddedAttemptHarness();
  hoisted.resolveSkillsPromptForRunMock.mockReturnValue(SKILLS_PROMPT);
  hoisted.createOpenClawCodingToolsMock.mockImplementation(() => fixtureTools());
  const modelToolNames: string[][] = [];
  let streamCalls = 0;
  const streamFn: StreamFn = (_model, context) => {
    modelToolNames.push((context.tools ?? []).map((tool) => tool.name));
    streamCalls += 1;
    const firstTool = context.tools?.[0]?.name;
    if (streamCalls === 1 && firstTool) {
      return stopStream(
        assistantMessage({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: firstTool,
              arguments: {},
            },
          ],
        }),
      );
    }
    return stopStream(
      assistantMessage({
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      }),
    );
  };

  const tempPaths: string[] = [];
  try {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        promptMode: "full",
        ...(toolSchemaAllowlist !== undefined ? { toolSchemaAllowlist } : {}),
      },
      createSession: (options) => {
        const customTools = (options.customTools ?? []) as AgentTool[];
        return createDefaultEmbeddedSession({
          prompt: async () => {
            await runAgentLoop(
              [{ role: "user", content: "hello", timestamp: 1 }],
              { systemPrompt: "test", messages: [], tools: customTools },
              {
                model: loopModel,
                convertToLlm: (messages) => messages as never,
              },
              () => {},
              undefined,
              streamFn,
            );
          },
        });
      },
    });
  } finally {
    await cleanupTempPaths(tempPaths);
  }

  const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as
    | { promptMode?: unknown; skillsPrompt?: unknown }
    | undefined;
  return {
    modelToolNames,
    promptMode: promptInput?.promptMode,
    skillsPrompt: promptInput?.skillsPrompt,
  };
}

describe("attempt tool schema allowlist", () => {
  it("leaves the model tool names unchanged when the allowlist is unset", async () => {
    const result = await runAllowlistAttempt(undefined);
    expect(result.modelToolNames).toEqual([
      ["read", "message", "exec"],
      ["read", "message", "exec"],
    ]);
  });

  it("sends only the allowlisted schemas, in attempt order, on every model call", async () => {
    const result = await runAllowlistAttempt(["read", "message"]);
    expect(result.modelToolNames).toEqual([
      ["read", "message"],
      ["read", "message"],
    ]);
  });

  it("sends no tool schemas when the allowlist is empty", async () => {
    const result = await runAllowlistAttempt([]);
    expect(result.modelToolNames).toEqual([[]]);
  });

  it("drops unknown allowlist names and keeps the known name", async () => {
    const result = await runAllowlistAttempt(["not-a-tool", "message"]);
    expect(result.modelToolNames).toEqual([["message"], ["message"]]);
  });

  it("keeps prompt mode and the skills prompt when the allowlist is set", async () => {
    const unset = await runAllowlistAttempt(undefined);
    const listed = await runAllowlistAttempt(["read", "message"]);
    expect(listed.promptMode).toBe(unset.promptMode);
    expect(listed.skillsPrompt).toBe(unset.skillsPrompt);
    expect(listed.promptMode).toBe("full");
    expect(listed.skillsPrompt).toBe(SKILLS_PROMPT);
  });
});
