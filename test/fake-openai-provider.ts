import type {
  OpenAIResponse,
  OpenAIResponseClient,
  OpenAIResponseCreateParams,
} from "../src/provider.js";

export class FakeOpenAIProvider implements OpenAIResponseClient {
  readonly calls: OpenAIResponseCreateParams[] = [];
  private readonly responses: OpenAIResponse[];

  constructor(responses: OpenAIResponse[]) {
    this.responses = [...responses];
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
