import type { HistoryEntry, SessionHistoryView } from "./session-history.js";
import type { McpStatusView } from "./mcp.js";
import type { WorkspaceSkill } from "./skills.js";

export const CLI_HELP_TEXT = `内置命令:
  /help             查看命令帮助
  /status           查看当前运行配置
  /sessions         列出当前 Provider 的 Session
  /new <id>         新建并切换 Session
  /switch <id>      切换到已有 Session
  /rename <new-id>  重命名当前 Session
  /delete <id>      删除 Session（需要确认）
  /history          查看当前 Session 的安全历史视图
  /mcp              查看已连接的 MCP Server 和工具
  /skills           查看已发现的 workspace Skills
  /plan             查看当前 Session 的任务计划
  /plan clear       清除当前 Session 的任务计划
  /memory           查看长期记忆
  /memory consolidate 预览并确认把每日记忆整理到 MEMORY.md
  /compact          保存压缩前记忆并手动压缩早期会话历史
  /clear            清空当前 Session 历史（需要确认）
  /exit             退出`;

export type CliCommandName =
  | "help"
  | "status"
  | "sessions"
  | "new"
  | "switch"
  | "rename"
  | "delete"
  | "history"
  | "mcp"
  | "skills"
  | "plan"
  | "memory"
  | "compact"
  | "clear"
  | "exit";

export interface ParsedCliCommand {
  name: string;
  argument: string;
}

const CLI_COMMAND_NAMES = new Set<CliCommandName>([
  "help",
  "status",
  "sessions",
  "new",
  "switch",
  "rename",
  "delete",
  "history",
  "mcp",
  "skills",
  "plan",
  "memory",
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

export function formatSessionList(sessionIds: string[], currentSessionId: string): string {
  const uniqueIds = [...new Set([...sessionIds, currentSessionId])]
    .sort((left, right) => left.localeCompare(right));
  const lines = uniqueIds.map((sessionId) => (
    `${sessionId === currentSessionId ? "*" : " "} ${sessionId}`
  ));
  return `[Session] ${uniqueIds.length} session(s)\n${lines.join("\n")}`;
}

export function formatMcpStatus(status: McpStatusView): string {
  if (status.serverCount === 0) {
    return "[MCP] 未连接 Server；请在项目根目录配置 mcp.json 后重启。";
  }

  const blocks = [`[MCP] ${status.serverCount} server(s), ${status.toolCount} tool(s)`];
  for (const server of status.servers) {
    blocks.push(`\n[Server] ${server.name}（${server.tools.length} tools）`);
    if (server.tools.length === 0) {
      blocks.push("  （没有发现工具）");
      continue;
    }
    for (const tool of server.tools) {
      blocks.push(`  - ${tool.name}\n    ${limitDescription(tool.description)}`);
    }
  }
  return blocks.join("\n");
}

export function formatSkillsStatus(skills: readonly WorkspaceSkill[]): string {
  if (skills.length === 0) {
    return "[Skills] 未发现技能；请在 workspace/skills/<name>/SKILL.md 中添加。";
  }

  const enabledCount = skills.filter((skill) => skill.enabled).length;
  const lines = [
    `[Skills] ${enabledCount} enabled, ${skills.length - enabledCount} disabled`,
  ];
  for (const skill of skills) {
    lines.push(
      `  - [${skill.enabled ? "启用" : "禁用"}] ${skill.name}\n    ${limitDescription(skill.description)}`,
    );
  }
  return lines.join("\n");
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

function limitDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`;
}
