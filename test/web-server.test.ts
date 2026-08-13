import type { AddressInfo } from "node:net";
import type { AgentLoop, ToolConfirmationRequest } from "../src/agent-loop.js";
import type { RuntimeConfig } from "../src/runtime.js";
import { WEB_PAGE } from "../src/web-page.js";
import { createWebServer } from "../src/web-server.js";

const config: RuntimeConfig = {
  projectRoot: "/project",
  workspaceRoot: "/project/workspace",
  dataRoot: "/project/data",
  providerName: "openai",
  model: "test-model",
};

const emptyHistory = async (sessionId: string) => ({
  sessionId,
  entries: [],
  truncated: false,
});

type AgentRunner = Pick<AgentLoop, "runTurn">;

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("missing response body");
    this.reader = response.body.getReader();
  }

  async nextPayload(): Promise<Record<string, unknown> | undefined> {
    while (true) {
      const boundary = this.buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const data = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) return JSON.parse(data) as Record<string, unknown>;
        continue;
      }

      const result = await this.reader.read();
      this.buffer += this.decoder.decode(result.value, { stream: !result.done });
      if (result.done) return undefined;
    }
  }

  async allPayloads(): Promise<Array<Record<string, unknown>>> {
    const payloads: Array<Record<string, unknown>> = [];
    while (true) {
      const payload = await this.nextPayload();
      if (!payload) return payloads;
      payloads.push(payload);
    }
  }
}

function createRunner(runTurn: AgentLoop["runTurn"]): AgentRunner {
  return { runTurn };
}

function sessionManagementOptions() {
  return {
    createSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    releaseAgent: vi.fn(),
  };
}

async function listen(server: ReturnType<typeof createWebServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("Web server", () => {
  const servers: Array<ReturnType<typeof createWebServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })));
  });

  it("contains syntactically valid browser JavaScript", () => {
    const script = WEB_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
  });

  it("serves the page, runtime config, and session list", async () => {
    const server = createWebServer({
      config,
      ...sessionManagementOptions(),
      workspaceInstructions: {
        relativePath: "AGENTS.md",
        content: "Use TypeScript.",
        bytes: 15,
      },
      getAgent: async () => createRunner(async () => ({ text: "", stopReason: "done" })),
      listSessions: async () => ["default", "demo"],
      loadHistory: async (sessionId) => ({
        sessionId,
        entries: [{ type: "message", role: "user", text: "old question" }],
        truncated: false,
      }),
      page: "<h1>test page</h1>",
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const pageResponse = await fetch(baseUrl);
    expect(await pageResponse.text()).toBe("<h1>test page</h1>");
    await expect(fetch(`${baseUrl}/api/config`).then((response) => response.json())).resolves.toEqual({
      provider: "openai",
      model: "test-model",
      workspace: "/project/workspace",
      instructions: "AGENTS.md",
    });
    await expect(fetch(`${baseUrl}/api/sessions`).then((response) => response.json())).resolves.toEqual({
      sessions: ["default", "demo"],
    });
    await expect(fetch(`${baseUrl}/api/sessions/demo/history`).then((response) => response.json()))
      .resolves.toEqual({
        sessionId: "demo",
        entries: [{ type: "message", role: "user", text: "old question" }],
        truncated: false,
      });
  });

  it("creates, renames, and deletes sessions through the API", async () => {
    const management = sessionManagementOptions();
    const server = createWebServer({
      config,
      ...management,
      getAgent: async () => createRunner(async () => ({ text: "", stopReason: "done" })),
      listSessions: async () => [],
      loadHistory: emptyHistory,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const created = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "demo" }),
    });
    expect(created.status).toBe(201);
    expect(management.createSession).toHaveBeenCalledWith("demo");

    const renamed = await fetch(`${baseUrl}/api/sessions/demo`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newSessionId: "renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect(management.renameSession).toHaveBeenCalledWith("demo", "renamed");
    expect(management.releaseAgent).toHaveBeenCalledWith("demo");
    expect(management.releaseAgent).toHaveBeenCalledWith("renamed");

    const deleted = await fetch(`${baseUrl}/api/sessions/renamed`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect(management.deleteSession).toHaveBeenCalledWith("renamed");
    expect(management.releaseAgent).toHaveBeenCalledWith("renamed");
  });

  it("streams agent text and completion as SSE", async () => {
    const agent = createRunner(async (message, onEvent) => {
      expect(message).toBe("hello");
      onEvent?.({ type: "text_delta", text: "hel" });
      onEvent?.({ type: "text_delta", text: "lo" });
      return { text: "hello", stopReason: "end_turn" };
    });
    const server = createWebServer({
      config,
      ...sessionManagementOptions(),
      getAgent: async () => agent,
      listSessions: async () => [],
      loadHistory: emptyHistory,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "default", message: "hello" }),
    });
    const payloads = await new SseReader(response).allPayloads();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(payloads).toEqual([
      { type: "agent_event", event: { type: "text_delta", text: "hel" } },
      { type: "agent_event", event: { type: "text_delta", text: "lo" } },
      { type: "done", stopReason: "end_turn" },
    ]);
  });

  it("waits for a matching browser confirmation before continuing", async () => {
    let decision: boolean | undefined;
    const request: ToolConfirmationRequest = {
      toolCallId: "call-1",
      name: "write_text_file",
      input: { path: "note.txt", content: "hello" },
    };
    const agent = createRunner(async (_message, onEvent, confirmTool) => {
      onEvent?.({ type: "tool_pending", ...request });
      decision = await confirmTool?.(request);
      onEvent?.({
        type: decision ? "tool_approved" : "tool_denied",
        toolCallId: request.toolCallId,
        name: request.name,
      });
      return { text: "done", stopReason: "end_turn" };
    });
    const server = createWebServer({
      config,
      ...sessionManagementOptions(),
      getAgent: async () => agent,
      listSessions: async () => [],
      loadHistory: emptyHistory,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "demo", message: "save" }),
    });
    const reader = new SseReader(response);
    expect(await reader.nextPayload()).toEqual({ type: "agent_event", event: { type: "tool_pending", ...request } });
    const confirmation = await reader.nextPayload();
    expect(confirmation).toMatchObject({ type: "confirmation_required", request });

    const concurrentResponse = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "demo", message: "second turn" }),
    });
    expect(concurrentResponse.status).toBe(409);

    const confirmationResponse = await fetch(`${baseUrl}/api/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: confirmation?.requestId,
        sessionId: "demo",
        approved: true,
      }),
    });
    expect(confirmationResponse.status).toBe(204);
    expect(await reader.allPayloads()).toEqual([
      {
        type: "agent_event",
        event: { type: "tool_approved", toolCallId: "call-1", name: "write_text_file" },
      },
      { type: "done", stopReason: "end_turn" },
    ]);
    expect(decision).toBe(true);
  });

  it("rejects cross-origin-friendly content types and unsafe session ids", async () => {
    const server = createWebServer({
      config,
      ...sessionManagementOptions(),
      getAgent: async () => createRunner(async () => ({ text: "", stopReason: "done" })),
      listSessions: async () => [],
      loadHistory: emptyHistory,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const contentTypeResponse = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ sessionId: "default", message: "hello" }),
    });
    expect(contentTypeResponse.status).toBe(415);

    const sessionResponse = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "../outside", message: "hello" }),
    });
    expect(sessionResponse.status).toBe(400);
  });
});
