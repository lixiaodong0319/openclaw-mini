import {
  OpenAIEmbeddingHTTPClient,
  resolveMemoryEmbeddingEnvironment,
} from "../src/embedding.js";

describe("OpenAI embedding client", () => {
  it("calls /embeddings with authentication and restores response index order", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const client = new OpenAIEmbeddingHTTPClient({
      apiKey: "test-key",
      baseURL: "https://example.test/v1/",
      model: "text-embedding-test",
      dimensions: 2,
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const vectors = await client.embed(["first", "second"]);

    expect(vectors).toEqual([[1, 0], [0, 1]]);
    expect(client.cacheKey).toBe("text-embedding-test:dimensions=2");
    expect(calls[0]?.input).toBe("https://example.test/v1/embeddings");
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "text-embedding-test",
      input: ["first", "second"],
      encoding_format: "float",
      dimensions: 2,
    });
  });

  it("batches more than 64 inputs without changing result order", async () => {
    const batchSizes: number[] = [];
    const client = new OpenAIEmbeddingHTTPClient({
      apiKey: "test-key",
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string[] };
        batchSizes.push(body.input.length);
        return new Response(JSON.stringify({
          data: body.input.map((text, index) => ({ index, embedding: [Number(text)] })),
        }), { status: 200 });
      },
    });
    const inputs = Array.from({ length: 65 }, (_, index) => String(index));

    const vectors = await client.embed(inputs);

    expect(batchSizes).toEqual([64, 1]);
    expect(vectors[64]).toEqual([64]);
  });

  it("does not expose API error bodies as successful vectors", async () => {
    const client = new OpenAIEmbeddingHTTPClient({
      apiKey: "test-key",
      fetch: async () => new Response(JSON.stringify({
        error: { message: "model is unavailable" },
      }), { status: 503 }),
    });

    await expect(client.embed(["hello"])).rejects.toThrow("503");
  });

  it("enables vectors only when a key is available and validates weight", () => {
    expect(resolveMemoryEmbeddingEnvironment({})).toEqual({
      vectorWeight: 0.5,
      client: undefined,
    });
    expect(resolveMemoryEmbeddingEnvironment({
      OPENAI_API_KEY: "test-key",
      OPENCLAW_MEMORY_EMBEDDINGS: "false",
    })).toEqual({ vectorWeight: 0.5, client: undefined });
    expect(resolveMemoryEmbeddingEnvironment({
      OPENAI_API_KEY: "test-key",
      OPENCLAW_MEMORY_VECTOR_WEIGHT: "0.7",
    }).client).toBeInstanceOf(OpenAIEmbeddingHTTPClient);
    expect(() => resolveMemoryEmbeddingEnvironment({
      OPENAI_API_KEY: "test-key",
      OPENCLAW_MEMORY_VECTOR_WEIGHT: "1.5",
    })).toThrow("between 0 and 1");
  });
});
