import { executeTool, type ToolContext } from "./tools.js";

export const DEFAULT_SYSTEM_PROMPT = `You are OpenClaw Mini, a local single-user assistant.
Answer concisely and directly.
Use calculator when arithmetic is needed.
Use read_text_file only for files inside the configured workspace.
You cannot write files, run shell commands, browse the web, or access files outside the workspace.`;

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
  generateTurn(instructions: string): Promise<ProviderTurn>;
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

  async runTurn(userText: string): Promise<TurnResult> {
    await this.provider.addUserText(userText);

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const turn = await this.provider.generateTurn(this.systemPrompt);
      if (turn.type === "final") {
        return { text: turn.text, stopReason: turn.stopReason };
      }

      const results = await Promise.all(
        turn.calls.map(async (call): Promise<ToolExecutionResult> => {
          try {
            if (call.inputError) {
              throw new Error(call.inputError);
            }
            return {
              toolCallId: call.id,
              output: await executeTool(call.name, call.input, this.toolContext),
              isError: false,
            };
          } catch (error) {
            return {
              toolCallId: call.id,
              output: error instanceof Error ? error.message : String(error),
              isError: true,
            };
          }
        }),
      );

      await this.provider.addToolResults(results);
    }

    return { text: "Agent Loop 达到最大工具迭代次数。", stopReason: "iteration_limit" };
  }
}
