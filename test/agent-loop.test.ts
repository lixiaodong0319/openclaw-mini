import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/agent-loop.js";
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
  } = {},
): AgentLoop {
  return new AgentLoop({
    provider: new AnthropicProvider({
      client,
      model: "claude-opus-5",
      messages,
      onMessage: options.onMessage,
    }),
    toolContext: { workspaceRoot },
    maxIterations: options.maxIterations,
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

    await loop.runTurn("divide");

    expect(messages[2]).toEqual({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: [{ type: "text", text: "division by zero is not allowed" }],
        is_error: true,
      }],
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
