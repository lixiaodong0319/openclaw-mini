import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentLoop, type AgentEvent } from "../src/agent-loop.js";
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
  } = {},
): AgentLoop {
  return new AgentLoop({
    provider: new OpenAIProvider({
      client,
      model: "gpt-5.3-codex",
      input,
      onItem: options.onItem,
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
