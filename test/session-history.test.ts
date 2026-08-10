import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONTEXT_SUMMARY_ACK, CONTEXT_SUMMARY_PREFIX } from "../src/context-compaction.js";
import type { OpenAIInputItem } from "../src/provider.js";
import type { RuntimeConfig } from "../src/runtime.js";
import {
  loadSessionHistory,
  normalizeAnthropicHistory,
  normalizeOpenAIHistory,
} from "../src/session-history.js";
import { SessionStore } from "../src/session-store.js";

describe("session history view", () => {
  it("normalizes Anthropic messages without exposing thinking or tool output", () => {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: `${CONTEXT_SUMMARY_PREFIX}earlier facts` }] },
      { role: "assistant", content: [{ type: "text", text: CONTEXT_SUMMARY_ACK }] },
      { role: "user", content: [{ type: "text", text: "calculate" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private chain", signature: "signature" },
          { type: "text", text: "I will use a tool" },
          { type: "tool_use", id: "tool-1", name: "calculator", input: { secret: "hidden input" } },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [{ type: "text", text: "hidden output" }],
        }],
      },
      { role: "assistant", content: [{ type: "text", text: "The answer is 4" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "run_command", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-2", content: "secret error", is_error: true }],
      },
    ];

    expect(normalizeAnthropicHistory(messages)).toEqual([
      { type: "summary", text: "earlier facts" },
      { type: "message", role: "user", text: "calculate" },
      { type: "message", role: "assistant", text: "I will use a tool" },
      { type: "tool", name: "calculator", status: "completed" },
      { type: "message", role: "assistant", text: "The answer is 4" },
      { type: "tool", name: "run_command", status: "failed" },
    ]);
    expect(JSON.stringify(normalizeAnthropicHistory(messages))).not.toContain("private chain");
    expect(JSON.stringify(normalizeAnthropicHistory(messages))).not.toContain("hidden output");
  });

  it("normalizes OpenAI items without exposing reasoning, arguments, or function output", () => {
    const items: OpenAIInputItem[] = [
      { role: "user", content: `${CONTEXT_SUMMARY_PREFIX}earlier facts` },
      { role: "user", content: "calculate" },
      { type: "reasoning", summary: [{ text: "private reasoning" }] },
      {
        type: "function_call",
        call_id: "call-1",
        name: "calculator",
        arguments: JSON.stringify({ secret: "hidden input" }),
      },
      { type: "function_call_output", call_id: "call-1", output: "hidden output" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The answer is 4" }],
      },
      { type: "function_call", call_id: "call-2", name: "run_command", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call-2",
        output: JSON.stringify({ error: "hidden error" }),
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "refusal", refusal: "I cannot do that" }],
      },
    ];

    const history = normalizeOpenAIHistory(items);
    expect(history).toEqual([
      { type: "summary", text: "earlier facts" },
      { type: "message", role: "user", text: "calculate" },
      { type: "tool", name: "calculator", status: "completed" },
      { type: "message", role: "assistant", text: "The answer is 4" },
      { type: "tool", name: "run_command", status: "failed" },
      { type: "message", role: "assistant", text: "I cannot do that" },
    ]);
    expect(JSON.stringify(history)).not.toContain("private reasoning");
    expect(JSON.stringify(history)).not.toContain("hidden output");
  });

  it("loads the selected Provider namespace and limits long history", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-"));
    const store = new SessionStore<OpenAIInputItem>(dataRoot, "long", "openai");
    await store.append({ role: "user", content: `${CONTEXT_SUMMARY_PREFIX}important summary` });
    for (let index = 0; index < 205; index += 1) {
      await store.append({ role: "user", content: `question-${index}` });
    }
    const config: RuntimeConfig = {
      projectRoot: dataRoot,
      workspaceRoot: path.join(dataRoot, "workspace"),
      dataRoot,
      providerName: "openai",
      model: "test-model",
    };

    const history = await loadSessionHistory(config, "long");

    expect(history.truncated).toBe(true);
    expect(history.entries).toHaveLength(200);
    expect(history.entries[0]).toEqual({ type: "summary", text: "important summary" });
    expect(history.entries.at(-1)).toEqual({ type: "message", role: "user", text: "question-204" });
    expect(history.entries).not.toContainEqual({ type: "message", role: "user", text: "question-0" });
  });
});
