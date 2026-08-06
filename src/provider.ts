import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentProvider,
  ProviderTurn,
  TextDeltaHandler,
  ToolExecutionResult,
} from "./agent-loop.js";
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
  onMessage?: (message: Anthropic.MessageParam) => Promise<void>;
}

// Anthropic Messages API 适配器。
// 它把原生 content blocks 转换成统一 ProviderTurn，同时保留 thinking/tool_use 原始历史。
export class AnthropicProvider implements AgentProvider, MessageProvider {
  private readonly client: MessageProvider;
  private readonly model: string;
  private readonly messages: Anthropic.MessageParam[];
  private readonly onMessage?: (message: Anthropic.MessageParam) => Promise<void>;

  constructor(options?: AnthropicProviderOptions) {
    if (options) {
      this.client = options.client ?? new AnthropicSDKClient();
      this.model = options.model;
      this.messages = options.messages;
      this.onMessage = options.onMessage;
      return;
    }

    // 保留旧的低层 MessageProvider 构造方式，便于独立转发 SDK 请求。
    this.client = new AnthropicSDKClient();
    this.model = getModelId();
    this.messages = [];
  }

  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    return this.client.createMessage(params);
  }

  async addUserText(text: string): Promise<void> {
    await this.addMessage({ role: "user", content: [{ type: "text", text }] });
  }

  async generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn> {
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
    const content: Anthropic.ToolResultBlockParam[] = results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.toolCallId,
      content: [{ type: "text", text: result.output }],
      ...(result.isError ? { is_error: true } : {}),
    }));
    await this.addMessage({ role: "user", content });
  }

  private async addMessage(message: Anthropic.MessageParam): Promise<void> {
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
  return messages.map((message) => {
    if (typeof message.content !== "string") {
      return message;
    }
    return { ...message, content: [{ type: "text", text: message.content }] };
  });
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
  onItem?: (item: OpenAIInputItem) => Promise<void>;
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

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client ?? new OpenAIHTTPClient();
    this.model = options.model;
    this.input = options.input;
    this.onItem = options.onItem;
  }

  async addUserText(text: string): Promise<void> {
    await this.addOpenAIItem({ role: "user", content: text });
  }

  async generateTurn(instructions: string, onTextDelta?: TextDeltaHandler): Promise<ProviderTurn> {
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
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.organization = options.organization ?? process.env.OPENAI_ORG_ID;
    this.project = options.project ?? process.env.OPENAI_PROJECT_ID;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createResponse(params: OpenAIResponseCreateParams): Promise<OpenAIResponse> {
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
    if (!this.apiKey) {
      throw new OpenAIAuthenticationError("OPENAI_API_KEY is required when OPENCLAW_PROVIDER=openai");
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (stream) headers.Accept = "text/event-stream";
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    if (this.project) headers["OpenAI-Project"] = this.project;

    let response: Response;
    try {
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
  return process.env.OPENCLAW_MODEL || process.env.OPENAI_MODEL || "gpt-5.3-codex";
}

function parseOpenAIArguments(argumentsJson: string, toolName: string): { input: unknown; error?: string } {
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

function extractOpenAIText(response: OpenAIResponse): string {
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
  if (!isRecord(payload) || typeof payload.id !== "string" || !Array.isArray(payload.output)) {
    throw new OpenAIAPIError("OpenAI Responses API returned an invalid response shape", { status });
  }
  return payload as unknown as OpenAIResponse;
}

function throwOpenAIResponseError(status: number, payload: unknown): never {
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
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: OpenAIResponse | undefined;

  const consumeBlock = (block: string): void => {
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
      finalResponse = parseOpenAIResponse(event.response, status);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
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
