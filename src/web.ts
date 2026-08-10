import type { AgentLoop } from "./agent-loop.js";
import {
  createAgentRuntime,
  formatRuntimeError,
  prepareRuntime,
  readPositiveIntegerEnvironment,
  resolveRuntimeConfig,
} from "./runtime.js";
import { listSessionIds } from "./session-store.js";
import { loadSessionHistory } from "./session-history.js";
import { createWebServer } from "./web-server.js";

async function main(): Promise<void> {
  const config = resolveRuntimeConfig();
  // 在列出 Session 前完成旧 Anthropic 历史迁移，让下拉框立即显示旧会话。
  await prepareRuntime(config);

  // 每个 session 在进程内只创建一个 AgentLoop，保证其内存历史与 JSONL 追加顺序一致。
  // Promise 也进入缓存，可合并同一 session 的并发首次加载；加载失败则允许下次重试。
  const agents = new Map<string, Promise<AgentLoop>>();
  const getAgent = (sessionId: string): Promise<AgentLoop> => {
    const cached = agents.get(sessionId);
    if (cached) return cached;
    const created = createAgentRuntime(sessionId, config).then((runtime) => runtime.agent);
    agents.set(sessionId, created);
    created.catch(() => agents.delete(sessionId));
    return created;
  };

  const server = createWebServer({
    config,
    getAgent,
    listSessions: () => listSessionIds(
      config.dataRoot,
      config.providerName,
    ),
    loadHistory: (sessionId) => loadSessionHistory(config, sessionId),
  });
  const port = readPositiveIntegerEnvironment("OPENCLAW_WEB_PORT", 3000);
  if (port > 65_535) throw new Error("OPENCLAW_WEB_PORT must not exceed 65535");
  const host = process.env.OPENCLAW_WEB_HOST || "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(`OpenClaw Mini Web: http://${host}:${port}`);
  console.log(`Provider: ${config.providerName}`);
  console.log(`Model: ${config.model}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
  console.log("按 Ctrl+C 退出。");
}

main().catch((error: unknown) => {
  console.error(formatRuntimeError(error));
  process.exitCode = 1;
});
