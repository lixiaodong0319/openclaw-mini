import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentProvider,
  ContextCompactionResult,
  ProviderTurn,
  TextDeltaHandler,
  ToolExecutionResult,
} from "./agent-loop.js";
import {
  CONTEXT_SUMMARY_ACK,
  CONTEXT_SUMMARY_INSTRUCTIONS,
  CONTEXT_SUMMARY_PREFIX,
  buildCompactionTranscript,
  estimateContextTokens,
  findRecentHistoryStart,
  resolveContextCompactionOptions,
  type ContextCompactionOptions,
} from "./context-compaction.js";
import {
  openAIToolDefinitions,
  toolDefinitions,
  type OpenAIToolDefinition,
} from "./tools.js";

// 低层客户端接口用于注入官方 SDK 或 Fake Provider。
export interface MessageProvider {
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  streamMessage?(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onTextDelta: TextDeltaHandler,
  ): Promise<Anthropic.Message>;
}

export interface AnthropicProviderOptions {
  client?: MessageProvider;
  model: string;
  messages: Anthropic.MessageParam[];
  // 普通对话逐条 append，不必每轮重写整个 JSONL。
  onMessage?: (message: Anthropic.MessageParam) => Promise<void>;
  // 只有压缩成功时使用：宿主需用新历史原子替换旧 JSONL。
  onHistoryReplace?: (messages: Anthropic.MessageParam[]) => Promise<void>;
  compaction?: Partial<ContextCompactionOptions>;
}

// Anthropic Messages API 适配器。
// 它把原生 content blocks 转换成统一 ProviderTurn，同时保留 thinking/tool_use 原始历史。
export class AnthropicProvider implements AgentProvider, MessageProvider {
  private readonly client: MessageProvider;
  private readonly model: string;
  private readonly messages: Anthropic.MessageParam[];
  private readonly onMessage?: (message: Anthropic.MessageParam) => Promise<void>;
  private readonly onHistoryReplace?: (messages: Anthropic.MessageParam[]) => Promise<void>;
  private readonly compaction: ContextCompactionOptions;

  constructor(options?: AnthropicProviderOptions) {
    if (options) {
      this.client = options.client ?? new AnthropicSDKClient();
      this.model = options.model;
      this.messages = options.messages;
      this.onMessage = options.onMessage;
      this.onHistoryReplace = options.onHistoryReplace;
      this.compaction = resolveContextCompactionOptions(options.compaction);
      return;
    }

    // 保留旧的低层 MessageProvider 构造方式，便于独立转发 SDK 请求。
    this.client = new AnthropicSDKClient();
    this.model = getModelId();
    this.messages = [];
    this.compaction = resolveContextCompactionOptions();
  }

  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.client.createMessage(params);
  }

  async compactHistoryIfNeeded(
    onStart?: (estimatedTokens: number) => void,
  ): Promise<ContextCompactionResult | undefined> {
    // 第一层是廉价判断：未达阈值时不找切分点，更不发额外 API 请求。
    const beforeTokens = estimateContextTokens(this.messages);
    if (beforeTokens < this.compaction.tokenThreshold) {
      return undefined;
    }

    // Anthropic 把工具结果表示为 role=user 的 tool_result content block。
    // 所以不能简单地把每个 user role 都当成新一轮，isAnthropicUserTurnStart
    // 会识别真实用户文本，以此保证 tool_use 和 tool_result 不被拆开。
    const recentStart = findRecentHistoryStart(
      this.messages,
      this.compaction.keepRecentTurns,
      isAnthropicUserTurnStart,
    );
    if (recentStart === undefined || recentStart === 0) {
      // 没有足够的早期轮次可供摘要时，宁可暂时不压缩，
      // 也不突破 keepRecentTurns 配置或用半条工具链作为切分点。
      return undefined;
    }

    // 到这里已确定真的会发送摘要请求，此时再通知 CLI，
    // 避免只因为超过阈值但没有可压缩轮次就显示“正在压缩”。
    onStart?.(beforeTokens);

    // earlierHistory 会被摘要替代；recentHistory 必须保持原生 block 不变，
    // 因为 thinking signature、tool_use id 和 tool_result id 都需在后续 API 请求中原样回放。
    const earlierHistory = this.messages.slice(0, recentStart);
    const recentHistory = this.messages.slice(recentStart);

    // 摘要是一次独立的无工具模型调用。返回的 assistant message 不走 addMessage，
    // 否则“生成摘要时的临时请求”会被错当成真实会话历史持久化。
    const summaryResponse = await this.client.createMessage({
      model: this.model,
      max_tokens: this.compaction.summaryMaxTokens,
      system: [{ type: "text", text: CONTEXT_SUMMARY_INSTRUCTIONS }],
      messages: [{
        role: "user",
        content: [{ type: "text", text: buildCompactionTranscript(earlierHistory) }],
      }],
    });
    const summary = extractText(summaryResponse.content);
    if (summary.length === 0) {
      throw new Error("context compaction returned an empty summary");
    }

    // Messages API 历史中没有可直接持久化的 system role，因此摘要用带标记的 user 消息保存。
    // 紧跟固定 assistant ACK 可以结束这个合成轮次，让 recentHistory 从 user role 正常接续。
    const replacement: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: `${CONTEXT_SUMMARY_PREFIX}${summary}` }] },
      { role: "assistant", content: [{ type: "text", text: CONTEXT_SUMMARY_ACK }] },
      ...recentHistory,
    ];
    // 先持久化，后替换内存。如果磁盘写入失败，内存仍保留原历史，
    // 不会出现“当前进程已压缩，重启后又回到旧历史”的分叉状态。
    await this.onHistoryReplace?.(replacement);
    this.messages.splice(0, this.messages.length, ...replacement);
    return {
      beforeTokens,
      afterTokens: estimateContextTokens(replacement),
    };
  }

  async addUserText(text: string): Promise<void> {
    await this.addMessage({ role: "user", content: [{ type: "text", text }] });
  }

  async generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn> {
    // Provider 在这里组装厂商原生请求；AgentLoop 只传入系统指令和可选文本增量回调。
    // 无论最终走流式还是非流式，都必须得到一个完整 Message，因为原生 content blocks 要持久化。
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: instructions }],
      tools: toolDefinitions,
      messages: normalizeMessages(this.messages),
    };
    const response = onTextDelta && this.client.streamMessage
      ? await this.client.streamMessage(params, onTextDelta)
      : await this.client.createMessage(params);

    // thinking、tool_use 和 text blocks 必须原样保存，后续请求才能正确 replay。
    await this.addMessage({ role: "assistant", content: response.content });

    // stop_reason 是 Anthropic 协议状态，在适配器边界转成 AgentLoop 只需理解的 final / tool_calls。
    if (response.stop_reason === "end_turn") {
      return { type: "final", text: extractText(response.content), stopReason: response.stop_reason };
    }
    if (response.stop_reason === "refusal") {
      return { type: "final", text: "模型拒绝了本次请求。", stopReason: response.stop_reason };
    }
    if (response.stop_reason === "max_tokens") {
      return {
        type: "final",
        text: `${extractText(response.content)}\n\n[输出达到 max_tokens 上限，结果可能不完整。]`.trim(),
        stopReason: response.stop_reason,
      };
    }
    if (response.stop_reason !== "tool_use") {
      return {
        type: "final",
        text: `模型以未处理状态结束：${response.stop_reason ?? "unknown"}`,
        stopReason: response.stop_reason ?? "unknown",
      };
    }

    const toolUses = response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (toolUses.length === 0) {
      return {
        type: "final",
        text: "模型请求工具但没有提供 tool_use 内容。",
        stopReason: response.stop_reason,
      };
    }

    return {
      type: "tool_calls",
      calls: toolUses.map((toolUse) => ({
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      })),
    };
  }

  async addToolResults(results: ToolExecutionResult[]): Promise<void> {
    // Anthropic 要求 tool_result 作为下一条 user message 回传，
    // tool_use_id 必须与 assistant tool_use block 的 id 一一对应。
    const content: Anthropic.ToolResultBlockParam[] = results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.toolCallId,
      content: [{ type: "text", text: result.output }],
      ...(result.isError ? { is_error: true } : {}),
    }));
    await this.addMessage({ role: "user", content });
  }

  private async addMessage(message: Anthropic.MessageParam): Promise<void> {
    // 先更新共享内存数组，再等待持久化回调。
    // 整个 AgentLoop 是串行的，因此下一次 API 调用不会越过这次 JSONL append。
    this.messages.push(message);
    await this.onMessage?.(message);
  }
}

class AnthropicSDKClient implements MessageProvider {
  private readonly client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.client.messages.create(params);
  }

  async streamMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onTextDelta: TextDeltaHandler,
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(params);
    stream.on("text", (textDelta) => onTextDelta(textDelta));
    return stream.finalMessage();
  }
}

export function getModelId(): string {
  return process.env.OPENCLAW_MODEL || "anthropic/claude-opus-4.8";
}

function normalizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  // 早期会话文件可能使用 content: string。在发送 API 前统一转成 text block，
  // 新数据则始终保存原生 block 数组，不在磁盘上做破坏性迁移。
  return messages.map((message) => {
    if (typeof message.content !== "string") {
      return message;
    }
    return { ...message, content: [{ type: "text", text: message.content }] };
  });
}

function isAnthropicUserTurnStart(message: Anthropic.MessageParam): boolean {
  // assistant 当然不是轮次起点。
  if (message.role !== "user") return false;
  if (typeof message.content === "string") {
    // 兼容旧 session 中直接使用 string content 的消息，同时排除之前生成的压缩摘要。
    return !message.content.startsWith(CONTEXT_SUMMARY_PREFIX);
  }
  if (message.content.some((block) => block.type === "tool_result")) {
    // Anthropic 将工具结果包在 user role 中，但它仍属于前一个真实用户轮次。
    return false;
  }
  const text = message.content
    .filter((block): block is Anthropic.TextBlockParam => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return !text.startsWith(CONTEXT_SUMMARY_PREFIX);
}

function extractText(content: Anthropic.Message["content"]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// 以下是 OpenAI Responses API 的原生输入、输出和低层客户端类型。
// 它们与 Anthropic 类型放在同一个 Provider 模块中，但不会泄漏到统一 AgentLoop。
export interface OpenAIUserInput {
  role: "user";
  content: string;
}

export interface OpenAIFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface OpenAIResponseItem {
  type: string;
  [key: string]: unknown;
}

export type OpenAIInputItem = OpenAIUserInput | OpenAIFunctionCallOutput | OpenAIResponseItem;

export interface OpenAIResponse {
  id: string;
  status?: string;
  output: OpenAIResponseItem[];
  output_text?: string;
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
}

export interface OpenAIResponseCreateParams {
  model: string;
  instructions: string;
  input: OpenAIInputItem[];
  tools: OpenAIToolDefinition[];
  max_output_tokens?: number;
}

export interface OpenAIResponseClient {
  createResponse(params: OpenAIResponseCreateParams): Promise<OpenAIResponse>;
  streamResponse?(
    params: OpenAIResponseCreateParams,
    onTextDelta: TextDeltaHandler,
  ): Promise<OpenAIResponse>;
}

export interface OpenAIClientOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  fetch?: typeof fetch;
}

export interface OpenAIProviderOptions {
  client?: OpenAIResponseClient;
  model: string;
  input: OpenAIInputItem[];
  // 普通 Responses item 按 API 返回顺序逐条追加。
  onItem?: (item: OpenAIInputItem) => Promise<void>;
  // 压缩后整体替换 OpenAI namespace 下的 session JSONL。
  onHistoryReplace?: (items: OpenAIInputItem[]) => Promise<void>;
  compaction?: Partial<ContextCompactionOptions>;
}

interface FunctionCallItem extends OpenAIResponseItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

export class OpenAIAPIError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "OpenAIAPIError";
    this.status = options.status;
    this.code = options.code;
  }
}

export class OpenAIAuthenticationError extends OpenAIAPIError {
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAIAuthenticationError";
  }
}

export class OpenAIRateLimitError extends OpenAIAPIError {
  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAIRateLimitError";
  }
}

export class OpenAIConnectionError extends OpenAIAPIError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "OpenAIConnectionError";
  }
}

// OpenAI 的 AgentProvider 适配器。统一 AgentLoop 不需要知道 Responses API 的 item 格式。
export class OpenAIProvider implements AgentProvider {
  private readonly client: OpenAIResponseClient;
  private readonly model: string;
  private readonly input: OpenAIInputItem[];
  private readonly onItem?: (item: OpenAIInputItem) => Promise<void>;
  private readonly onHistoryReplace?: (items: OpenAIInputItem[]) => Promise<void>;
  private readonly compaction: ContextCompactionOptions;

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client ?? new OpenAIHTTPClient();
    this.model = options.model;
    this.input = options.input;
    this.onItem = options.onItem;
    this.onHistoryReplace = options.onHistoryReplace;
    this.compaction = resolveContextCompactionOptions(options.compaction);
  }

  async compactHistoryIfNeeded(
    onStart?: (estimatedTokens: number) => void,
  ): Promise<ContextCompactionResult | undefined> {
    // OpenAI 与 Anthropic 共用同一个估算和保留策略，但不共用历史数据格式。
    const beforeTokens = estimateContextTokens(this.input);
    if (beforeTokens < this.compaction.tokenThreshold) {
      return undefined;
    }

    // Responses API 一轮中可以包含 reasoning、function_call、function_call_output 和 message。
    // 只有宿主追加的 { role: "user", content: string } 才是真实轮次起点。
    const recentStart = findRecentHistoryStart(
      this.input,
      this.compaction.keepRecentTurns,
      isOpenAIUserTurnStart,
    );
    if (recentStart === undefined || recentStart === 0) {
      return undefined;
    }

    onStart?.(beforeTokens);

    // recentHistory 整段保留，所以 function_call.call_id 与 function_call_output.call_id
    // 以及它们前后的 reasoning item 仍然是一条合法的 Responses API 回放链。
    const earlierHistory = this.input.slice(0, recentStart);
    const recentHistory = this.input.slice(recentStart);
    // tools: [] 显式禁用工具；压缩请求只需生成摘要，
    // 不允许它因为看到历史中的用户任务而再次执行工具。
    const summaryResponse = await this.client.createResponse({
      model: this.model,
      instructions: CONTEXT_SUMMARY_INSTRUCTIONS,
      input: [{ role: "user", content: buildCompactionTranscript(earlierHistory) }],
      tools: [],
      max_output_tokens: this.compaction.summaryMaxTokens,
    });
    if (summaryResponse.status === "failed") {
      throw new Error(summaryResponse.error?.message ?? "context compaction failed");
    }
    const summary = extractOpenAIText(summaryResponse);
    if (summary.length === 0) {
      throw new Error("context compaction returned an empty summary");
    }

    // Responses API 允许直接回放 user input item，所以不需要 Anthropic 的合成 ACK。
    // 前缀同样会让下一次压缩忽略这条合成 user item。
    const replacement: OpenAIInputItem[] = [
      { role: "user", content: `${CONTEXT_SUMMARY_PREFIX}${summary}` },
      ...recentHistory,
    ];
    // 与 Anthropic 一致：持久化是内存切换的前置条件。
    await this.onHistoryReplace?.(replacement);
    this.input.splice(0, this.input.length, ...replacement);
    return {
      beforeTokens,
      afterTokens: estimateContextTokens(replacement),
    };
  }

  async addUserText(text: string): Promise<void> {
    await this.addOpenAIItem({ role: "user", content: text });
  }

  async generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn> {
    // Responses API 使用一个有序 item 数组回放历史。
    // 数组中不仅有 user/assistant message，还有 reasoning 和函数调用协议 item。
    const params: OpenAIResponseCreateParams = {
      model: this.model,
      instructions,
      input: this.input,
      tools: openAIToolDefinitions,
    };
    const response = onTextDelta && this.client.streamResponse
      ? await this.client.streamResponse(params, onTextDelta)
      : await this.client.createResponse(params);

    // 官方流程要求完整回放 response.output；reasoning item 也必须保留。
    await this.addOpenAIItems(response.output);

    // 一次 response 可同时返回多个 function_call。这里不执行它们，
    // 只转成统一 ToolCallRequest，并把并行调度、确认和错误处理交给 AgentLoop。
    const calls = response.output.filter(isFunctionCallItem);
    if (calls.length > 0) {
      return {
        type: "tool_calls",
        calls: calls.map((call) => {
          const parsed = parseOpenAIArguments(call.arguments, call.name);
          return {
            id: call.call_id,
            name: call.name,
            input: parsed.input,
            inputError: parsed.error,
          };
        }),
      };
    }

    if (response.status === "failed") {
      throw new Error(response.error?.message ?? "OpenAI response failed");
    }

    const refusal = extractOpenAIRefusal(response.output);
    if (refusal) {
      return { type: "final", text: refusal, stopReason: "refusal" };
    }

    const text = extractOpenAIText(response);
    if (response.status === "incomplete") {
      const reason = response.incomplete_details?.reason ?? "unknown";
      return {
        type: "final",
        text: `${text}\n\n[OpenAI 输出不完整：${reason}]`.trim(),
        stopReason: "incomplete",
      };
    }

    return { type: "final", text, stopReason: response.status ?? "completed" };
  }

  async addToolResults(results: ToolExecutionResult[]): Promise<void> {
    // Responses API 不使用 Anthropic 的 is_error 字段。
    // 失败结果包成 { error } JSON 文本，让模型可以稳定区分成功输出和错误。
    await this.addOpenAIItems(results.map((result): OpenAIFunctionCallOutput => ({
      type: "function_call_output",
      call_id: result.toolCallId,
      output: result.isError ? JSON.stringify({ error: result.output }) : result.output,
    })));
  }

  private async addOpenAIItem(item: OpenAIInputItem): Promise<void> {
    this.input.push(item);
    await this.onItem?.(item);
  }

  private async addOpenAIItems(items: OpenAIInputItem[]): Promise<void> {
    // 刻意逐条 await，而不是 Promise.all：JSONL 和内存 input 必须与 response.output 顺序一致。
    // reasoning 和 function_call 顺序错乱可能使后续 Responses API 拒绝回放。
    for (const item of items) {
      await this.addOpenAIItem(item);
    }
  }
}

// 使用 Node 22 内置 fetch 的低层 Responses API 客户端。
export class OpenAIHTTPClient implements OpenAIResponseClient {
  private readonly apiKey?: string;
  private readonly baseURL: string;
  private readonly organization?: string;
  private readonly project?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIClientOptions = {}) {
    // options 优先于环境变量，便于测试注入假 fetch 和自定义 base URL。
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    // 去掉末尾斜杠，后面统一拼接 /responses，避免代理地址出现 //responses。
    this.baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.organization = options.organization ?? process.env.OPENAI_ORG_ID;
    this.project = options.project ?? process.env.OPENAI_PROJECT_ID;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createResponse(params: OpenAIResponseCreateParams): Promise<OpenAIResponse> {
    // 即使 HTTP 状态是失败，也先尝试解析 body，这样 CLI 能展示 API 返回的具体错误信息。
    const response = await this.request(params, false);
    const payload = await parseOpenAIJsonResponse(response);
    if (!response.ok) {
      throwOpenAIResponseError(response.status, payload);
    }
    return parseOpenAIResponse(payload, response.status);
  }

  async streamResponse(
    params: OpenAIResponseCreateParams,
    onTextDelta: TextDeltaHandler,
  ): Promise<OpenAIResponse> {
    // 流式响应中，文本 delta 会立即通知 CLI，但方法仍要等到 completed 事件
    // 并返回完整 OpenAIResponse，否则 Provider 无法持久化 reasoning / function_call 等非文本 item。
    const response = await this.request(params, true);
    if (!response.ok) {
      const payload = await parseOpenAIJsonResponse(response);
      throwOpenAIResponseError(response.status, payload);
    }
    if (!response.body) {
      throw new OpenAIAPIError("OpenAI streaming response has no body", { status: response.status });
    }

    try {
      return await readOpenAIResponseStream(response.body, onTextDelta, response.status);
    } catch (error) {
      if (error instanceof OpenAIAPIError) throw error;
      throw new OpenAIConnectionError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  private async request(params: OpenAIResponseCreateParams, stream: boolean): Promise<Response> {
    // 在发起网络请求前失败，可以给出明确配置错误，而不是一个模糊的 401。
    if (!this.apiKey) {
      throw new OpenAIAuthenticationError("OPENAI_API_KEY is required when OPENCLAW_PROVIDER=openai");
    }

    // API Key 只进入 Authorization header，不记录到会话 JSONL 或错误文本中。
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (stream) headers.Accept = "text/event-stream";
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    if (this.project) headers["OpenAI-Project"] = this.project;

    let response: Response;
    try {
      // 只有流式模式才增加 stream: true；Provider 上层共用同一份请求参数类型。
      response = await this.fetchImpl(`${this.baseURL}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify(stream ? { ...params, stream: true } : params),
      });
    } catch (error) {
      throw new OpenAIConnectionError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    return response;
  }
}

export function getOpenAIModelId(): string {
  // 项目统一配置优先，其次是 OpenAI 专用配置，最后才使用默认模型。
  return process.env.OPENCLAW_MODEL || process.env.OPENAI_MODEL || "gpt-5.3-codex";
}

function parseOpenAIArguments(argumentsJson: string, toolName: string): { input: unknown; error?: string } {
  // 不在 Provider 层直接抛出 JSON 解析错误。把错误挂在 ToolCallRequest 上，
  // AgentLoop 会把它变成正常的错误工具结果回填，模型仍有机会修正参数。
  try {
    return { input: JSON.parse(argumentsJson) as unknown };
  } catch (error) {
    return {
      input: undefined,
      error: `Invalid JSON arguments for ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isFunctionCallItem(item: OpenAIResponseItem): item is FunctionCallItem {
  return item.type === "function_call"
    && typeof item.call_id === "string"
    && typeof item.name === "string"
    && typeof item.arguments === "string";
}

function isOpenAIUserTurnStart(item: OpenAIInputItem): boolean {
  // reasoning / function_call / function_call_output / assistant message 都不能作为切分点。
  // 排除带固定前缀的历史摘要，防止它消耗 keepRecentTurns 名额。
  return isRecord(item)
    && item.role === "user"
    && typeof item.content === "string"
    && !item.content.startsWith(CONTEXT_SUMMARY_PREFIX);
}

function extractOpenAIText(response: OpenAIResponse): string {
  // 优先从原生 message.content 提取所有 output_text，保留多段输出的顺序。
  // output_text 顶层字段仅作为某些兼容 API 只返回聚合文本时的 fallback。
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim() || response.output_text?.trim() || "";
}

function extractOpenAIRefusal(output: OpenAIResponseItem[]): string | undefined {
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "refusal" && typeof content.refusal === "string") {
        return content.refusal;
      }
    }
  }
  return undefined;
}

async function parseOpenAIJsonResponse(response: Response): Promise<unknown> {
  // 错误网关或代理可能返回纯文本/HTML；非 2xx 时仍把原文包成错误消息。
  // 2xx 却返回非 JSON 则是协议违约，必须显式报错，不能伪造空响应。
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) return { error: { message: text } };
    throw new OpenAIAPIError("OpenAI Responses API returned non-JSON content", { status: response.status });
  }
}

function parseOpenAIResponse(payload: unknown, status: number): OpenAIResponse {
  // 网络边界的 JSON 不能因为 TypeScript interface 就被信任；先校验 Agent 必需的最小形状。
  if (!isRecord(payload) || typeof payload.id !== "string" || !Array.isArray(payload.output)) {
    throw new OpenAIAPIError("OpenAI Responses API returned an invalid response shape", { status });
  }
  return payload as unknown as OpenAIResponse;
}

function throwOpenAIResponseError(status: number, payload: unknown): never {
  // 把状态码分成稳定的错误子类，CLI 不需解析英文 message 就能给出针对性建议。
  const apiError = extractOpenAIAPIError(payload);
  const options = { status, code: apiError.code };
  if (status === 401 || status === 403) {
    throw new OpenAIAuthenticationError(apiError.message, options);
  }
  if (status === 429) {
    throw new OpenAIRateLimitError(apiError.message, options);
  }
  throw new OpenAIAPIError(apiError.message, options);
}

async function readOpenAIResponseStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta: TextDeltaHandler,
  status: number,
): Promise<OpenAIResponse> {
  // fetch body 是任意字节分块，一个 JSON/SSE 事件可能被拆到多个 chunk 中。
  // TextDecoder 的 stream 模式会保留未完成的多字节 UTF-8 字符，buffer 则保留未完成的 SSE 事件。
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: OpenAIResponse | undefined;

  const consumeBlock = (block: string): void => {
    // SSE 事件以空行分隔，一个事件允许有多行 data:。
    // 先合并 data 行再 JSON.parse，避免把多行 payload 错认为多个事件。
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0 || data === "[DONE]") return;

    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch (error) {
      throw new OpenAIAPIError(`OpenAI stream returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { status });
    }
    if (!isRecord(event) || typeof event.type !== "string") return;

    if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta")
      && typeof event.delta === "string") {
      // 拒绝文本也是用户需要实时看到的模型输出，因此与普通文本共用 delta 通道。
      onTextDelta(event.delta);
      return;
    }
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : "OpenAI streaming response failed";
      const code = typeof event.code === "string" ? event.code : undefined;
      throw new OpenAIAPIError(message, { status, code });
    }
    if ((event.type === "response.completed" || event.type === "response.failed" || event.type === "response.incomplete")
      && "response" in event) {
      // 只信任终态事件中的完整 response。delta 只用于显示，不用于自行拼装持久化对象。
      finalResponse = parseOpenAIResponse(event.response, status);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    // done 时无参数 decode() 会 flush TextDecoder 内部缓冲；流未结束时则保留半个 UTF-8 字符。
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary) {
      consumeBlock(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(buffer);
    }

    if (done) break;
  }

  if (buffer.trim().length > 0) {
    // 兼容服务端在最后一个 SSE 事件后没有再发空行的情况。
    consumeBlock(buffer);
  }
  if (!finalResponse) {
    throw new OpenAIAPIError("OpenAI stream ended without a completed response", { status });
  }
  return finalResponse;
}

function extractOpenAIAPIError(payload: unknown): { message: string; code?: string } {
  if (isRecord(payload) && isRecord(payload.error)) {
    return {
      message: typeof payload.error.message === "string" ? payload.error.message : "OpenAI API request failed",
      code: typeof payload.error.code === "string" ? payload.error.code : undefined,
    };
  }
  return { message: "OpenAI API request failed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
