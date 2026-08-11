import type { HistoryEntry, SessionHistoryView } from "./session-history.js";

export const CLI_HELP_TEXT = `内置命令:
  /help     查看命令帮助
  /status   查看当前运行配置
  /history  查看当前 Session 的安全历史视图
  /compact  手动压缩早期会话历史
  /clear    清空当前 Session 历史（需要确认）
  /exit     退出`;

export type CliCommandName = "help" | "status" | "history" | "compact" | "clear" | "exit";

export interface ParsedCliCommand {
  name: string;
  argument: string;
}

const CLI_COMMAND_NAMES = new Set<CliCommandName>([
  "help",
  "status",
  "history",
  "compact",
  "clear",
  "exit",
]);

// 返回 undefined 表示普通用户消息；只要以 / 开头，就由 CLI 命令分支处理，
// 未知命令不会误发给模型并消耗一次 API 请求。
export function parseCliCommand(input: string): ParsedCliCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;

  const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  return {
    name: (match?.[1] ?? "").toLowerCase(),
    argument: (match?.[2] ?? "").trim(),
  };
}

export function isCliCommandName(name: string): name is CliCommandName {
  return CLI_COMMAND_NAMES.has(name as CliCommandName);
}

export function formatSessionHistory(history: SessionHistoryView): string {
  if (history.entries.length === 0) {
    return `[会话] ${history.sessionId} 暂无历史`;
  }

  const blocks = history.entries.map(formatHistoryEntry);
  if (history.truncated) {
    blocks.unshift("[提示] 历史较长，仅展示安全视图中的最近 200 项");
  }
  return blocks.join("\n\n");
}

function formatHistoryEntry(entry: HistoryEntry): string {
  if (entry.type === "message") {
    return `[${entry.role === "user" ? "用户" : "助手"}] ${limitText(entry.text)}`;
  }
  if (entry.type === "summary") {
    return `[摘要] ${limitText(entry.text)}`;
  }
  const status = entry.status === "completed"
    ? "完成"
    : entry.status === "failed"
      ? "失败"
      : "状态未知";
  return `[工具] ${entry.name} ${status}`;
}

function limitText(text: string): string {
  const maxLength = 2_000;
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}\n...（单条历史已截断）`;
}
