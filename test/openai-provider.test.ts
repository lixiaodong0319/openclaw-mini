import { OpenAIAuthenticationError, OpenAIHTTPClient } from "../src/provider.js";

describe("OpenAIProvider", () => {
  it("calls the Responses API with bearer authentication", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        id: "resp_1",
        status: "completed",
        output: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const provider = new OpenAIHTTPClient({
      apiKey: "test-key",
      baseURL: "https://example.test/v1/",
      fetch: fetchMock,
    });

    await provider.createResponse({ model: "gpt-5.3-codex", instructions: "test", input: [], tools: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://example.test/v1/responses");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("requires an API key", async () => {
    const provider = new OpenAIHTTPClient({
      apiKey: "",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(provider.createResponse({ model: "gpt-5.3-codex", instructions: "test", input: [], tools: [] }))
      .rejects.toBeInstanceOf(OpenAIAuthenticationError);
  });

  it("parses streamed text deltas and returns the completed response", async () => {
    const encoder = new TextEncoder();
    const completedResponse = {
      id: "resp_1",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello", annotations: [] }],
      }],
    };
    const sse = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hel" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "lo" })}\n\n`,
      `data: ${JSON.stringify({ type: "response.completed", response: completedResponse })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const requestBodies: unknown[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          // 刻意从 JSON 中间切块，验证 SSE parser 不依赖网络 chunk 边界。
          controller.enqueue(encoder.encode(sse.slice(0, 37)));
          controller.enqueue(encoder.encode(sse.slice(37)));
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    };
    const provider = new OpenAIHTTPClient({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: fetchMock,
    });
    const deltas: string[] = [];

    const response = await provider.streamResponse(
      { model: "gpt-5.3-codex", instructions: "test", input: [], tools: [] },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["hel", "lo"]);
    expect(response).toEqual(completedResponse);
    expect(requestBodies).toContainEqual(expect.objectContaining({ stream: true }));
  });
});
