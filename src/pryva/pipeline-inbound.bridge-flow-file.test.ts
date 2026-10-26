// A gateway run re-enters the flow id the agent bridge wrote to disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FlowRegistry } from "./flow-registry.js";
import { onBeforeAgentStart } from "./pipeline-inbound.js";
import { logFlowStep } from "./pipeline.js";

function createStubPipeline(registry: FlowRegistry) {
  return {
    registry,
    cfg: { backendUrl: "http://127.0.0.1:9", pipeline: { disableEar: true } },
    ctxStore: {
      findByRecipient: () => undefined,
      findLatest: () => undefined,
      key: () => "",
      set: () => {},
      cleanupStale: () => {},
    },
    rawCfg: {},
    log: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    scheduleSessionTurn: () => {},
  } as never;
}

describe("gateway web-chat flow file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    delete process.env.PRYVA_AGENT_FLOW_DIR;
    delete process.env.PRYVA_FLOW_ID;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("binds the gateway run and its tool step to the bridge flow id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pryva-flow-"));
    dirs.push(dir);
    process.env.PRYVA_AGENT_FLOW_DIR = dir;
    fs.writeFileSync(
      path.join(dir, "admin-internal.json"),
      JSON.stringify({
        flowId: "fl-abc123def456",
        source: "internal_chat",
        sessionKey: "admin-internal",
      }),
    );
    const registry = new FlowRegistry();
    const pipeline = createStubPipeline(registry);
    await onBeforeAgentStart(pipeline, { prompt: "" }, {
      runId: "run-bridge-file",
      sessionKey: "agent:main:admin-internal",
    } as never);
    expect(registry.getFlowForRun("run-bridge-file")?.flowId).toBe("fl-abc123def456");
    const stepFlow = logFlowStep(
      pipeline,
      { runId: "run-bridge-file" },
      { step_name: "ocw_tool:search", step_type: "tool_call" },
    );
    expect(stepFlow).toBe("fl-abc123def456");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps an explicit pryvaFlowId when a leftover bridge file is still on disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pryva-flow-"));
    dirs.push(dir);
    process.env.PRYVA_AGENT_FLOW_DIR = dir;
    const file = path.join(dir, "admin-internal.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        flowId: "fl-leftover0001",
        source: "internal_chat",
        sessionKey: "admin-internal",
      }),
    );
    const registry = new FlowRegistry();
    registry.attachExternalFlowBySession(
      "agent:main:admin-internal",
      "fl-explicit0001",
      "ncw_completion",
    );
    const pipeline = createStubPipeline(registry);
    await onBeforeAgentStart(pipeline, { prompt: "" }, {
      runId: "run-explicit-wins",
      sessionKey: "agent:main:admin-internal",
    } as never);
    expect(registry.getFlowForRun("run-explicit-wins")?.flowId).toBe("fl-explicit0001");
    expect(fs.existsSync(file)).toBe(true);
  });
});
