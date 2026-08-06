import { executeTool, type ToolContext } from "./tools.js";

export const DEFAULT_SYSTEM_PROMPT = `You are OpenClaw Mini, a local single-user assistant.`;

export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
  inputError?: string;
}

export interface ToolExecutionResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolCallId: string; name: string }
  | { type: "tool_end"; toolCallId: string; name: string; isError: boolean };

export type AgentEventHandler = (event: AgentEvent) => void;
export type TextDeltaHandler = (text: string) => void;

export type ProviderTurn =
  | {
      type: "tool_calls";
      calls: ToolCallRequest[];
    }
  | {
      type: "final";
      text: string;
      stopReason: string;
    };

// AgentLoop 只依赖这三个语义动作，不了解 Anthropic content block 或 OpenAI response item。
// 各 Provider 负责把统一动作转换成自己的 API 格式，并保存必须原样回放的原生历史。
export interface AgentProvider {
  addUserText(text: string): Promise<void>;
  generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn>;
  addToolResults(results: ToolExecutionResult[]): Promise<void>;
}

export interface AgentLoopOptions {
  provider: AgentProvider;
  toolContext: ToolContext;
  systemPrompt?: string;
  maxIterations?: number;
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
  private readonly systemPrompt: string;
  private readonly maxIterations: number;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.toolContext = options.toolContext;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxIterations = options.maxIterations ?? 8;
  }

  async runTurn(userText: string, onEvent?: AgentEventHandler): Promise<TurnResult> {
    await this.provider.addUserText(userText);

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      let streamedText = "";
      const turn = await this.provider.generateTurn(this.systemPrompt, onEvent ? (text) => {
        streamedText += text;
        onEvent({ type: "text_delta", text });
      } : undefined);
      if (turn.type === "final") {
        emitUnstreamedFinalText(turn.text, streamedText, onEvent);
        return { text: turn.text, stopReason: turn.stopReason };
      }

      const results = await Promise.all(
        turn.calls.map(async (call): Promise<ToolExecutionResult> => {
          onEvent?.({ type: "tool_start", toolCallId: call.id, name: call.name });
          let result: ToolExecutionResult;
          try {
            if (call.inputError) {
              throw new Error(call.inputError);
            }
            result = {
              toolCallId: call.id,
              output: await executeTool(call.name, call.input, this.toolContext),
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

      await this.provider.addToolResults(results);
    }

    const text = "Agent Loop 达到最大工具迭代次数。";
    emitUnstreamedFinalText(text, "", onEvent);
    return { text, stopReason: "iteration_limit" };
  }
}

function emitUnstreamedFinalText(
  finalText: string,
  streamedText: string,
  onEvent?: AgentEventHandler,
): void {
  if (!onEvent || finalText.length === 0) return;
  if (streamedText.length === 0) {
    onEvent({ type: "text_delta", text: finalText });
    return;
  }

  // Provider 的最终文本可能追加 max_tokens / incomplete 提示；只补发未出现在流中的后缀。
  const normalizedStreamedText = streamedText.trim();
  if (normalizedStreamedText.length > 0 && finalText.startsWith(normalizedStreamedText)) {
    const suffix = finalText.slice(normalizedStreamedText.length);
    if (suffix.length > 0) {
      onEvent({ type: "text_delta", text: suffix });
    }
  }
}
