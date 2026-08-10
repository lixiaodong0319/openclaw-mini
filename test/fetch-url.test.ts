import { fetchUrlText } from "../src/fetch-url.js";
import { requiresToolConfirmation } from "../src/tools.js";

describe("fetch_url", () => {
  it("returns a public text response", async () => {
    const resolveAddresses = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const request = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: Buffer.from("hello"),
      truncated: false,
    }));

    const output = JSON.parse(await fetchUrlText("https://example.com/docs", 1024, {
      resolveAddresses,
      request,
    }));

    expect(output).toEqual({
      url: "https://example.com/docs",
      status: 200,
      content_type: "text/plain; charset=utf-8",
      body: "hello",
      truncated: false,
      redirects: 0,
    });
    expect(resolveAddresses).toHaveBeenCalledWith("example.com");
    expect(request).toHaveBeenCalledWith(
      new URL("https://example.com/docs"),
      { address: "93.184.216.34", family: 4 },
      1024,
      expect.any(Number),
    );
  });

  it("revalidates every redirect target", async () => {
    const resolveAddresses = vi.fn(async (hostname: string) => hostname === "example.com"
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "1.1.1.1", family: 4 as const }]);
    const request = vi.fn(async (url: URL) => url.hostname === "example.com"
      ? {
          status: 302,
          headers: { location: "https://public.example/final" },
          body: Buffer.alloc(0),
          truncated: false,
        }
      : {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Buffer.from('{"ok":true}'),
          truncated: false,
        });

    const output = JSON.parse(await fetchUrlText("https://example.com/start", 1024, {
      resolveAddresses,
      request,
    }));

    expect(output.url).toBe("https://public.example/final");
    expect(output.redirects).toBe(1);
    expect(output.body).toBe('{"ok":true}');
    expect(resolveAddresses.mock.calls.map((call) => call[0])).toEqual(["example.com", "public.example"]);
  });

  it("blocks redirects that resolve to private addresses", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      headers: { location: "http://metadata.example/latest" },
      body: Buffer.alloc(0),
      truncated: false,
    }));
    const resolveAddresses = vi.fn(async (hostname: string) => hostname === "example.com"
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "169.254.169.254", family: 4 as const }]);

    await expect(fetchUrlText("https://example.com", 1024, { resolveAddresses, request }))
      .rejects.toThrow("non-public address");
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://[fc00::1]/",
  ])("blocks private literal address %s", async (url) => {
    await expect(fetchUrlText(url, 1024)).rejects.toThrow("non-public address");
  });

  it.each([
    ["file:///etc/passwd", "only supports http"],
    ["http://user:password@example.com/", "usernames or passwords"],
    ["http://localhost/", "local hostname"],
    ["http://service.internal/", "local hostname"],
  ])("rejects an unsafe URL before requesting it", async (url, message) => {
    await expect(fetchUrlText(url, 1024)).rejects.toThrow(message);
  });

  it("rejects binary and encoded responses", async () => {
    const resolveAddresses = async () => [{ address: "93.184.216.34", family: 4 as const }];

    await expect(fetchUrlText("https://example.com/image", 1024, {
      resolveAddresses,
      request: async () => ({
        status: 200,
        headers: { "content-type": "image/png" },
        body: Buffer.alloc(0),
        truncated: false,
      }),
    })).rejects.toThrow("not supported text content");
    await expect(fetchUrlText("https://example.com/gzip", 1024, {
      resolveAddresses,
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/plain", "content-encoding": "gzip" },
        body: Buffer.alloc(0),
        truncated: false,
      }),
    })).rejects.toThrow("does not accept encoded responses");
    await expect(fetchUrlText("https://example.com/latin1", 1024, {
      resolveAddresses,
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/plain; charset=iso-8859-1" },
        body: Buffer.alloc(0),
        truncated: false,
      }),
    })).rejects.toThrow("charset is not supported");
  });

  it("does not emit a replacement character for a truncated UTF-8 sequence", async () => {
    const encoded = Buffer.from("你好", "utf8");
    const output = JSON.parse(await fetchUrlText("https://example.com", 4, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      request: async () => ({
        status: 200,
        headers: { "content-type": "text/plain" },
        body: encoded.subarray(0, 4),
        truncated: true,
      }),
    }));

    expect(output.body).toBe("你");
    expect(output.body).not.toContain("�");
    expect(output.truncated).toBe(true);
  });

  it("requires confirmation because fetching has external effects", () => {
    expect(requiresToolConfirmation("fetch_url")).toBe(true);
  });
});
