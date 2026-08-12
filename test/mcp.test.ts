import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
      command: "node",
      args: ["server.js"],
      env: { DEMO_MODE: "test" },
    }), projectRoot);
    expect(manager.hasTool("mcp__demo__lookup")).toBe(true);
    expect(definitions.anthropic).toContainEqual(expect.objectContaining({
      name: "mcp__demo__lookup",
      input_schema: expect.objectContaining({ type: "object" }),
    }));
    expect(definitions.openai).toContainEqual(expect.objectContaining({
      type: "function",
      name: "mcp__demo__lookup",
      strict: false,
    }));
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
