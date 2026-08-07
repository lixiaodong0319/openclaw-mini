import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "./agent-loop.js";
import {
  DEFAULT_CONTEXT_COMPACTION_OPTIONS,
  resolveContextCompactionOptions,
} from "./context-compaction.js";
import {
  AnthropicProvider,
  OpenAIAPIError,
  OpenAIAuthenticationError,
  OpenAIConnectionError,
  OpenAIProvider,
  OpenAIRateLimitError,
  getModelId,
  getOpenAIModelId,
  type OpenAIInputItem,
} from "./provider.js";
import { migrateLegacyAnthropicSessions, SessionStore } from "./session-store.js";

export type ProviderName = "anthropic" | "openai";

export interface RuntimeConfig {
  projectRoot: string;
  workspaceRoot: string;
  dataRoot: string;
  providerName: ProviderName;
  model: string;
}

export interface AgentRuntime extends RuntimeConfig {
  sessionId: string;
  agent: AgentLoop;
}

// CLI 和 Web 都从这里解析路径与模型，避免两个入口逐渐出现不同默认值。
export function resolveRuntimeConfig(projectRoot = process.cwd()): RuntimeConfig {
  const providerName = getProviderName();
  return {
    projectRoot,
    workspaceRoot: path.join(projectRoot, "workspace"),
    dataRoot: path.join(projectRoot, "data"),
    providerName,
    model: providerName === "openai" ? getOpenAIModelId() : getModelId(),
  };
}

export async function createAgentRuntime(
  sessionId: string,
  config = resolveRuntimeConfig(),
): Promise<AgentRuntime> {
  await prepareRuntime(config);
  const agent = await createAgent(
    config.providerName,
    config.dataRoot,
    sessionId,
    config.workspaceRoot,
    config.model,
  );
  return { ...config, sessionId, agent };
}

export async function prepareRuntime(config: RuntimeConfig): Promise<void> {
  // workspace 是文件工具的安全边界；首次运行时自动创建。
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  if (config.providerName === "anthropic") {
    await migrateLegacyAnthropicSessions(config.dataRoot);
  }
}

async function createAgent(
  providerName: ProviderName,
  dataRoot: string,
  sessionId: string,
  workspaceRoot: string,
  model: string,
): Promise<AgentLoop> {
  const compaction = getContextCompactionOptions();
  const toolContext = {
    workspaceRoot,
    commandTimeoutMs: getCommandTimeoutMs(),
  };

  if (providerName === "openai") {
    // 两种 Provider 使用独立 namespace，防止原生历史结构混入同一个 JSONL。
    const store = new SessionStore<OpenAIInputItem>(dataRoot, sessionId, "openai");
    const input = await store.load();
    return new AgentLoop({
      provider: new OpenAIProvider({
        model,
        input,
        onItem: (item) => store.append(item),
        onHistoryReplace: (items) => store.replace(items),
        compaction,
      }),
      toolContext,
    });
  }

  const store = new SessionStore<Anthropic.MessageParam>(dataRoot, sessionId, "anthropic");
  const messages = await store.load();
  return new AgentLoop({
    provider: new AnthropicProvider({
      model,
      messages,
      onMessage: (message) => store.append(message),
      onHistoryReplace: (replacement) => store.replace(replacement),
      compaction,
    }),
    toolContext,
  });
}

function getCommandTimeoutMs(): number {
  const timeoutMs = readPositiveIntegerEnvironment("OPENCLAW_COMMAND_TIMEOUT_MS", 30_000);
  if (timeoutMs > 120_000) {
    throw new Error("OPENCLAW_COMMAND_TIMEOUT_MS must not exceed 120000");
  }
  return timeoutMs;
}

function getContextCompactionOptions() {
  return resolveContextCompactionOptions({
    tokenThreshold: readPositiveIntegerEnvironment(
      "OPENCLAW_COMPACT_THRESHOLD",
      DEFAULT_CONTEXT_COMPACTION_OPTIONS.tokenThreshold,
    ),
    keepRecentTurns: readPositiveIntegerEnvironment(
      "OPENCLAW_COMPACT_KEEP_TURNS",
      DEFAULT_CONTEXT_COMPACTION_OPTIONS.keepRecentTurns,
    ),
    summaryMaxTokens: readPositiveIntegerEnvironment(
      "OPENCLAW_COMPACT_SUMMARY_TOKENS",
      DEFAULT_CONTEXT_COMPACTION_OPTIONS.summaryMaxTokens,
    ),
  });
}

export function readPositiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getProviderName(): ProviderName {
  const value = (process.env.OPENCLAW_PROVIDER || "anthropic").toLowerCase();
  if (value === "anthropic" || value === "openai") return value;
  throw new Error("OPENCLAW_PROVIDER must be anthropic or openai");
}

// 两个入口共用同一套面向用户的错误信息，避免 Web 只显示 SDK 堆栈或英文错误。
export function formatRuntimeError(error: unknown): string {
  if (error instanceof OpenAIAuthenticationError) {
    return "OpenAI 认证失败：请设置 OPENAI_API_KEY。Codex CLI 或 ChatGPT 登录态不能替代 Platform API Key。";
  }
  if (error instanceof OpenAIRateLimitError) return "OpenAI 请求被限流：请稍后重试。";
  if (error instanceof OpenAIConnectionError) return `OpenAI 网络连接失败：${error.message}`;
  if (error instanceof OpenAIAPIError) {
    return `OpenAI API 错误：${error.status ?? "unknown"} ${error.message}`;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "认证失败：请设置 ANTHROPIC_API_KEY，或先完成 ant auth login。";
  }
  if (error instanceof Anthropic.RateLimitError) return "请求被限流：请稍后重试。";
  if (error instanceof Anthropic.APIConnectionError) return `网络连接失败：${error.message}`;
  if (error instanceof Anthropic.APIError) {
    return `Claude API 错误：${error.status ?? "unknown"} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
