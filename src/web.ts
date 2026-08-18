import type { AgentLoop } from "./agent-loop.js";
import {
  createAgentRuntime,
  formatRuntimeError,
  prepareRuntime,
  readPositiveIntegerEnvironment,
  resolveRuntimeConfig,
} from "./runtime.js";
import {
  createSession,
  deleteSession,
  listSessionIds,
  renameSession,
} from "./session-store.js";
import { loadSessionHistory } from "./session-history.js";
import { createWebServer } from "./web-server.js";
import { describeWorkspaceInstructions } from "./workspace-instructions.js";
import {
  describeDailyMemories,
  describeWorkspaceMemory,
  loadWorkspaceMemoryContext,
} from "./workspace-memory.js";
import { TaskPlanStore } from "./task-plan.js";

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  // 在列出 Session 前完成旧 Anthropic 历史迁移，让下拉框立即显示旧会话。
  const preparation = await prepareRuntime(config);

  // 每个 session 在进程内只创建一个 AgentLoop，保证其内存历史与 JSONL 追加顺序一致。
  // Promise 也进入缓存，可合并同一 session 的并发首次加载；加载失败则允许下次重试。
  const agents = new Map<string, Promise<AgentLoop>>();
  const getAgent = (sessionId: string): Promise<AgentLoop> => {
    const cached = agents.get(sessionId);
    if (cached) return cached;
    const created = createAgentRuntime(sessionId, config, preparation).then((runtime) => runtime.agent);
    agents.set(sessionId, created);
    created.catch(() => agents.delete(sessionId));
    return created;
  };

  const server = createWebServer({
    config,
    workspaceInstructions: preparation.workspaceInstructions,
    getAgent,
    listSessions: () => listSessionIds(
      config.dataRoot,
      config.providerName,
    ),
    createSession: (sessionId) => createSession(
      config.dataRoot,
      sessionId,
      config.providerName,
    ),
    renameSession: (oldSessionId, newSessionId) => renameSession(
      config.dataRoot,
      oldSessionId,
      newSessionId,
      config.providerName,
    ),
    deleteSession: (sessionId) => deleteSession(
      config.dataRoot,
      sessionId,
      config.providerName,
    ),
    releaseAgent: (sessionId) => {
      agents.delete(sessionId);
    },
    loadHistory: (sessionId) => loadSessionHistory(config, sessionId),
    loadMemory: () => loadWorkspaceMemoryContext(config.workspaceRoot),
    loadPlan: (sessionId) => new TaskPlanStore(
      config.dataRoot,
      sessionId,
      config.providerName,
    ).loadPlan(),
    clearPlan: (sessionId) => new TaskPlanStore(
      config.dataRoot,
      sessionId,
      config.providerName,
    ).clearPlan(),
  });
  server.once("close", () => {
    preparation.memoryIndex.close();
    void preparation.mcp.close();
  });
  const port = readPositiveIntegerEnvironment("OPENCLAW_WEB_PORT", 3000);
  if (port > 65_535) throw new Error("OPENCLAW_WEB_PORT must not exceed 65535");
  const host = process.env.OPENCLAW_WEB_HOST || "127.0.0.1";

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    preparation.memoryIndex.close();
    await preparation.mcp.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    preparation.memoryIndex.close();
    await preparation.mcp.close();
  };
  const handleSignal = (): void => {
    void shutdown().catch((error) => {
      console.error(formatRuntimeError(error));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  console.log(`OpenClaw Web: http://${host}:${port}`);
  console.log(`Provider: ${config.providerName}`);
  console.log(`Model: ${config.model}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
  console.log(`Instructions: ${describeWorkspaceInstructions(preparation.workspaceInstructions)}`);
  const workspaceMemory = await loadWorkspaceMemoryContext(config.workspaceRoot);
  console.log(`Memory: ${describeWorkspaceMemory(workspaceMemory.longTerm)}`);
  console.log(`Daily memory: ${describeDailyMemories(workspaceMemory)}`);
  const skills = await preparation.skillManager.loadCatalog();
  console.log(`Skills: ${skills.filter((skill) => skill.enabled).length} enabled, ${skills.filter((skill) => !skill.enabled).length} disabled`);
  console.log(`MCP: ${preparation.mcp.serverCount} server(s), ${preparation.mcp.toolCount} tool(s)`);
  console.log("按 Ctrl+C 退出。");
}

main().catch((error: unknown) => {
  console.error(formatRuntimeError(error));
  process.exitCode = 1;
});
