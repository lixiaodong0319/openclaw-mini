import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentEvent } from "../src/agent-loop.js";
import type { ContextCompactionOptions } from "../src/context-compaction.js";
import { OpenAIProvider, type OpenAIInputItem, type OpenAIResponseItem } from "../src/provider.js";
import { openAIResponse, FakeOpenAIProvider } from "./fake-openai-provider.js";

function outputMessage(text: string): OpenAIResponseItem {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function functionCall(callId: string, name: string, args: unknown): OpenAIResponseItem {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function createLoop(
  client: FakeOpenAIProvider,
  input: OpenAIInputItem[],
  workspaceRoot: string,
  options: {
    onItem?: (item: OpenAIInputItem) => Promise<void>;
    maxIterations?: number;
    compaction?: Partial<ContextCompactionOptions>;
    onHistoryReplace?: (items: OpenAIInputItem[]) => Promise<void>;
  } = {},
): AgentLoop {
  return new AgentLoop({
    provider: new OpenAIProvider({
      client,
      model: "gpt-5.3-codex",
      input,
      onItem: options.onItem,
      onHistoryReplace: options.onHistoryReplace,
      compaction: options.compaction,
    }),
    toolContext: { workspaceRoot },
    maxIterations: options.maxIterations,
  });
}

describe("OpenAIProvider adapter", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-openai-loop-"));
  });

  it("uses the shared AgentLoop for final text", async () => {
    const client = new FakeOpenAIProvider([openAIResponse([outputMessage("hello")])]);
    const persisted: OpenAIInputItem[] = [];
    const loop = createLoop(client, [], workspaceRoot, {
      onItem: async (item) => {
        persisted.push(item);
      },
    });

    await expect(loop.runTurn("hi")).resolves.toEqual({ text: "hello", stopReason: "completed" });
    expect(persisted).toHaveLength(2);
  });

  it("forwards Responses API text deltas", async () => {
    const client = new FakeOpenAIProvider(
      [openAIResponse([outputMessage("hello")])],
      [["hel", "lo"]],
    );
    const loop = createLoop(client, [], workspaceRoot);
    const events: AgentEvent[] = [];

    await loop.runTurn("hi", (event) => events.push(event));

    expect(events).toEqual([
      { type: "text_delta", text: "hel" },
      { type: "text_delta", text: "lo" },
    ]);
  });

  it("compacts old OpenAI history while preserving recent function call items", async () => {
    const recentReasoning = { type: "reasoning", id: "rs_recent", summary: [] } satisfies OpenAIResponseItem;
    const recentCall = functionCall("call_recent", "calculator", { operation: "add", a: 1, b: 2 });
    const recentOutput: OpenAIInputItem = {
      type: "function_call_output",
      call_id: "call_recent",
      output: "3",
    };
    const input: OpenAIInputItem[] = [
      { role: "user", content: "old detail ".repeat(500) },
      outputMessage("old answer"),
      { role: "user", content: "recent question" },
      recentReasoning,
      recentCall,
      recentOutput,
      outputMessage("recent answer"),
    ];
    const client = new FakeOpenAIProvider([
      openAIResponse([outputMessage("compressed old facts")]),
      openAIResponse([outputMessage("new answer")]),
    ]);
    const replacements: OpenAIInputItem[][] = [];
    const loop = createLoop(client, input, workspaceRoot, {
      compaction: { tokenThreshold: 10, keepRecentTurns: 1, summaryMaxTokens: 100 },
      onHistoryReplace: async (replacement) => {
        replacements.push(structuredClone(replacement));
      },
    });
    const events: AgentEvent[] = [];

    await loop.runTurn("new question", (event) => events.push(event));

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.tools).toEqual([]);
    expect(client.calls[0]?.max_output_tokens).toBe(100);
    expect(replacements[0]?.[0]).toEqual({
      role: "user",
      content: "[压缩的早期会话摘要]\ncompressed old facts",
    });
    const requestInput = client.calls[1]?.input ?? [];
    expect(requestInput).toContainEqual(recentReasoning);
    expect(requestInput).toContainEqual(recentCall);
    expect(requestInput).toContainEqual(recentOutput);
    expect(requestInput.at(-1)).toEqual({ role: "user", content: "new question" });
    expect(events[0]).toMatchObject({ type: "context_compaction_start" });
    expect(events[1]).toMatchObject({ type: "context_compaction_end" });
  });

  it("preserves reasoning items and returns function output", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [] } satisfies OpenAIResponseItem;
    const client = new FakeOpenAIProvider([
      openAIResponse([reasoning, functionCall("call_1", "calculator", { operation: "multiply", a: 6, b: 7 })]),
      openAIResponse([outputMessage("42")]),
    ]);
    const input: OpenAIInputItem[] = [];
    const loop = createLoop(client, input, workspaceRoot);

    await expect(loop.runTurn("6*7?")).resolves.toEqual({ text: "42", stopReason: "completed" });
    expect(client.calls[1]?.input).toContainEqual(reasoning);
    expect(client.calls[1]?.input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "42",
    });
  });

  it("executes parallel function calls through the shared loop", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "note", "utf8");
    const client = new FakeOpenAIProvider([
      openAIResponse([
        functionCall("call_1", "calculator", { operation: "add", a: 1, b: 2 }),
        functionCall("call_2", "read_text_file", { path: "note.txt" }),
      ]),
      openAIResponse([outputMessage("done")]),
    ]);
    const input: OpenAIInputItem[] = [];
    const loop = createLoop(client, input, workspaceRoot);

    await loop.runTurn("use tools");

    expect(input).toContainEqual({ type: "function_call_output", call_id: "call_1", output: "3" });
    expect(input).toContainEqual({ type: "function_call_output", call_id: "call_2", output: "note" });
  });

  it("adapts shared tool errors to structured function outputs", async () => {
    const client = new FakeOpenAIProvider([
      openAIResponse([functionCall("call_1", "calculator", { operation: "divide", a: 1, b: 0 })]),
      openAIResponse([outputMessage("handled")]),
    ]);
    const input: OpenAIInputItem[] = [];
    const loop = createLoop(client, input, workspaceRoot);

    await loop.runTurn("divide");

    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ error: "division by zero is not allowed" }),
    });
  });

  it("adapts denied tool calls to structured function outputs", async () => {
    const client = new FakeOpenAIProvider([
      openAIResponse([functionCall("call_1", "write_text_file", { path: "note.txt", content: "hello" })]),
      openAIResponse([outputMessage("cancelled")]),
    ]);
    const input: OpenAIInputItem[] = [];
    const loop = createLoop(client, input, workspaceRoot);

    await loop.runTurn("save it", undefined, async () => false);

    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ error: "Tool execution denied by user: write_text_file" }),
    });
  });

  it("executes approved write calls through the shared loop", async () => {
    const client = new FakeOpenAIProvider([
      openAIResponse([functionCall("call_1", "write_text_file", { path: "note.txt", content: "hello" })]),
      openAIResponse([outputMessage("saved")]),
    ]);
    const input: OpenAIInputItem[] = [];
    const loop = createLoop(client, input, workspaceRoot);

    await loop.runTurn("save it", undefined, async () => true);

    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("hello");
    expect(input).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ path: "note.txt", bytes: 5, created: true }, null, 2),
    });
  });

  it("shares the same iteration limit behavior", async () => {
    const client = new FakeOpenAIProvider([
      openAIResponse([functionCall("call_1", "calculator", { operation: "add", a: 1, b: 1 })]),
    ]);
    const loop = createLoop(client, [], workspaceRoot, { maxIterations: 1 });

    await expect(loop.runTurn("loop")).resolves.toEqual({
      text: "Agent Loop 达到最大工具迭代次数。",
      stopReason: "iteration_limit",
    });
  });
});
