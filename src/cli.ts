import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  type AgentEvent,
  type ToolConfirmationRequest,
} from "./agent-loop.js";
import {
  CLI_HELP_TEXT,
  formatMcpStatus,
  formatSessionList,
  formatSessionHistory,
  isCliCommandName,
  parseCliCommand,
  type CliCommandName,
} from "./cli-commands.js";
import {
  createAgentRuntime,
  formatRuntimeError,
  resolveRuntimeConfig,
  type AgentRuntime,
  type RuntimeConfig,
} from "./runtime.js";
import {
  createSession,
  deleteSession,
  listSessionIds,
  renameSession,
  sessionExists,
} from "./session-store.js";
import { loadSessionHistory } from "./session-history.js";
import { describeWorkspaceInstructions } from "./workspace-instructions.js";
import {
  describeDailyMemories,
  describeWorkspaceMemory,
  loadWorkspaceMemoryContext,
} from "./workspace-memory.js";

async function main(): Promise<void> {
  // CLI 参数目前只解析 --session，保持入口足够小。
  // 更多配置先用环境变量承载，例如 OPENCLAW_MODEL。
  const initialSessionId = parseSessionId(process.argv.slice(2));
  const config = resolveRuntimeConfig();
  let runtime = await createAgentRuntime(initialSessionId, config);

  console.log(`OpenClaw Mini session: ${runtime.sessionId}`);
  console.log(`Provider: ${config.providerName}`);
  console.log(`Model: ${config.model}`);
  console.log(`Workspace: ${config.workspaceRoot}`);
  console.log(`Instructions: ${describeWorkspaceInstructions(runtime.workspaceInstructions)}`);
  console.log(`Memory: ${describeWorkspaceMemory(runtime.workspaceMemory.longTerm)}`);
  console.log(`Daily memory: ${describeDailyMemories(runtime.workspaceMemory)}`);
  console.log(`MCP: ${runtime.mcp.serverCount} server(s), ${runtime.mcp.toolCount} tool(s)`);
  console.log("输入 /help 查看命令，输入 /exit 退出。\n");

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
      const command = parseCliCommand(line);
      if (command) {
        if (!isCliCommandName(command.name)) {
          output.write(`[命令] 未知命令 /${command.name || ""}，输入 /help 查看帮助。\n\n`);
          continue;
        }
        if (command.name === "exit") {
          if (command.argument.length > 0) {
            output.write("[命令] /exit 不接受参数。\n\n");
            continue;
          }
          break;
        }

        try {
          const replacement = await executeCliCommand(command.name, command.argument, {
            runtime,
            config,
            instructions: describeWorkspaceInstructions(runtime.workspaceInstructions),
            rl,
          });
          if (replacement) runtime = replacement;
        } catch (error) {
          // 命令失败和普通轮次失败一样不退出 REPL，避免一次摘要或磁盘错误终止会话。
          console.error(formatRuntimeError(error));
          output.write("\n");
        }
        continue;
      }

      const renderer = createTurnRenderer();
      try {
        await runtime.agent.runTurn(
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
    runtime.memoryIndex.close();
    await runtime.mcp.close();
  }
}

interface CliCommandContext {
  runtime: AgentRuntime;
  config: RuntimeConfig;
  instructions: string;
  rl: Interface;
}

async function executeCliCommand(
  command: Exclude<CliCommandName, "exit">,
  argument: string,
  context: CliCommandContext,
): Promise<AgentRuntime | undefined> {
  const requiresArgument = command === "new"
    || command === "switch"
    || command === "rename"
    || command === "delete";
  if (requiresArgument && argument.length === 0) {
    output.write(`[命令] /${command} 需要 Session 名称。\n\n`);
    return undefined;
  }
  if (!requiresArgument && argument.length > 0) {
    output.write(`[命令] /${command} 不接受参数。\n\n`);
    return undefined;
  }

  if (command === "help") {
    output.write(`${CLI_HELP_TEXT}\n\n`);
    return undefined;
  }

  if (command === "status") {
    const memory = await loadWorkspaceMemoryContext(context.config.workspaceRoot);
    output.write(`[状态]
Session: ${context.runtime.sessionId}
Provider: ${context.config.providerName}
Model: ${context.config.model}
Workspace: ${context.config.workspaceRoot}
Instructions: ${context.instructions}
Memory: ${describeWorkspaceMemory(memory.longTerm)}
Daily memory: ${describeDailyMemories(memory)}\n\n`);
    return undefined;
  }

  if (command === "sessions") {
    const sessions = await listSessionIds(context.config.dataRoot, context.config.providerName);
    output.write(`${formatSessionList(sessions, context.runtime.sessionId)}\n\n`);
    return undefined;
  }

  if (command === "new") {
    await createSession(context.config.dataRoot, argument, context.config.providerName);
    const replacement = await createSharedAgentRuntime(argument, context);
    output.write(`[会话] 已新建并切换到 Session ${argument}。\n\n`);
    return replacement;
  }

  if (command === "switch") {
    if (argument === context.runtime.sessionId) {
      output.write(`[会话] 当前已是 Session ${argument}。\n\n`);
      return undefined;
    }
    if (!await sessionExists(context.config.dataRoot, argument, context.config.providerName)) {
      throw new Error(`session not found: ${argument}`);
    }
    const replacement = await createSharedAgentRuntime(argument, context);
    output.write(`[会话] 已切换到 Session ${argument}。\n\n`);
    return replacement;
  }

  if (command === "rename") {
    const oldSessionId = context.runtime.sessionId;
    if (argument === oldSessionId) {
      output.write(`[会话] Session 名称未变。\n\n`);
      return undefined;
    }
    if (await sessionExists(context.config.dataRoot, oldSessionId, context.config.providerName)) {
      await renameSession(
        context.config.dataRoot,
        oldSessionId,
        argument,
        context.config.providerName,
      );
    } else {
      // 启动后还没有消息的默认会话尚无文件，重命名时直接创建新空会话。
      await createSession(context.config.dataRoot, argument, context.config.providerName);
    }
    const replacement = await createSharedAgentRuntime(argument, context);
    output.write(`[会话] Session ${oldSessionId} 已重命名为 ${argument}。\n\n`);
    return replacement;
  }

  if (command === "delete") {
    const answer = (await context.rl.question(
      `确认删除 Session ${argument} 的全部历史？[y/N] `,
    )).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      output.write("[会话] 已取消删除。\n\n");
      return undefined;
    }
    await deleteSession(context.config.dataRoot, argument, context.config.providerName);
    if (argument !== context.runtime.sessionId) {
      output.write(`[会话] Session ${argument} 已删除。\n\n`);
      return undefined;
    }

    const remaining = await listSessionIds(context.config.dataRoot, context.config.providerName);
    const nextSessionId = remaining[0] ?? "default";
    if (remaining.length === 0) {
      await createSession(context.config.dataRoot, nextSessionId, context.config.providerName);
    }
    const replacement = await createSharedAgentRuntime(nextSessionId, context);
    output.write(`[会话] Session ${argument} 已删除，已切换到 ${nextSessionId}。\n\n`);
    return replacement;
  }

  if (command === "history") {
    const history = await loadSessionHistory(context.config, context.runtime.sessionId);
    output.write(`${formatSessionHistory(history)}\n\n`);
    return undefined;
  }

  if (command === "mcp") {
    output.write(`${formatMcpStatus(context.runtime.mcp.getStatus())}\n\n`);
    return undefined;
  }

  if (command === "memory") {
    const contextMemory = await loadWorkspaceMemoryContext(context.config.workspaceRoot);
    const blocks: string[] = [];
    const longTerm = contextMemory.longTerm;
    if (longTerm && longTerm.content.trim().length > 0) {
      const notice = longTerm.truncated
        ? `\n[提示] 文件共 ${longTerm.bytes} bytes，当前只注入和展示前 ${longTerm.injectedBytes} bytes。`
        : "";
      blocks.push(`[长期记忆] ${longTerm.relativePath}\n${longTerm.content}${notice}`);
    } else {
      blocks.push("[长期记忆] MEMORY.md 不存在或内容为空。");
    }
    if (contextMemory.daily.length === 0) {
      blocks.push(`[每日记忆] ${contextMemory.yesterday} 和 ${contextMemory.today} 暂无记忆文件。`);
    } else {
      for (const daily of contextMemory.daily) {
        const notice = daily.truncated
          ? `\n[提示] 文件共 ${daily.bytes} bytes，当前注入和展示 ${daily.injectedBytes} bytes。`
          : "";
        blocks.push(`[每日记忆] ${daily.relativePath}\n${daily.content}${notice}`);
      }
      if (contextMemory.discoveredDailyFiles > contextMemory.daily.length) {
        blocks.push(`[提示] 匹配 ${contextMemory.discoveredDailyFiles} 个每日记忆文件，受文件数/字节预算限制，展示 ${contextMemory.daily.length} 个。`);
      }
    }
    output.write(`${blocks.join("\n\n")}\n\n`);
    return undefined;
  }

  if (command === "compact") {
    const renderer = createTurnRenderer();
    try {
      const result = await context.runtime.agent.compactContext(renderer.handle);
      if (!result) {
        output.write("[会话] 没有可压缩的早期历史；需超过保留轮次数。\n");
      }
    } finally {
      renderer.finish();
    }
    return undefined;
  }

  // /clear 是不可恢复操作，仍沿用工具确认的安全默认值：仅 y/yes 继续。
  const answer = (await context.rl.question(
    `确认清空 Session ${context.runtime.sessionId} 的全部历史？[y/N] `,
  )).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    output.write("[会话] 已取消清空。\n\n");
    return undefined;
  }
  await context.runtime.agent.clearHistory();
  output.write(`[会话] Session ${context.runtime.sessionId} 的历史已清空。\n\n`);
  return undefined;
}

function createSharedAgentRuntime(
  sessionId: string,
  context: CliCommandContext,
): Promise<AgentRuntime> {
  // workspaceInstructions 是启动快照，记忆索引和 MCP 由各 Session 共享；MEMORY.md 由 AgentLoop
  // 在每次模型调用前重新加载，无需从旧 runtime 传入。
  return createAgentRuntime(sessionId, context.config, {
    workspaceInstructions: context.runtime.workspaceInstructions,
    memoryIndex: context.runtime.memoryIndex,
    mcp: context.runtime.mcp,
  });
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
