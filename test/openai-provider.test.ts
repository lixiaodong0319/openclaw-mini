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
});
