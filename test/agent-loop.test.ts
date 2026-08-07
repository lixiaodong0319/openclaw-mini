import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentEvent, type ToolExecutor } from "../src/agent-loop.js";
import type { ContextCompactionOptions } from "../src/context-compaction.js";
import { AnthropicProvider, type MessageProvider } from "../src/provider.js";
import { FakeProvider, message } from "./fake-provider.js";

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
    compaction?: Partial<ContextCompactionOptions>;
    onHistoryReplace?: (messages: Anthropic.MessageParam[]) => Promise<void>;
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
    }),
    toolContext: { workspaceRoot },
    maxIterations: options.maxIterations,
    toolExecutor: options.toolExecutor,
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
