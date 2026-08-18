import { executeTool, requiresToolConfirmation, type ToolContext } from "./tools.js";
import type { MemoryFlushHandler } from "./memory-flush.js";
import {
  type MemoryConsolidationApplyResult,
  type MemoryConsolidationPlan,
  WorkspaceMemoryConsolidator,
} from "./memory-consolidation.js";
import type { TaskPlan } from "./task-plan.js";
import type { UserAttachment } from "./attachments.js";

export const DEFAULT_SYSTEM_PROMPT = `You are OpenClaw Mini, a local single-user assistant.`;

export interface ToolCallRequest {
  // id 由 Provider API 生成，回填工具结果时必须原样使用。
  id: string;
  name: string;
  input: unknown;
  // Provider 解析参数失败时不终止整轮，而是把错误交给统一工具结果流程。
  inputError?: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

export interface ToolConfirmationRequest {
  toolCallId: string;
  name: string;
  input: unknown;
}

export type ToolConfirmationHandler = (request: ToolConfirmationRequest) => boolean | Promise<boolean>;
export type ToolExecutor = (name: string, input: unknown, context: ToolContext) => Promise<string>;

export type AgentEvent =
  | { type: "text_delta"; text: string }
  // start 事件在摘要 API 请求发出前触发，用于给慢请求提供终端反馈。
  | { type: "context_compaction_start"; estimatedTokens: number }
  // end 事件只在摘要和历史替换都成功后触发。
  | { type: "context_compaction_end"; beforeTokens: number; afterTokens: number }
  // Memory Flush 发生在摘要生成后、原生历史替换前。它是压缩生命周期的一部分，
  // 但写入失败不会阻止后续压缩，所以成功和失败使用独立事件表达。
  | { type: "memory_flush_start" }
  | { type: "memory_flush_end"; path: string; written: boolean; bytesWritten: number }
  | { type: "memory_flush_error"; message: string }
  | { type: "tool_pending"; toolCallId: string; name: string; input: unknown }
  | { type: "tool_approved"; toolCallId: string; name: string }
  | { type: "tool_denied"; toolCallId: string; name: string }
  | { type: "tool_start"; toolCallId: string; name: string }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean }
  // update_plan 可能和同一批其他工具并行执行；全部完成后只广播最终落盘版本。
  | { type: "plan_updated"; plan: TaskPlan };

export type AgentEventHandler = (event: AgentEvent) => void;
export type TextDeltaHandler = (text: string) => void;

export interface ContextCompactionResult {
  // 两个数字都是统一估算器的结果，用于 CLI 观察压缩效果，不代表 API 计费 token。
  beforeTokens: number;
  afterTokens: number;
}

export type ProviderTurn =
  // Provider 将厂商原生 tool_use/function_call 归一化为可能包含多个调用的列表。
  | {
      type: "tool_calls";
      calls: ToolCallRequest[];
    }
  // 所有不再需要工具的终态都收敛为 final，stopReason 保留厂商状态便于观察。
  | {
      type: "final";
      text: string;
      stopReason: string;
    };

// AgentLoop 只依赖这些统一语义动作，不了解 Anthropic content block 或 OpenAI response item。
// 各 Provider 负责把统一动作转换成自己的 API 格式，并保存必须原样回放的原生历史。
export interface AgentProvider {
  // 可选方法使无历史或不支持压缩的 Provider 仍可复用 AgentLoop。
  // 具体 Provider 拥有原生历史，因此由它负责找安全切分点并生成合法替换结构。
  compactHistoryIfNeeded?(
    onStart?: (estimatedTokens: number) => void,
    force?: boolean,
    // Provider 在生成有效摘要后、替换历史前调用。AgentLoop 用它把同一份摘要持久化
    // 到每日记忆；回调由 Provider await，保证不会先丢弃历史再尝试保存。
    onSummary?: (summary: string) => Promise<void>,
  ): Promise<ContextCompactionResult | undefined>;
  // 清空同样由 Provider 执行，确保内存中的原生历史和持久化 JSONL 一起替换。
  clearHistory?(): Promise<void>;
  addUserText(text: string, attachments?: readonly UserAttachment[]): Promise<void>;
  generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn>;
  addToolResults(results: ToolExecutionResult[]): Promise<void>;
  // 记忆整理是独立的无工具请求，不追加到普通 Session 历史。Provider 只负责调用
  // 当前模型并返回候选文本，文件读取、校验、预览和写入全部留在宿主层。
  generateMemoryConsolidation?(request: string): Promise<string>;
}

export interface AgentLoopOptions {
  provider: AgentProvider;
  toolContext: ToolContext;
  // 静态字符串适合测试；异步 resolver 允许运行时在每次模型调用前
  // 重新读取 MEMORY.md 等可由用户/工具直接修改的上下文文件。
  systemPrompt?: string | (() => string | Promise<string>);
  maxIterations?: number;
  toolExecutor?: ToolExecutor;
  memoryFlush?: MemoryFlushHandler;
  memoryConsolidator?: WorkspaceMemoryConsolidator;
}

export interface TurnResult {
  text: string;
  stopReason: string;
}

// 唯一的模型-工具循环。
// Provider 只负责协议适配；工具执行、并行调度、错误回填和迭代上限都在这里复用。
export class AgentLoop {
  private readonly provider: AgentProvider;
  private readonly toolContext: ToolContext;
  private readonly systemPrompt: string | (() => string | Promise<string>);
  private readonly maxIterations: number;
  private readonly toolExecutor: ToolExecutor;
  private readonly memoryFlush?: MemoryFlushHandler;
  private readonly memoryConsolidator?: WorkspaceMemoryConsolidator;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.toolContext = options.toolContext;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    // 迭代上限防止模型在“调工具 -> 看结果 -> 再调工具”中无限循环。
    this.maxIterations = options.maxIterations ?? 8;
    // 正常运行使用 executeTool；可注入执行器便于测试“拒绝后绝对不执行”等调度语义。
    this.toolExecutor = options.toolExecutor ?? executeTool;
    this.memoryFlush = options.memoryFlush;
    this.memoryConsolidator = options.memoryConsolidator;
  }

  async runTurn(
    userText: string,
    onEvent?: AgentEventHandler,
    confirmTool?: ToolConfirmationHandler,
    attachments: readonly UserAttachment[] = [],
  ): Promise<TurnResult> {
    // 压缩必须放在 addUserText 之前：
    // 1. 此时上一轮已经完整结束，不会把当前工具调用链拦腰切断；
    // 2. 新的用户问题不会被误放进“早期历史”摘要；
    // 3. 摘要失败时还没有持久化本轮用户消息，用户可以安全重试。
    await this.compactContextIfAvailable(onEvent, false);

    // 附件与真实用户文本组成同一条 Provider 原生消息，这样图片不是工具输出，
    // 文本附件也不会被误当成更高优先级的 system 指令。
    await this.provider.addUserText(userText, attachments);

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      // 每次循环对应一次模型调用。一轮对话可能因工具结果回填而经历多次模型调用。
      // streamedText 只记录当前这次调用，用来判断 final text 是否已经通过 delta 显示过。
      let streamedText = "";
      // 一轮可能因工具调用经历多次 generateTurn。每次都解析 system prompt，
      // 因此模型刚用工具编辑 MEMORY.md 后，下一次调用就能读到新记忆。
      const systemPrompt = typeof this.systemPrompt === "function"
        ? await this.systemPrompt()
        : this.systemPrompt;
      const turn = await this.provider.generateTurn(systemPrompt, onEvent ? (text) => {
        streamedText += text;
        onEvent({ type: "text_delta", text });
      } : undefined);
      if (turn.type === "final") {
        emitUnstreamedFinalText(turn.text, streamedText, onEvent);
        return { text: turn.text, stopReason: turn.stopReason };
      }

      // 确认必须串行进行，避免 CLI 同时出现多个 readline 提示。
      // 完成确认后，允许执行的工具仍然通过 Promise.all 并行运行。
      const decisions: Array<{ call: ToolCallRequest; approved: boolean }> = [];
      for (const call of turn.calls) {
        // 自动放行表只包含纯计算/只读工具；未登记工具会走默认拒绝的确认分支。
        if (!requiresToolConfirmation(call.name)) {
          decisions.push({ call, approved: true });
          continue;
        }

        const request: ToolConfirmationRequest = {
          toolCallId: call.id,
          name: call.name,
          input: call.input,
        };
        onEvent?.({ type: "tool_pending", ...request });

        let approved = false;
        try {
          approved = confirmTool ? await confirmTool(request) : false;
        } catch {
          // 确认回调失败时按拒绝处理；安全默认值不能是继续执行。
          approved = false;
        }

        onEvent?.({
          type: approved ? "tool_approved" : "tool_denied",
          toolCallId: call.id,
          name: call.name,
        });
        decisions.push({ call, approved });
      }

      const results = await Promise.all(
        // Promise.all 保留输入数组的结果顺序，即使各工具完成先后不同，
        // 回填给 Provider 的顺序仍与模型原始 calls 一致。
        decisions.map(async ({ call, approved }): Promise<ToolExecutionResult> => {
          if (!approved) {
            // 拒绝不抛出宿主异常，而是形成可回放的错误工具结果。
            // 这样模型能解释操作被取消，或改用无工具方案继续回复。
            return {
              toolCallId: call.id,
              output: `Tool execution denied by user: ${call.name}`,
              isError: true,
            };
          }

          onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name });
          let result: ToolExecutionResult;
          try {
            if (call.inputError) {
              // 参数在 Provider 层已发现无法解析，必须在调用 toolExecutor 前转成错误。
              throw new Error(call.inputError);
            }
            result = {
              toolCallId: call.id,
              output: await this.toolExecutor(call.name, call.input, this.toolContext),
              isError: false,
            };
          } catch (error) {
            result = {
              toolCallId: call.id,
              output: error instanceof Error ? error.message : String(error),
              isError: true,
            };
          }
          onEvent?.({ type: "tool_end", toolCallId: call.id, name: call.name, isError: result.isError });
          return result;
        }),
      );

      const planWasUpdated = results.some((result, index) => (
        !result.isError && decisions[index]?.call.name === "update_plan"
      ));
      if (planWasUpdated && this.toolContext.taskPlan) {
        // 不根据模型参数或工具返回字符串拼装 UI 状态，而是读取 Store 最终落盘值。
        // 同一模型响应即使错误地发出多个 update_plan，也只展示队列执行后的最终计划。
        const plan = await this.toolContext.taskPlan.loadPlan();
        if (plan) onEvent?.({ type: "plan_updated", plan });
      }

      // 工具结果回填后不立即返回用户，而是进入下一次模型迭代。
      // 模型可以基于结果组织最终答案，或者发起下一组工具调用。
      await this.provider.addToolResults(results);
    }

    const text = "Agent Loop 达到最大工具迭代次数。";
    emitUnstreamedFinalText(text, "", onEvent);
    return { text, stopReason: "iteration_limit" };
  }

  // CLI 的 /compact 使用同一套 Provider 摘要逻辑，只跳过 token 阈值判断。
  // 安全切分规则仍然生效：没有足够的早期完整轮次时返回 undefined，不强拆工具链。
  async compactContext(
    onEvent?: AgentEventHandler,
  ): Promise<ContextCompactionResult | undefined> {
    return this.compactContextIfAvailable(onEvent, true);
  }

  async prepareMemoryConsolidation(): Promise<MemoryConsolidationPlan | undefined> {
    if (!this.memoryConsolidator || !this.provider.generateMemoryConsolidation) {
      throw new Error("current provider does not support memory consolidation");
    }
    // bind 由闭包隐式完成，Provider 方法内部仍可安全访问 client/model 私有字段。
    return this.memoryConsolidator.prepare((request) => (
      this.provider.generateMemoryConsolidation?.(request)
      ?? Promise.reject(new Error("current provider does not support memory consolidation"))
    ));
  }

  applyMemoryConsolidation(
    plan: MemoryConsolidationPlan,
  ): Promise<MemoryConsolidationApplyResult> {
    if (!this.memoryConsolidator) {
      throw new Error("memory consolidation is not configured");
    }
    return this.memoryConsolidator.apply(plan);
  }

  // 先让 Provider 持久化空历史，成功后 Provider 才会清空内存。
  // 不支持清空的测试/第三方 Provider 会明确报错，而不是只清掉一侧状态。
  async clearHistory(): Promise<void> {
    if (!this.provider.clearHistory) {
      throw new Error("current provider does not support clearing history");
    }
    await this.provider.clearHistory();
  }

  private async compactContextIfAvailable(
    onEvent: AgentEventHandler | undefined,
    force: boolean,
  ): Promise<ContextCompactionResult | undefined> {
    const compaction = await this.provider.compactHistoryIfNeeded?.((estimatedTokens) => {
      onEvent?.({ type: "context_compaction_start", estimatedTokens });
    }, force, this.memoryFlush ? async (summary) => {
      onEvent?.({ type: "memory_flush_start" });
      try {
        const result = await this.memoryFlush?.(summary);
        if (result) onEvent?.({ type: "memory_flush_end", ...result });
      } catch (error) {
        // 记忆是压缩前的额外耐久层；磁盘只读、文件过大等错误不应让上下文永远无法
        // 压缩。事件仍把原因暴露给 CLI/Web，用户可修复后在下一次压缩重试。
        onEvent?.({
          type: "memory_flush_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } : undefined);

    if (compaction) {
      // Provider 返回结果意味着新历史已持久化并替换内存，此时才对外宣布完成。
      onEvent?.({ type: "context_compaction_end", ...compaction });
    }
    return compaction;
  }
}

function emitUnstreamedFinalText(
  finalText: string,
  streamedText: string,
  onEvent?: AgentEventHandler,
): void {
  // 没有 renderer 时调用方只使用 TurnResult，不需要生成事件。
  if (!onEvent || finalText.length === 0) return;
  if (streamedText.length === 0) {
    // Provider 不支持流式时，把完整结果伪装成一个 delta，CLI 渲染器无需分两套代码。
    onEvent({ type: "text_delta", text: finalText });
    return;
  }

  // Provider 的最终文本可能追加 max_tokens / incomplete 提示；只补发未出现在流中的后缀。
  // 如果 finalText 与已流式显示的文本不是前缀关系，宁可不重复输出，也不把两个版本拼在一起。
  const normalizedStreamedText = streamedText.trim();
  if (normalizedStreamedText.length > 0 && finalText.startsWith(normalizedStreamedText)) {
    const suffix = finalText.slice(normalizedStreamedText.length);
    if (suffix.length > 0) {
      onEvent({ type: "text_delta", text: suffix });
    }
  }
}
