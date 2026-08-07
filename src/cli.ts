import Anthropic from "@anthropic-ai/sdk";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  AgentLoop,
  type AgentEvent,
  type ToolConfirmationRequest,
} from "./agent-loop.js";
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
import {
  DEFAULT_CONTEXT_COMPACTION_OPTIONS,
  resolveContextCompactionOptions,
} from "./context-compaction.js";
import { SessionStore } from "./session-store.js";

async function main(): Promise<void> {
  // CLI 参数目前只解析 --session，保持入口足够小。
  // 更多配置先用环境变量承载，例如 OPENCLAW_MODEL。
  const sessionId = parseSessionId(process.argv.slice(2));
  const providerName = getProviderName();
  const projectRoot = process.cwd();

  // workspace 是 Agent 唯一能通过文件工具读写的目录。
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
      // 一次 question 对应一个完整用户轮次。AgentLoop 运行期间如果需要工具确认，
      // 会复用同一个 readline Interface 追加 question，避免多个 stdin 监听器争抢输入。
      const line = (await rl.question("> ")).trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/exit") {
        break;
      }

      const renderer = createTurnRenderer();
      try {
        await agent.runTurn(
          line,
          renderer.handle,
          (request) => confirmToolCall(rl, request),
        );
        renderer.finish();
      } catch (error) {
        renderer.finish();
        // 单轮失败不退出 REPL，用户可以修正输入、配置 API Key 后继续尝试。
        console.error(formatError(error));
      }
    }
  } finally {
    // 无论用户 /exit 还是循环中发生未捕获错误，都释放 stdin 和进程事件监听。
    rl.close();
  }
}

function createTurnRenderer(): { handle: (event: AgentEvent) => void; finish: () => void } {
  // 模型文本使用 stdout.write 增量输出，不保证最后一个 delta 以换行结束。
  // lineOpen 记录光标是否仍在模型文本行上，插入工具/会话状态前先补换行。
  let lineOpen = false;
  let finished = false;

  const writeStatus = (category: "工具" | "会话", message: string): void => {
    if (lineOpen) output.write("\n");
    output.write(`[${category}] ${message}\n`);
    lineOpen = false;
  };

  return {
    handle: (event) => {
      if (event.type === "text_delta") {
        if (event.text.length === 0) return;
        output.write(event.text);
        lineOpen = !event.text.endsWith("\n");
        return;
      }
      if (event.type === "context_compaction_start") {
        // 压缩需要额外调用一次模型，用独立“会话”分类避免被误认为工具调用。
        writeStatus("会话", `正在压缩上下文（约 ${event.estimatedTokens} tokens）...`);
        return;
      }
      if (event.type === "context_compaction_end") {
        writeStatus("会话", `上下文压缩完成（${event.beforeTokens} → ${event.afterTokens} tokens）`);
        return;
      }
      if (event.type === "tool_start") {
        writeStatus("工具", `${event.name} 执行中...`);
        return;
      }
      if (event.type === "tool_pending") {
        writeStatus("工具", `${event.name} 等待确认`);
        return;
      }
      if (event.type === "tool_approved") {
        writeStatus("工具", `${event.name} 已允许`);
        return;
      }
      if (event.type === "tool_denied") {
        writeStatus("工具", `${event.name} 已拒绝`);
        return;
      }
      if (event.type === "tool_end") {
        writeStatus("工具", `${event.name} ${event.isError ? "失败" : "完成"}`);
      }
    },
    finish: () => {
      // finish 可在正常结束和 catch 分支被调用，幂等保护可避免多打一个空行。
      if (finished) return;
      if (lineOpen) output.write("\n");
      output.write("\n");
      finished = true;
    },
  };
}

async function confirmToolCall(
  rl: Interface,
  request: ToolConfirmationRequest,
): Promise<boolean> {
  // 先显示模型生成的完整结构化参数预览，再读取用户决定。
  // 默认是拒绝：只有明确的 y/yes 才返回 true，回车、拼写错误和其他输入都不执行。
  output.write(`参数:\n${formatToolInput(request.input)}\n`);
  const answer = (await rl.question(`允许执行 ${request.name}？[y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function formatToolInput(input: unknown): string {
  // 工具参数可能包含整个文件内容。设置终端预览上限，防止一次确认刷屏数万行。
  // 这只影响展示，AgentLoop 传给工具的 input 仍是未截断的原对象。
  const maxLength = 2_000;
  let text: string;
  try {
    // 正常模型参数都是 JSON 值；String fallback 使测试注入循环引用等非 JSON 值时也能显示。
    text = JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    text = String(input);
  }

  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...（已截断）`;
}

async function createAgent(
  providerName: ProviderName,
  dataRoot: string,
  sessionId: string,
  workspaceRoot: string,
): Promise<{ agent: AgentLoop; model: string }> {
  const compaction = getContextCompactionOptions();
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
          // 普通 item 仍逐条 append；只有 Provider 压缩成功时才回调 replace。
          onHistoryReplace: (items) => store.replace(items),
          compaction,
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
        // Anthropic 与 OpenAI 使用各自的 SessionStore namespace，但整体替换语义相同。
        onHistoryReplace: (replacement) => store.replace(replacement),
        compaction,
      }),
      toolContext: { workspaceRoot },
    }),
  };
}

function getContextCompactionOptions() {
  // 环境变量只在 CLI 组装 Provider 时读取一次。
  // 测试可以绕过 process.env，直接通过 Provider options 注入更小阈值。
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

function readPositiveIntegerEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  // 不接受 0、负数、小数或非数字，避免错误配置导致每轮都压缩或行为不稳定。
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

type ProviderName = "anthropic" | "openai";

function getProviderName(): ProviderName {
  // 只允许显式白名单，避免配置拼写错误时静默回退到另一个 Provider 并使用错误的凭据/会话格式。
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
