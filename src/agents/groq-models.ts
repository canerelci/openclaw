import type { ModelDefinitionConfig } from "../config/types.models.js";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

// Model limits sourced from https://groq.com/pricing and Groq API docs.
// max_output_tokens is the hard ceiling Groq enforces on max_completion_tokens.
export const GROQ_MODEL_CATALOG: ModelDefinitionConfig[] = [
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 65536,
    cost: { input: 0.15, output: 0.60, cacheRead: 0.15, cacheWrite: 0.60 },
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT-OSS 20B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0.075, output: 0.30, cacheRead: 0.075, cacheWrite: 0.30 },
  },
  {
    id: "openai/gpt-oss-safeguard-20b",
    name: "GPT-OSS Safeguard 20B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0.075, output: 0.30, cacheRead: 0.075, cacheWrite: 0.30 },
  },
  {
    id: "moonshotai/kimi-k2-0905",
    name: "Kimi K2",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 1.00, output: 3.00, cacheRead: 1.00, cacheWrite: 3.00 },
  },
  {
    id: "meta-llama/llama-4-maverick-17b-128e-instruct",
    name: "Llama 4 Maverick 17B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.20, output: 0.60, cacheRead: 0.20, cacheWrite: 0.60 },
  },
  {
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    name: "Llama 4 Scout 17B",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.11, output: 0.34, cacheRead: 0.11, cacheWrite: 0.34 },
  },
  {
    id: "qwen/qwen3-32b",
    name: "Qwen3 32B",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0.29, output: 0.59, cacheRead: 0.29, cacheWrite: 0.59 },
  },
  {
    id: "llama-3.3-70b-versatile",
    name: "Llama 3.3 70B Versatile",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 32768,
    cost: { input: 0.59, output: 0.79, cacheRead: 0.59, cacheWrite: 0.79 },
  },
  {
    id: "llama-3.1-8b-instant",
    name: "Llama 3.1 8B Instant",
    reasoning: false,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0.05, output: 0.08, cacheRead: 0.05, cacheWrite: 0.08 },
  },
];
