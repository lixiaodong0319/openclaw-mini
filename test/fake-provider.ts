import Anthropic from "@anthropic-ai/sdk";
import type { TextDeltaHandler } from "../src/agent-loop.js";
import type { MessageProvider } from "../src/provider.js";

export class FakeProvider implements MessageProvider {
  readonly calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  private readonly responses: Anthropic.Message[];
  private readonly textChunks: string[][];

  constructor(responses: Anthropic.Message[], textChunks: string[][] = []) {
    this.responses = [...responses];
    this.textChunks = [...textChunks];
  }

  async createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(params);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("FakeProvider has no response queued");
    }
    return response;
  }

  async streamMessage(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onTextDelta: TextDeltaHandler,
  ): Promise<Anthropic.Message> {
    const response = await this.createMessage(params);
    const chunks = this.textChunks.shift() ?? response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text);
    for (const chunk of chunks) onTextDelta(chunk);
    return response;
  }
}

export function message(content: Anthropic.Message["content"], stopReason: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: "message",
    role: "assistant",
    content,
    model: "claude-opus-5",
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
    },
  } as Anthropic.Message;
}
