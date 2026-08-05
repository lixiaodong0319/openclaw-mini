import Anthropic from "@anthropic-ai/sdk";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { AgentLoop } from "./agent-loop.js";
import {
  AnthropicProvider,
  OpenAIAPIError,
  OpenAIAuthenticationError,
  OpenAIConnectionError,
  OpenAIProvider,
  OpenAIRateLimitError,
  getOpenAIModelId,
  getModelId,
  type OpenAIInputItem,
} from "./provider.js";
import { SessionStore } from "./session-store.js";

async function main(): Promise<void> {
  // CLI 参数目前只解析 --session，保持入口足够小。
  // 更多配置先用环境变量承载，例如 OPENCLAW_MODEL。
  const sessionId = parseSessionId(process.argv.slice(2));
  const providerName = getProviderName();
  const projectRoot = process.cwd();

  // workspace 是 Agent 唯一能通过 read_text_file 访问的目录。
  // data 只用于宿主程序存会话，不作为工具 workspace 暴露给模型。
  // 这两个目录分离，可以降低模型读取自身历史或内部状态的机会。
  const workspaceRoot = path.join(projectRoot, "workspace");
  const dataRoot = path.join(projectRoot, "data");

  // 确保 workspace 存在，这样用户第一次运行后就能直接往里面放文件让 Agent 读取。
  await fs.mkdir(workspaceRoot, { recursive: true });

  const { agent, model } = await createAgent(providerName, dataRoot, sessionId, workspaceRoot);

  console.log(`OpenClaw Mini session: ${sessionId}`);
  console.log(`Provider: ${providerName}`);
  console.log(`Model: ${model}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log("输入 /exit 退出。\n");

  // 使用 readline/promises 实现最小 REPL。
  // 这里不引入 commander/yargs，是为了让 MVP 依赖和控制流保持可读。
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question("> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit") {
        break;
      }

      try {
        const result = await agent.runTurn(line);
        console.log(`${result.text}\n`);
      } catch (error) {
        // 单轮失败不退出 REPL，用户可以修正输入、配置 API Key 后继续尝试。
        console.error(formatError(error));
      }
    }
  } finally {
    rl.close();
  }
}

async function createAgent(
  providerName: ProviderName,
  dataRoot: string,
  sessionId: string,
  workspaceRoot: string,
): Promise<{ agent: AgentLoop; model: string }> {
  if (providerName === "openai") {
    // OpenAI Responses API 的历史包含 message、reasoning、function_call 和 function_call_output item。
    // 使用独立 namespace，防止和 Anthropic Messages API 的 JSONL 结构混在同一个 session 文件里。
    const store = new SessionStore<OpenAIInputItem>(dataRoot, sessionId, "openai");
    const input = await store.load();
    const model = getOpenAIModelId();
    return {
      model,
      agent: new AgentLoop({
        provider: new OpenAIProvider({
          model,
          input,
          onItem: (item) => store.append(item),
        }),
        toolContext: { workspaceRoot },
      }),
    };
  }

  // Anthropic 保持原有 session 文件位置，已有会话无需迁移。
  const store = new SessionStore<Anthropic.MessageParam>(dataRoot, sessionId);
  const messages = await store.load();
  const model = getModelId();
  return {
    model,
    agent: new AgentLoop({
      provider: new AnthropicProvider({
        model,
        messages,
        onMessage: (message) => store.append(message),
      }),
      toolContext: { workspaceRoot },
    }),
  };
}

type ProviderName = "anthropic" | "openai";

function getProviderName(): ProviderName {
  const value = (process.env.OPENCLAW_PROVIDER || "anthropic").toLowerCase();
  if (value === "anthropic") {
    return value;
  }
  if (value === "openai") {
    return value;
  }
  throw new Error("OPENCLAW_PROVIDER must be anthropic or openai");
}

// 当前 CLI 只支持 --session <id>。
// 这里不做字符集校验，因为 SessionStore 是唯一构造存储路径的地方，统一在那里做路径安全检查。
function parseSessionId(args: string[]): string {
  const index = args.indexOf("--session");
  if (index === -1) {
    return "default";
  }

  const sessionId = args[index + 1];
  if (!sessionId) {
    throw new Error("--session requires a value");
  }
  return sessionId;
}

// 把 SDK 异常转换成面向 CLI 用户的中文提示。
// 认证失败、限流、网络失败和普通 API 错误的处理建议不同，所以不要只 catch 成一个泛化错误。
function formatError(error: unknown): string {
  if (error instanceof OpenAIAuthenticationError) {
    return "OpenAI 认证失败：请设置 OPENAI_API_KEY。Codex CLI 或 ChatGPT 登录态不能替代 Platform API Key。";
  }
  if (error instanceof OpenAIRateLimitError) {
    return "OpenAI 请求被限流：请稍后重试。";
  }
  if (error instanceof OpenAIConnectionError) {
    return `OpenAI 网络连接失败：${error.message}`;
  }
  if (error instanceof OpenAIAPIError) {
    return `OpenAI API 错误：${error.status ?? "unknown"} ${error.message}`;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return "认证失败：请设置 ANTHROPIC_API_KEY，或先完成 ant auth login。";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "请求被限流：请稍后重试。";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return `网络连接失败：${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude API 错误：${error.status ?? "unknown"} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// 顶层错误通常来自启动阶段，例如 session id 非法、历史 JSONL 损坏或目录无法创建。
// 设置 process.exitCode 而不是直接 process.exit，可以让 Node 正常完成 stdout/stderr flush。
main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
