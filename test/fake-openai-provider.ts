import type {
  OpenAIResponseItem,
  OpenAIResponse,
  OpenAIResponseClient,
  OpenAIResponseCreateParams,
} from "../src/provider.js";
import type { TextDeltaHandler } from "../src/agent-loop.js";

export class FakeOpenAIProvider implements OpenAIResponseClient {
  readonly calls: OpenAIResponseCreateParams[] = [];
  private readonly responses: OpenAIResponse[];
  private readonly textChunks: string[][];

  constructor(responses: OpenAIResponse[], textChunks: string[][] = []) {
    this.responses = [...responses];
    this.textChunks = [...textChunks];
  }

  async createResponse(params: OpenAIResponseCreateParams): Promise<OpenAIResponse> {
    // AgentLoop 复用同一个 input 数组；测试需要保留每次调用当时的快照。
    this.calls.push({ ...params, input: structuredClone(params.input) });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("FakeOpenAIProvider has no response queued");
    }
    return response;
  }

  async streamResponse(
    params: OpenAIResponseCreateParams,
    onTextDelta: TextDeltaHandler,
  ): Promise<OpenAIResponse> {
    const response = await this.createResponse(params);
    const chunks = this.textChunks.shift() ?? extractOutputText(response.output);
    for (const chunk of chunks) onTextDelta(chunk);
    return response;
  }
}

function extractOutputText(output: OpenAIResponseItem[]): string[] {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (typeof content === "object" && content !== null && "type" in content
        && content.type === "output_text" && "text" in content && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks;
}

export function openAIResponse(
  output: OpenAIResponse["output"],
  status = "completed",
): OpenAIResponse {
  return {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    status,
    output,
  };
}
