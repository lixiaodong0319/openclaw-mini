import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentLoop, type ToolExecutor } from "./agent-loop.js";
import { executeTool, type ToolContext } from "./tools.js";
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
import { McpManager } from "./mcp.js";
import { resolveMemoryEmbeddingEnvironment } from "./embedding.js";
import { WorkspaceMemoryFlusher } from "./memory-flush.js";
import { WorkspaceMemoryConsolidator } from "./memory-consolidation.js";
import { WorkspaceSkillManager } from "./skills.js";
import { TaskPlanStore } from "./task-plan.js";
import {
  getSubagentRolePrompt,
  type SubagentRunner,
} from "./subagents.js";
import {
  MEMORY_INDEX_RELATIVE_PATH,
  WorkspaceMemoryIndex,
} from "./memory-index.js";
import {
  loadWorkspaceMemoryContext,
  type WorkspaceMemoryContext,
} from "./workspace-memory.js";
import {
  buildSystemPrompt,
  loadWorkspaceInstructions,
  type WorkspaceInstructions,
} from "./workspace-instructions.js";

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
  workspaceInstructions?: WorkspaceInstructions;
  workspaceMemory: WorkspaceMemoryContext;
  memoryIndex: WorkspaceMemoryIndex;
  memoryFlusher: WorkspaceMemoryFlusher;
  memoryConsolidator: WorkspaceMemoryConsolidator;
  skillManager: WorkspaceSkillManager;
  taskPlan: TaskPlanStore;
  mcp: McpManager;
}

export interface RuntimePreparation {
  workspaceInstructions?: WorkspaceInstructions;
  memoryIndex: WorkspaceMemoryIndex;
  memoryFlusher: WorkspaceMemoryFlusher;
  memoryConsolidator: WorkspaceMemoryConsolidator;
  skillManager: WorkspaceSkillManager;
  mcp: McpManager;
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
  preparation?: RuntimePreparation,
): Promise<AgentRuntime> {
  // preparation 包含启动期读取的 AGENTS.md、共享记忆索引和已建立的 MCP 连接。
  // CLI 切换会话、修改记忆以及 Web 创建多个 Agent 时会复用它。
  const ownsPreparation = preparation === undefined;
  const prepared = preparation ?? await prepareRuntime(config);
  // 计划属于当前 Provider/Session，不放进共享 preparation。切换 Session 时会创建
  // 新 Store，并从对应 JSON 恢复；记忆、Skills 和 MCP 仍按原方式共享。
  const taskPlan = new TaskPlanStore(config.dataRoot, sessionId, config.providerName);
  let workspaceMemory: WorkspaceMemoryContext;
  let agent: AgentLoop;
  try {
    // 已存在的计划在 Agent 构建前先校验一次，损坏或被替换为符号链接时启动即报错，
    // 而不是等到第一次模型请求才发现。
    await taskPlan.loadPlan();
    // 启动时先读一次用于校验和状态展示。AgentLoop 运行时仍会在每次
    // 模型调用前重读 MEMORY.md，因此手工或工具编辑后不需重建 Agent。
    workspaceMemory = await loadWorkspaceMemoryContext(config.workspaceRoot);
    agent = await createAgent(
      config.providerName,
      config.dataRoot,
      sessionId,
      config.workspaceRoot,
      config.model,
      prepared.workspaceInstructions,
      prepared.memoryIndex,
      prepared.memoryFlusher,
      prepared.memoryConsolidator,
      prepared.skillManager,
      taskPlan,
      prepared.mcp,
    );
  } catch (error) {
    // CLI 自己创建的 MCP 连接在后续初始化失败时必须释放。
    // Web 传入共享 preparation，因此由 Web Server 的生命周期统一关闭。
    if (ownsPreparation) {
      prepared.memoryIndex.close();
      await prepared.mcp.close();
    }
    throw error;
  }
  return {
    ...config,
    sessionId,
    agent,
    workspaceInstructions: prepared.workspaceInstructions,
    memoryIndex: prepared.memoryIndex,
    memoryFlusher: prepared.memoryFlusher,
    memoryConsolidator: prepared.memoryConsolidator,
    skillManager: prepared.skillManager,
    taskPlan,
    workspaceMemory,
    mcp: prepared.mcp,
  };
}

export async function prepareRuntime(config: RuntimeConfig): Promise<RuntimePreparation> {
  // workspace 是文件工具的安全边界；首次运行时自动创建。
  await fs.mkdir(config.workspaceRoot, { recursive: true });
  if (config.providerName === "anthropic") {
    await migrateLegacyAnthropicSessions(config.dataRoot);
  }
  // 向量检索配置独立于当前对话 Provider：即使聊天使用 Anthropic，只要单独配置了
  // OPENAI_API_KEY，记忆搜索仍可使用 OpenAI Embeddings；未配置时保持纯本地 BM25。
  const memoryEmbedding = resolveMemoryEmbeddingEnvironment();
  const memoryIndex = new WorkspaceMemoryIndex(
    config.workspaceRoot,
    path.join(config.dataRoot, MEMORY_INDEX_RELATIVE_PATH),
    {
      embeddingClient: memoryEmbedding.client,
      vectorWeight: memoryEmbedding.vectorWeight,
    },
  );
  // 启动时创建或校验派生索引，让第一次 memory_search 不承担完整初始化延迟。
  // search 自身仍会再次同步，因此用户在进程运行期间手工编辑 Markdown 也不会漏检。
  await memoryIndex.sync();
  // 所有 Session 共享一个写入队列，Web 并发压缩时不会同时对同一个每日 Markdown
  // 执行“读取、去重、追加”。它不持有文件句柄，因此无需额外 close 生命周期。
  const memoryFlusher = new WorkspaceMemoryFlusher(config.workspaceRoot);
  const memoryConsolidator = new WorkspaceMemoryConsolidator(
    config.workspaceRoot,
    () => memoryIndex.scheduleSync(),
  );
  // Manager 不缓存目录或正文；这里先扫描一次让配置错误在启动阶段尽早暴露，
  // 后续每次模型调用和 /skills 命令仍会重新扫描以支持热刷新。
  const skillManager = new WorkspaceSkillManager(config.workspaceRoot);
  try {
    await skillManager.loadCatalog();
    return {
      workspaceInstructions: await loadWorkspaceInstructions(config.workspaceRoot),
      memoryIndex,
      memoryFlusher,
      memoryConsolidator,
      skillManager,
      mcp: await McpManager.load(config.projectRoot),
    };
  } catch (error) {
    memoryIndex.close();
    throw error;
  }
}

async function createAgent(
  providerName: ProviderName,
  dataRoot: string,
  sessionId: string,
  workspaceRoot: string,
  model: string,
  workspaceInstructions?: WorkspaceInstructions,
  memoryIndex?: WorkspaceMemoryIndex,
  memoryFlusher?: WorkspaceMemoryFlusher,
  memoryConsolidator?: WorkspaceMemoryConsolidator,
  skillManager?: WorkspaceSkillManager,
  taskPlan?: TaskPlanStore,
  mcp?: McpManager,
): Promise<AgentLoop> {
  const compaction = getContextCompactionOptions();
  // Provider 只负责协议适配；这个 resolver 在每次 generateTurn 前重读 MEMORY.md
  // 以及今天/昨天的 memory/*.md，
  // 并与默认提示词、启动时的 workspace 指令快照统一组装。
  const systemPrompt = async (): Promise<string> => buildSystemPrompt(
    workspaceInstructions,
    await loadWorkspaceMemoryContext(workspaceRoot),
    await skillManager?.loadCatalog() ?? [],
    await taskPlan?.loadPlan(),
  );
  const mcpDefinitions = mcp?.getDefinitions();
  const toolContext: ToolContext = {
    workspaceRoot,
    commandTimeoutMs: getCommandTimeoutMs(),
    memoryIndex,
    skills: skillManager,
    taskPlan,
  };
  const toolExecutor: ToolExecutor = async (name, input, context) => {
    if (mcp?.hasTool(name)) return mcp.execute(name, input);
    return executeTool(name, input, context);
  };
  // 子 Agent 共享 workspace、记忆、Skills、MCP 和权限确认，但每次都创建空白 Provider
  // 历史，且不配置任何 SessionStore 回调。它的中间对话因此不会混入或持久化到主会话。
  const subagentRunner: SubagentRunner = async (request, options) => {
    const childSystemPrompt = async (): Promise<string> => `${buildSystemPrompt(
      workspaceInstructions,
      await loadWorkspaceMemoryContext(workspaceRoot),
      await skillManager?.loadCatalog() ?? [],
      // 父计划由主 Agent 管理；子 Agent 不读写它，避免并行子任务互相覆盖状态。
      undefined,
      { includeAgentCoordination: false },
    )}\n\n${getSubagentRolePrompt(request.agent)}`;
    const childToolContext: ToolContext = {
      ...toolContext,
      taskPlan: undefined,
    };
    const excludedTools = ["run_subagent", "update_plan"];
    const provider = providerName === "openai"
      ? new OpenAIProvider({
        model,
        input: [],
        compaction,
        additionalTools: mcpDefinitions?.openai,
        excludedTools,
      })
      : new AnthropicProvider({
        model,
        messages: [],
        compaction,
        additionalTools: mcpDefinitions?.anthropic,
        excludedTools,
      });
    const child = new AgentLoop({
      provider,
      toolContext: childToolContext,
      toolExecutor,
      systemPrompt: childSystemPrompt,
      // 不注入 subagentRunner，从能力清单和执行层双重禁止递归委派。
    });
    return child.runTurn(request.task, options?.onEvent, options?.confirmTool);
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
        additionalTools: mcpDefinitions?.openai,
      }),
      toolContext,
      toolExecutor,
      subagentRunner,
      systemPrompt,
      memoryFlush: memoryFlusher ? async (summary) => {
        const result = await memoryFlusher.flush(summary);
        // 新记忆仍以 Markdown 为真相源；写入后只调度派生索引同步，失败不会影响已经
        // 完成的落盘，下一次 memory_search 还会主动执行一次同步。
        if (result.written) memoryIndex?.scheduleSync();
        return result;
      } : undefined,
      memoryConsolidator,
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
      additionalTools: mcpDefinitions?.anthropic,
    }),
    toolContext,
    toolExecutor,
    subagentRunner,
    systemPrompt,
    memoryFlush: memoryFlusher ? async (summary) => {
      const result = await memoryFlusher.flush(summary);
      if (result.written) memoryIndex?.scheduleSync();
      return result;
    } : undefined,
    memoryConsolidator,
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
