import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type AgentEvent,
  type ToolConfirmationRequest,
} from "./agent-loop.js";
import {
  createAgentRuntime,
  formatRuntimeError,
  resolveRuntimeConfig,
} from "./runtime.js";

async function main(): Promise<void> {
  // CLI 参数目前只解析 --session，保持入口足够小。
  // 更多配置先用环境变量承载，例如 OPENCLAW_MODEL。
  const sessionId = parseSessionId(process.argv.slice(2));
  const config = resolveRuntimeConfig();
  const { agent } = await createAgentRuntime(sessionId, config);

  console.log(`OpenClaw Mini session: ${sessionId}`);
  console.log(`Provider: ${config.providerName}`);
  console.log(`Model: ${config.model}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
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
        console.error(formatRuntimeError(error));
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

// 顶层错误通常来自启动阶段，例如 session id 非法、历史 JSONL 损坏或目录无法创建。
// 设置 process.exitCode 而不是直接 process.exit，可以让 Node 正常完成 stdout/stderr flush。
main().catch((error: unknown) => {
  console.error(formatRuntimeError(error));
  process.exitCode = 1;
});
