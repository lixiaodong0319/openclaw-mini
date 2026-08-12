import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { McpManager } from "../src/mcp.js";

describe("McpManager", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcp-"));
  });

  it("does nothing when mcp.json is absent", async () => {
    const connect = vi.fn();
    const manager = await McpManager.load(projectRoot, { connect });

    expect(manager.serverCount).toBe(0);
    expect(manager.toolCount).toBe(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it("loads stdio server tools and exposes provider definitions", async () => {
    await writeConfig(projectRoot, {
      mcpServers: {
        demo: {
          command: "node",
          args: ["server.js"],
          env: { DEMO_MODE: "test" },
        },
      },
    });
    const close = vi.fn(async () => undefined);
    const listTools = vi.fn(async () => ({
      tools: [{
        name: "lookup",
        description: "Look up a value",
        inputSchema: {
          type: "object" as const,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }));
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "found" }],
    }));
    const connect = vi.fn(async () => ({
      client: { listTools, callTool, close },
      close,
    }));

    const manager = await McpManager.load(projectRoot, { connect });
    const definitions = manager.getDefinitions();

    expect(connect).toHaveBeenCalledWith("demo", expect.objectContaining({
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { DEMO_MODE: "test" },
      timeoutMs: 30_000,
    }), projectRoot);
    expect(manager.hasTool("mcp__demo__lookup")).toBe(true);
    expect(manager.getStatus()).toEqual({
      serverCount: 1,
      toolCount: 1,
      servers: [{
        name: "demo",
        tools: [{
          name: "mcp__demo__lookup",
          description: "[MCP server: demo] Look up a value",
        }],
      }],
    });
    expect(definitions.anthropic).toContainEqual(expect.objectContaining({
      name: "mcp__demo__lookup",
      input_schema: expect.objectContaining({ type: "object" }),
    }));
    expect(definitions.openai).toContainEqual(expect.objectContaining({
      type: "function",
      name: "mcp__demo__lookup",
      strict: false,
    }));
    expect(listTools).toHaveBeenCalledWith(undefined, { timeout: 30_000 });
    await expect(manager.execute("mcp__demo__lookup", { query: "x" })).resolves.toBe("found");
    expect(callTool).toHaveBeenCalledWith(
      { name: "lookup", arguments: { query: "x" } },
      undefined,
      expect.objectContaining({ timeout: 30_000 }),
    );

    await manager.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("connects to a real stdio MCP server and calls its tool", async () => {
    const serverScript = path.resolve("test/fixtures/mcp-echo-server.mjs");
    await writeConfig(projectRoot, {
      mcpServers: {
        echo: {
          command: process.execPath,
          args: [serverScript],
        },
      },
    });

    const manager = await McpManager.load(projectRoot);
    try {
      expect(manager.serverCount).toBe(1);
      expect(manager.hasTool("mcp__echo__echo")).toBe(true);
      await expect(manager.execute("mcp__echo__echo", { text: "hello" }))
        .resolves.toBe("echo:hello");
    } finally {
      await manager.close();
    }
  });

  it("loads Streamable HTTP config and uses its timeout without exposing credentials", async () => {
    await writeConfig(projectRoot, {
      mcpServers: {
        remote: {
          url: "https://mcp.example.test/api",
          headers: { "X-Tenant-ID": "tenant-secret" },
          token: "token-secret",
          timeoutMs: 12_345,
        },
      },
    });
    const listTools = vi.fn(async () => ({
      tools: [{ name: "search", description: "Remote search", inputSchema: { type: "object" } }],
    }));
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        content: [{
          type: "text",
          text: "remote result token-secret tenant-secret https://mcp.example.test/api",
        }],
      })
      .mockRejectedValueOnce(new Error("request failed with token-secret and tenant-secret"));
    const connect = vi.fn(async () => ({
      client: { listTools, callTool, close: async () => undefined },
      close: async () => undefined,
    }));

    const manager = await McpManager.load(projectRoot, { connect });
    expect(connect).toHaveBeenCalledWith("remote", {
      transport: "streamable-http",
      url: "https://mcp.example.test/api",
      headers: { "X-Tenant-ID": "tenant-secret" },
      token: "token-secret",
      timeoutMs: 12_345,
      enabled: true,
    }, projectRoot);
    expect(listTools).toHaveBeenCalledWith(undefined, { timeout: 12_345 });
    await expect(manager.execute("mcp__remote__search", {}))
      .resolves.toBe("remote result [redacted] [redacted] [redacted]");
    const rejected = await manager.execute("mcp__remote__search", {})
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).not.toMatch(/token-secret|tenant-secret/);
    expect(callTool).toHaveBeenCalledWith(
      { name: "search", arguments: {} },
      undefined,
      { timeout: 12_345 },
    );
    expect(JSON.stringify(manager.getStatus())).not.toMatch(/mcp\.example|tenant-secret|token-secret/i);
    expect(JSON.stringify(manager.getDefinitions())).not.toMatch(/mcp\.example|tenant-secret|token-secret/i);
    await manager.close();
  });

  it("connects to a real Streamable HTTP server with token and custom headers", async () => {
    const receivedHeaders: Array<{ authorization?: string; tenant?: string }> = [];
    const mcpServer = new Server(
      { name: "openclaw-test-http", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: "echo",
        description: "Echo over HTTP",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      }],
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [{ type: "text", text: `http:${request.params.arguments?.text ?? ""}` }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await mcpServer.connect(transport);
    const app = createMcpExpressApp();
    app.all("/mcp", async (
      request: IncomingMessage & { body?: unknown },
      response: ServerResponse,
    ) => {
      receivedHeaders.push({
        authorization: request.headers.authorization,
        tenant: headerValue(request.headers["x-tenant-id"]),
      });
      await transport.handleRequest(request, response, request.body);
    });
    const httpServer = createServer(app);

    const url = await listenOnLocalhost(httpServer);
    await writeConfig(projectRoot, {
      mcpServers: {
        remote: {
          transport: "streamable-http",
          url: `${url}/mcp`,
          headers: { "X-Tenant-ID": "demo-tenant" },
          token: "demo-token",
          timeoutMs: 5_000,
        },
      },
    });

    let manager: McpManager | undefined;
    try {
      manager = await McpManager.load(projectRoot);
      expect(manager.hasTool("mcp__remote__echo")).toBe(true);
      await expect(manager.execute("mcp__remote__echo", { text: "hello" }))
        .resolves.toBe("http:hello");
      expect(receivedHeaders.length).toBeGreaterThanOrEqual(3);
      expect(receivedHeaders.every((headers) => headers.authorization === "Bearer demo-token"))
        .toBe(true);
      expect(receivedHeaders.every((headers) => headers.tenant === "demo-tenant"))
        .toBe(true);
    } finally {
      await manager?.close();
      await mcpServer.close();
      await closeHttpServer(httpServer);
    }
  });

  it.each([
    [{ transport: "streamable-http", url: "file:///tmp/mcp" }, "absolute HTTP(S) URL"],
    [{ transport: "streamable-http", url: "https://user:pass@example.test/mcp" }, "embedded credentials"],
    [{ transport: "streamable-http", url: "https://example.test", headers: [] }, "headers"],
    [{ transport: "streamable-http", url: "https://example.test", headers: { "Bad Header": "value" } }, "invalid name or value"],
    [{ transport: "streamable-http", url: "https://example.test", headers: { Host: "evil" } }, "reserved header"],
    [{ transport: "streamable-http", url: "https://example.test", token: "token", headers: { Authorization: "Basic abc" } }, "both token"],
    [{ transport: "streamable-http", url: "https://example.test", timeoutMs: 0 }, "timeoutMs"],
    [{ transport: "stdio", url: "https://example.test" }, "stdio transport"],
    [{ transport: "stdio", command: "server", headers: { "X-Test": "value" } }, "HTTP fields"],
    [{ transport: "streamable-http", command: "server" }, "streamable-http transport"],
    [{ transport: "streamable-http", url: "https://example.test", args: [] }, "stdio fields"],
    [{ command: "server", url: "https://example.test" }, "both command and url"],
  ])("rejects invalid MCP transport config %#", async (serverConfig, message) => {
    await writeConfig(projectRoot, { mcpServers: { demo: serverConfig } });
    await expect(McpManager.load(projectRoot)).rejects.toThrow(message);
  });

  it("surfaces MCP tool errors and omits binary content", async () => {
    await writeConfig(projectRoot, {
      mcpServers: { demo: { command: "server" } },
    });
    const results = [
      { content: [{ type: "text", text: "remote failure" }], isError: true },
      { content: [{ type: "image", mimeType: "image/png", data: "large-base64" }] },
    ];
    const manager = await McpManager.load(projectRoot, {
      connect: async () => ({
        client: {
          listTools: async () => ({
            tools: [{ name: "binary", inputSchema: { type: "object" } }],
          }),
          callTool: async () => results.shift(),
          close: async () => undefined,
        },
        close: async () => undefined,
      }),
    });

    await expect(manager.execute("mcp__demo__binary", {})).rejects.toThrow("remote failure");
    await expect(manager.execute("mcp__demo__binary", {})).resolves.toContain('"omitted": true');
  });

  it("normalizes long tool names and truncates oversized output", async () => {
    await writeConfig(projectRoot, {
      mcpServers: { demo: { command: "server" } },
    });
    const remoteName = `tools.lookup.${"x".repeat(80)}`;
    const manager = await McpManager.load(projectRoot, {
      connect: async () => ({
        client: {
          listTools: async () => ({
            tools: [{ name: remoteName, inputSchema: { type: "object" } }],
          }),
          callTool: async () => ({ content: [{ type: "text", text: "你".repeat(100_000) }] }),
          close: async () => undefined,
        },
        close: async () => undefined,
      }),
    });
    const exposedName = manager.getDefinitions().openai[0]?.name ?? "";

    expect(exposedName).toMatch(/^mcp__demo__[A-Za-z0-9_-]+$/);
    expect(exposedName.length).toBeLessThanOrEqual(64);
    const output = await manager.execute(exposedName, {});
    expect(output).toContain("[MCP result truncated at 262144 bytes]");
    expect(output).not.toContain("�");
  });

  it("rejects malformed config and invalid tool schemas", async () => {
    await fs.writeFile(path.join(projectRoot, "mcp.json"), "{", "utf8");
    await expect(McpManager.load(projectRoot)).rejects.toThrow("invalid JSON");

    await writeConfig(projectRoot, {
      mcpServers: { demo: { command: "server" } },
    });
    await expect(McpManager.load(projectRoot, {
      connect: async () => ({
        client: {
          listTools: async () => ({ tools: [{ name: "bad", inputSchema: { type: "string" } }] }),
          callTool: async () => ({ content: [] }),
          close: async () => undefined,
        },
        close: async () => undefined,
      }),
    })).rejects.toThrow("must use an object input schema");
  });
});

async function writeConfig(projectRoot: string, config: unknown): Promise<void> {
  await fs.writeFile(path.join(projectRoot, "mcp.json"), JSON.stringify(config), "utf8");
}

async function listenOnLocalhost(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}
