import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentEvent, type ToolExecutor } from "../src/agent-loop.js";
import type { ContextCompactionOptions } from "../src/context-compaction.js";
import type { MemoryFlushHandler } from "../src/memory-flush.js";
import { WorkspaceMemoryConsolidator } from "../src/memory-consolidation.js";
import type { TaskPlan, TaskPlanToolService } from "../src/task-plan.js";
import { AnthropicProvider, type MessageProvider } from "../src/provider.js";
import { FakeProvider, message } from "./fake-provider.js";
import type { UserAttachment } from "../src/attachments.js";

function textBlock(text: string): Anthropic.TextBlock {
  return { type: "text", text, citations: [] } as Anthropic.TextBlock;
}

function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: "tool_use", id, name, input } as Anthropic.ToolUseBlock;
}

function createLoop(
  client: MessageProvider,
  messages: Anthropic.MessageParam[],
  workspaceRoot: string,
  options: {
    onMessage?: (message: Anthropic.MessageParam) => Promise<void>;
    maxIterations?: number;
    toolExecutor?: ToolExecutor;
    systemPrompt?: string | (() => string | Promise<string>);
    compaction?: Partial<ContextCompactionOptions>;
    onHistoryReplace?: (messages: Anthropic.MessageParam[]) => Promise<void>;
    memoryFlush?: MemoryFlushHandler;
    memoryConsolidator?: WorkspaceMemoryConsolidator;
    additionalTools?: Anthropic.Tool[];
    taskPlan?: TaskPlanToolService;
  } = {},
): AgentLoop {
  return new AgentLoop({
    provider: new AnthropicProvider({
      client,
      model: "claude-opus-5",
      messages,
      onMessage: options.onMessage,
      onHistoryReplace: options.onHistoryReplace,
      compaction: options.compaction,
      additionalTools: options.additionalTools,
    }),
    toolContext: { workspaceRoot, taskPlan: options.taskPlan },
    maxIterations: options.maxIterations,
    toolExecutor: options.toolExecutor,
    systemPrompt: options.systemPrompt,
    memoryFlush: options.memoryFlush,
    memoryConsolidator: options.memoryConsolidator,
  });
}

describe("AgentLoop", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-loop-"));
  });

  it("returns final text without tool calls", async () => {
    const provider = new FakeProvider([message([textBlock("hello")], "end_turn")]);
    const persisted: Anthropic.MessageParam[] = [];
    const loop = createLoop(provider, [], workspaceRoot, {
      onMessage: async (m) => {
        persisted.push(m);
      },
    });

    await expect(loop.runTurn("hi")).resolves.toEqual({ text: "hello", stopReason: "end_turn" });
    expect(persisted).toHaveLength(2);
  });

  it("sends text and image attachments as one Anthropic user message", async () => {
    const provider = new FakeProvider([message([textBlock("analyzed")], "end_turn")]);
    const loop = createLoop(provider, [], workspaceRoot);
    const attachments: UserAttachment[] = [{
      kind: "text",
      relativePath: "document.txt",
      mediaType: "text/plain",
      bytes: 5,
      text: "hello",
    }, {
      kind: "image",
      relativePath: "screenshot.png",
      mediaType: "image/png",
      bytes: 8,
      data: "iVBORw0KGgo=",
    }];

    await loop.runTurn("分析附件", undefined, undefined, attachments);

    expect(provider.calls[0]?.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "分析附件" },
        {
          type: "text",
          text: "[Attached text file: \"document.txt\"]\n<attachment>\nhello\n</attachment>",
        },
        { type: "text", text: "[Attached image: \"screenshot.png\"]" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
        },
      ],
    });
  });

  it("adds dynamically discovered MCP tools and requires confirmation", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_mcp", "mcp__demo__lookup", { query: "x" })], "tool_use"),
      message([textBlock("done")], "end_turn"),
    ]);
    const toolExecutor = vi.fn<ToolExecutor>(async () => "found");
    const loop = createLoop(provider, [], workspaceRoot, {
      toolExecutor,
      additionalTools: [{
        name: "mcp__demo__lookup",
        description: "MCP lookup",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    });
    const confirm = vi.fn(async () => true);

    await loop.runTurn("use MCP", undefined, confirm);

    expect(provider.calls[0]?.tools).toContainEqual(expect.objectContaining({
      name: "mcp__demo__lookup",
    }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp__demo__lookup" }));
    expect(toolExecutor).toHaveBeenCalledWith(
      "mcp__demo__lookup",
      { query: "x" },
      expect.objectContaining({ workspaceRoot }),
    );
  });

  it("forwards streamed text deltas", async () => {
    const provider = new FakeProvider(
      [message([textBlock("hello")], "end_turn")],
      [["hel", "lo"]],
    );
    const loop = createLoop(provider, [], workspaceRoot);
    const events: AgentEvent[] = [];

    await loop.runTurn("hi", (event) => events.push(event));

    expect(events).toEqual([
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ]);
  });

  it("resolves a dynamic system prompt before every model call", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_write", "write_text_file", { path: "MEMORY.md", content: "new" })], "tool_use"),
      message([textBlock("remembered")], "end_turn"),
    ]);
    let version = 0;
    const loop = createLoop(provider, [], workspaceRoot, {
      systemPrompt: async () => `memory version ${++version}`,
      toolExecutor: async () => "written",
    });

    await loop.runTurn("remember this", undefined, async () => true);

    expect(provider.calls.map((call) => call.system)).toEqual([
      [{ type: "text", text: "memory version 1" }],
      [{ type: "text", text: "memory version 2" }],
    ]);
  });

  it("compacts old Anthropic history while preserving a recent tool chain", async () => {
    const recentToolUse = toolUseBlock("toolu_recent", "calculator", { operation: "add", a: 1, b: 2 });
    const recentToolResult: Anthropic.MessageParam = {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_recent",
        content: [{ type: "text", text: "3" }],
      }],
    };
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "old detail ".repeat(500) }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "recent question" }] },
      { role: "assistant", content: [recentToolUse] },
      recentToolResult,
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    const client = new FakeProvider([
      message([textBlock("compressed old facts")], "end_turn"),
      message([textBlock("new answer")], "end_turn"),
    ]);
    const replacements: Anthropic.MessageParam[][] = [];
    const loop = createLoop(client, messages, workspaceRoot, {
      compaction: { tokenThreshold: 10, keepRecentTurns: 1, summaryMaxTokens: 100 },
      onHistoryReplace: async (replacement) => {
        replacements.push(structuredClone(replacement));
      },
    });
    const events: AgentEvent[] = [];

    await loop.runTurn("new question", (event) => events.push(event));

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.tools).toBeUndefined();
    expect(client.calls[0]?.max_tokens).toBe(100);
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[压缩的早期会话摘要]\ncompressed old facts" }],
    });
    const requestHistory = client.calls[1]?.messages ?? [];
    expect(requestHistory).toContainEqual({ role: "assistant", content: [recentToolUse] });
    expect(requestHistory).toContainEqual(recentToolResult);
    expect(requestHistory.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "new question" }],
    });
    expect(events[0]).toMatchObject({ type: "context_compaction_start" });
    expect(events[1]).toMatchObject({ type: "context_compaction_end" });
    if (events[0]?.type === "context_compaction_start" && events[1]?.type === "context_compaction_end") {
      expect(events[1].beforeTokens).toBe(events[0].estimatedTokens);
      expect(events[1].afterTokens).toBeLessThan(events[1].beforeTokens);
    }
  });

  it("manually compacts below the automatic threshold and can clear history", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: "old question" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "recent question" }] },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    const client = new FakeProvider([
      message([textBlock("manual summary")], "end_turn"),
    ]);
    const replacements: Anthropic.MessageParam[][] = [];
    const loop = createLoop(client, messages, workspaceRoot, {
      compaction: { tokenThreshold: 999_999, keepRecentTurns: 1 },
      onHistoryReplace: async (replacement) => {
        replacements.push(structuredClone(replacement));
      },
    });
    const events: AgentEvent[] = [];

    const result = await loop.compactContext((event) => events.push(event));

    expect(result).toBeDefined();
    expect(client.calls).toHaveLength(1);
    expect(replacements).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "context_compaction_start",
      "context_compaction_end",
    ]);

    await loop.clearHistory();

    expect(replacements.at(-1)).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("flushes the generated summary before replacing Anthropic history", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ];
    const client = new FakeProvider([
      message([textBlock("durable old facts")], "end_turn"),
    ]);
    const memoryFlush = vi.fn<MemoryFlushHandler>(async () => ({
      path: "memory/2026-08-17.md",
      written: true,
      bytesWritten: 42,
    }));
    const loop = createLoop(client, messages, workspaceRoot, {
      compaction: { tokenThreshold: 999_999, keepRecentTurns: 1 },
      memoryFlush,
    });
    const events: AgentEvent[] = [];

    await expect(loop.compactContext((event) => events.push(event))).resolves.toBeDefined();

    expect(memoryFlush).toHaveBeenCalledWith("durable old facts");
    expect(events.map((event) => event.type)).toEqual([
      "context_compaction_start",
      "memory_flush_start",
      "memory_flush_end",
      "context_compaction_end",
    ]);
  });

  it("continues compaction when memory flush fails", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer" },
    ];
    const client = new FakeProvider([
      message([textBlock("summary still used")], "end_turn"),
    ]);
    const loop = createLoop(client, messages, workspaceRoot, {
      compaction: { tokenThreshold: 999_999, keepRecentTurns: 1 },
      memoryFlush: async () => {
        throw new Error("daily memory is read-only");
      },
    });
    const events: AgentEvent[] = [];

    await expect(loop.compactContext((event) => events.push(event))).resolves.toBeDefined();

    expect(events).toContainEqual({
      type: "memory_flush_error",
      message: "daily memory is read-only",
    });
    expect(messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "[压缩的早期会话摘要]\nsummary still used" }],
    });
  });

  it("generates an Anthropic memory consolidation proposal without changing session history", async () => {
    await fs.mkdir(path.join(workspaceRoot, "memory"));
    await fs.writeFile(path.join(workspaceRoot, "memory", "2026-08-17.md"), "durable fact", "utf8");
    const messages: Anthropic.MessageParam[] = [];
    const client = new FakeProvider([
      message([textBlock("# 长期记忆\n\n- durable fact")], "end_turn"),
    ]);
    const loop = createLoop(client, messages, workspaceRoot, {
      memoryConsolidator: new WorkspaceMemoryConsolidator(workspaceRoot),
    });

    const plan = await loop.prepareMemoryConsolidation();

    expect(plan?.proposedContent).toContain("durable fact");
    expect(client.calls[0]?.tools).toBeUndefined();
    expect(client.calls[0]?.system).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("NO_CHANGES") }),
    ]);
    expect(messages).toEqual([]);
  });

  it("keeps Anthropic memory when clearing persisted history fails", async () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: "keep me" },
    ];
    const loop = createLoop(new FakeProvider([]), messages, workspaceRoot, {
      onHistoryReplace: async () => {
        throw new Error("disk failed");
      },
    });

    await expect(loop.clearHistory()).rejects.toThrow("disk failed");
    expect(messages).toEqual([{ role: "user", content: "keep me" }]);
  });

  it("emits tool start and completion events", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "calculator", { operation: "add", a: 1, b: 2 })], "tool_use"),
      message([textBlock("3")], "end_turn"),
    ]);
    const loop = createLoop(provider, [], workspaceRoot);
    const events: AgentEvent[] = [];

    await loop.runTurn("1+2", (event) => events.push(event));

    expect(events).toContainEqual({ type: "tool_start", toolCallId: "toolu_1", name: "calculator" });
    expect(events).toContainEqual({
      type: "tool_end",
      toolCallId: "toolu_1",
      name: "calculator",
      isError: false,
    });
  });

  it("updates a Session plan without confirmation and emits the final plan", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_plan", "update_plan", {
        steps: [
          { content: "分析代码", status: "completed" },
          { content: "实现功能", status: "in_progress" },
        ],
      })], "tool_use"),
      message([textBlock("继续实现")], "end_turn"),
    ]);
    let currentPlan: TaskPlan | undefined;
    const taskPlan: TaskPlanToolService = {
      updatePlan: vi.fn(async (steps) => {
        currentPlan = {
          version: 1,
          updatedAt: "2026-08-17T00:00:00.000Z",
          steps: [...steps],
        };
        return currentPlan;
      }),
      loadPlan: vi.fn(async () => currentPlan),
    };
    const loop = createLoop(provider, [], workspaceRoot, { taskPlan });
    const events: AgentEvent[] = [];
    const confirm = vi.fn(async () => false);

    await loop.runTurn("实现复杂功能", (event) => events.push(event), confirm);

    expect(confirm).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "plan_updated", plan: currentPlan });
    expect(events).toContainEqual({
      type: "tool_end",
      toolCallId: "toolu_plan",
      name: "update_plan",
      isError: false,
    });
  });

  it("executes a tool and returns the follow-up text", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "calculator", { operation: "multiply", a: 6, b: 7 })], "tool_use"),
      message([textBlock("42")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const loop = createLoop(provider, messages, workspaceRoot);

    const result = await loop.runTurn("6*7?");

    expect(result.text).toBe("42");
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "42" }] }],
    });
  });

  it("returns all parallel tool results in a single user message", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "note", "utf8");
    const provider = new FakeProvider([
      message([
        toolUseBlock("toolu_1", "calculator", { operation: "add", a: 1, b: 2 }),
        toolUseBlock("toolu_2", "read_text_file", { path: "note.txt" }),
      ], "tool_use"),
      message([textBlock("done")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const loop = createLoop(provider, messages, workspaceRoot);

    await loop.runTurn("use tools");

    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "3" }] },
        { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "note" }] },
      ],
    });
  });

  it("converts tool errors to error tool results", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "calculator", { operation: "divide", a: 1, b: 0 })], "tool_use"),
      message([textBlock("handled")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const loop = createLoop(provider, messages, workspaceRoot);
    const events: AgentEvent[] = [];

    await loop.runTurn("divide", (event) => events.push(event));

    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "division by zero is not allowed" }],
        is_error: true,
      }],
    });
    expect(events).toContainEqual({
      type: "tool_end",
      toolCallId: "toolu_1",
      name: "calculator",
      isError: true,
    });
  });

  it("executes safe tools without asking for confirmation", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "calculator", { operation: "add", a: 1, b: 2 })], "tool_use"),
      message([textBlock("3")], "end_turn"),
    ]);
    const loop = createLoop(provider, [], workspaceRoot);
    const confirmTool = vi.fn(async () => false);

    await loop.runTurn("1+2", undefined, confirmTool);

    expect(confirmTool).not.toHaveBeenCalled();
  });

  it("executes a protected tool after the user approves it", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "write_text_file", { path: "note.txt", content: "hello" })], "tool_use"),
      message([textBlock("saved")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const loop = createLoop(provider, messages, workspaceRoot);
    const events: AgentEvent[] = [];

    await loop.runTurn("save it", (event) => events.push(event), async () => true);

    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("hello");
    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{
          type: "text",
          text: JSON.stringify({ path: "note.txt", bytes: 5, created: true }, null, 2),
        }],
      }],
    });
    expect(events).toEqual(expect.arrayContaining([
      {
        type: "tool_pending",
        toolCallId: "toolu_1",
        name: "write_text_file",
        input: { path: "note.txt", content: "hello" },
      },
      { type: "tool_approved", toolCallId: "toolu_1", name: "write_text_file" },
      { type: "tool_start", toolCallId: "toolu_1", name: "write_text_file" },
      { type: "tool_end", toolCallId: "toolu_1", name: "write_text_file", isError: false },
    ]));
  });

  it("does not execute a protected tool after the user denies it", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "write_text_file", { path: "note.txt", content: "hello" })], "tool_use"),
      message([textBlock("cancelled")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const toolExecutor = vi.fn<ToolExecutor>(async () => "written");
    const loop = createLoop(provider, messages, workspaceRoot, { toolExecutor });
    const events: AgentEvent[] = [];

    await loop.runTurn("save it", (event) => events.push(event), async () => false);

    expect(toolExecutor).not.toHaveBeenCalled();
    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "Tool execution denied by user: write_text_file" }],
        is_error: true,
      }],
    });
    expect(events).toEqual([
      {
        type: "tool_pending",
        toolCallId: "toolu_1",
        name: "write_text_file",
        input: { path: "note.txt", content: "hello" },
      },
      { type: "tool_denied", toolCallId: "toolu_1", name: "write_text_file" },
      { type: "text_delta", text: "cancelled" },
    ]);
  });

  it("denies protected tools when no confirmation handler is available", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "write_text_file", { path: "note.txt", content: "hello" })], "tool_use"),
      message([textBlock("cancelled")], "end_turn"),
    ]);
    const messages: Anthropic.MessageParam[] = [];
    const toolExecutor = vi.fn<ToolExecutor>(async () => "written");
    const loop = createLoop(provider, messages, workspaceRoot, { toolExecutor });

    await loop.runTurn("save it");

    expect(toolExecutor).not.toHaveBeenCalled();
    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "Tool execution denied by user: write_text_file" }],
        is_error: true,
      }],
    });
  });

  it("denies protected tools when the confirmation handler fails", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "write_text_file", { path: "note.txt", content: "hello" })], "tool_use"),
      message([textBlock("cancelled")], "end_turn"),
    ]);
    const toolExecutor = vi.fn<ToolExecutor>(async () => "written");
    const loop = createLoop(provider, [], workspaceRoot, { toolExecutor });
    const events: AgentEvent[] = [];

    await loop.runTurn("save it", (event) => events.push(event), async () => {
      throw new Error("confirmation unavailable");
    });

    expect(toolExecutor).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "tool_denied",
      toolCallId: "toolu_1",
      name: "write_text_file",
    });
  });

  it("handles refusals", async () => {
    const provider = new FakeProvider([message([], "refusal")]);
    const loop = createLoop(provider, [], workspaceRoot);

    await expect(loop.runTurn("nope")).resolves.toEqual({ text: "模型拒绝了本次请求。", stopReason: "refusal" });
  });

  it("stops at the iteration limit", async () => {
    const provider = new FakeProvider([
      message([toolUseBlock("toolu_1", "calculator", { operation: "add", a: 1, b: 1 })], "tool_use"),
    ]);
    const loop = createLoop(provider, [], workspaceRoot, { maxIterations: 1 });

    await expect(loop.runTurn("loop")).resolves.toEqual({ text: "Agent Loop 达到最大工具迭代次数。", stopReason: "iteration_limit" });
  });
});
