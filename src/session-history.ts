import Anthropic from "@anthropic-ai/sdk";
import { CONTEXT_SUMMARY_ACK, CONTEXT_SUMMARY_PREFIX } from "./context-compaction.js";
import type { OpenAIInputItem, OpenAIUserInput } from "./provider.js";
import type { RuntimeConfig } from "./runtime.js";
import { SessionStore } from "./session-store.js";

export type HistoryEntry =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "tool"; name: string; status: "completed" | "failed" | "unknown" }
  | { type: "summary"; text: string };

export interface SessionHistoryView {
  sessionId: string;
  entries: HistoryEntry[];
  truncated: boolean;
}

type ToolHistoryEntry = Extract<HistoryEntry, { type: "tool" }>;

const MAX_HISTORY_ENTRIES = 200;

export async function loadSessionHistory(
  config: RuntimeConfig,
  sessionId: string,
): Promise<SessionHistoryView> {
  const entries = config.providerName === "openai"
    ? normalizeOpenAIHistory(await new SessionStore<OpenAIInputItem>(
      config.dataRoot,
      sessionId,
      "openai",
    ).load())
    : normalizeAnthropicHistory(await new SessionStore<Anthropic.MessageParam>(
      config.dataRoot,
      sessionId,
      "anthropic",
    ).load());
  return limitHistoryEntries(sessionId, entries);
}

export function normalizeAnthropicHistory(messages: Anthropic.MessageParam[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const tools = new Map<string, ToolHistoryEntry>();
  let skipSummaryAck = false;

  for (const message of messages) {
    if (typeof message.content === "string") {
      if (message.role === "user") {
        skipSummaryAck = appendUserOrSummary(entries, message.content);
      } else if (!(skipSummaryAck && message.content === CONTEXT_SUMMARY_ACK)) {
        appendMessage(entries, "assistant", message.content);
        skipSummaryAck = false;
      } else {
        skipSummaryAck = false;
      }
      continue;
    }

    let text = "";
    const flushText = (): void => {
      if (text.trim().length === 0) {
        text = "";
        return;
      }
      if (message.role === "user") {
        skipSummaryAck = appendUserOrSummary(entries, text);
      } else if (!(skipSummaryAck && text.trim() === CONTEXT_SUMMARY_ACK)) {
        appendMessage(entries, "assistant", text);
        skipSummaryAck = false;
      } else {
        skipSummaryAck = false;
      }
      text = "";
    };

    for (const block of message.content) {
      if (block.type === "text") {
        text += text.length === 0 ? block.text : `\n${block.text}`;
        continue;
      }
      flushText();
      if (block.type === "tool_use") {
        const entry: ToolHistoryEntry = {
          type: "tool",
          name: block.name,
          status: "unknown",
        };
        entries.push(entry);
        tools.set(block.id, entry);
      } else if (block.type === "tool_result") {
        const tool = tools.get(block.tool_use_id);
        if (tool) tool.status = block.is_error ? "failed" : "completed";
      }
      // thinking、redacted_thinking 和 tool_result 内容不会进入历史视图。
    }
    flushText();
  }

  return entries;
}

export function normalizeOpenAIHistory(items: OpenAIInputItem[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  const tools = new Map<string, ToolHistoryEntry>();

  for (const item of items) {
    if (isOpenAIUserMessage(item)) {
      appendUserOrSummary(entries, extractOpenAIUserInputText(item.content));
      continue;
    }
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      const entry: ToolHistoryEntry = {
        type: "tool",
        name: item.name,
        status: "unknown",
      };
      entries.push(entry);
      tools.set(item.call_id, entry);
      continue;
    }
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      const tool = tools.get(item.call_id);
      if (tool) tool.status = isOpenAIToolError(item.output) ? "failed" : "completed";
      continue;
    }
    if (item.type === "message" && item.role === "assistant") {
      appendMessage(entries, "assistant", extractOpenAIMessageText(item));
    }
    // reasoning 及其他 Responses API 内部 item 默认忽略。
  }

  return entries;
}

function limitHistoryEntries(sessionId: string, entries: HistoryEntry[]): SessionHistoryView {
  if (entries.length <= MAX_HISTORY_ENTRIES) {
    return { sessionId, entries, truncated: false };
  }
  const recent = entries.slice(-(MAX_HISTORY_ENTRIES - 1));
  // 压缩摘要包含早期对话的重要事实；即使列表截断，也尽量保留第一条摘要。
  const first = entries[0];
  const limited = first?.type === "summary"
    ? [first, ...recent]
    : entries.slice(-MAX_HISTORY_ENTRIES);
  return { sessionId, entries: limited, truncated: true };
}

function appendUserOrSummary(entries: HistoryEntry[], text: string): boolean {
  if (text.startsWith(CONTEXT_SUMMARY_PREFIX)) {
    const summary = text.slice(CONTEXT_SUMMARY_PREFIX.length).trim();
    if (summary.length > 0) entries.push({ type: "summary", text: summary });
    return true;
  }
  appendMessage(entries, "user", text);
  return false;
}

function appendMessage(entries: HistoryEntry[], role: "user" | "assistant", text: string): void {
  const normalized = text.trim();
  if (normalized.length > 0) entries.push({ type: "message", role, text: normalized });
}

function isOpenAIUserMessage(item: OpenAIInputItem): item is OpenAIUserInput {
  return "role" in item
    && item.role === "user"
    && (typeof item.content === "string" || Array.isArray(item.content));
}

function extractOpenAIUserInputText(content: OpenAIUserInput["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "input_text")
    .map((part) => part.text)
    .join("\n");
}

function extractOpenAIMessageText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  const parts: string[] = [];
  for (const content of item.content) {
    if (!isRecord(content)) continue;
    if (content.type === "output_text" && typeof content.text === "string") {
      parts.push(content.text);
    } else if (content.type === "refusal" && typeof content.refusal === "string") {
      parts.push(content.refusal);
    }
  }
  return parts.join("\n");
}

function isOpenAIToolError(output: unknown): boolean {
  if (typeof output !== "string") return false;
  try {
    const parsed = JSON.parse(output) as unknown;
    return isRecord(parsed) && typeof parsed.error === "string";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
