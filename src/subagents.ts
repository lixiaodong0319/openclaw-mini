import type {
  AgentEventHandler,
  ToolConfirmationHandler,
  TurnResult,
} from "./agent-loop.js";

export const SUBAGENT_TYPES = ["test", "docs"] as const;
export type SubagentType = typeof SUBAGENT_TYPES[number];

// 子任务会进入一次独立模型请求。限制任务文本可避免主模型把整段历史或大文件内容
// 复制进子 Agent；需要源码时应让子 Agent 自己使用 workspace 只读工具获取。
export const MAX_SUBAGENT_TASK_BYTES = 8 * 1024;
export const MAX_SUBAGENT_RESULT_BYTES = 64 * 1024;

export interface SubagentRequest {
  agent: SubagentType;
  task: string;
}

export interface SubagentRunOptions {
  // 子 Agent 的文本不会直接流到主界面；非文本事件由主 Agent 加上 agent 标记后转发，
  // 让 CLI/Web 仍能展示它正在调用什么工具。
  onEvent?: AgentEventHandler;
  // 子 Agent 沿用当前用户轮次的确认通道。它不能因为被委派就绕过写文件或 Shell 审批。
  confirmTool?: ToolConfirmationHandler;
}

export type SubagentRunner = (
  request: SubagentRequest,
  options?: SubagentRunOptions,
) => Promise<TurnResult>;

/**
 * 子 Agent 的职责由宿主固定，不接受模型自定义 system prompt。
 * 这样主模型只能选择有限角色和任务，不能借委派覆盖 workspace 指令或权限规则。
 */
export function getSubagentRolePrompt(agent: SubagentType): string {
  if (agent === "test") {
    return `You are the test sub-agent for OpenClaw.
Work only on the delegated task. Inspect the workspace, select focused verification, and run tests when useful.
Do not modify product code to make a test pass. You may create or edit test artifacts only when the delegated task explicitly asks for it and the user approves the corresponding tool call.
Return a concise evidence-based report containing what you checked, exact commands when relevant, failures, and remaining risks.
You have an independent conversation context. Do not attempt to delegate again or update the parent task plan.`;
  }

  return `You are the documentation sub-agent for OpenClaw.
Work only on the delegated task. Read the relevant implementation before explaining it, and keep terminology and examples consistent with the code.
Do not change source code. Edit documentation only when the delegated task explicitly asks for a documentation change and the user approves the corresponding tool call.
Return a concise result containing the findings and any documentation paths changed.
You have an independent conversation context. Do not attempt to delegate again or update the parent task plan.`;
}

export function parseSubagentRequest(input: unknown): SubagentRequest {
  if (!isRecord(input) || typeof input.agent !== "string" || typeof input.task !== "string") {
    throw new Error("run_subagent requires string agent and task fields");
  }
  if (!SUBAGENT_TYPES.includes(input.agent as SubagentType)) {
    throw new Error(`run_subagent agent must be one of: ${SUBAGENT_TYPES.join(", ")}`);
  }
  const task = input.task.trim();
  if (task.length === 0) throw new Error("run_subagent task must not be empty");
  if (Buffer.byteLength(task, "utf8") > MAX_SUBAGENT_TASK_BYTES) {
    throw new Error(`run_subagent task is too large; maximum is ${MAX_SUBAGENT_TASK_BYTES} bytes`);
  }
  return { agent: input.agent as SubagentType, task };
}

/**
 * 工具结果使用有界 JSON，而不是把子 Agent 的原始历史合并到主 Agent。
 * 这既保持上下文隔离，也防止异常冗长的报告一次性挤占主会话上下文。
 */
export function formatSubagentResult(
  request: SubagentRequest,
  result: TurnResult,
): string {
  const bounded = truncateUtf8(result.text, MAX_SUBAGENT_RESULT_BYTES);
  return JSON.stringify({
    agent: request.agent,
    status: "completed",
    stopReason: result.stopReason,
    result: bounded.text,
    truncated: bounded.truncated,
  }, null, 2);
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  const suffix = `\n[Sub-agent result truncated at ${maxBytes} bytes]`;
  // 后缀也是回填内容的一部分，所以先预留其字节数，保证 result 字段整体不超过上限。
  // maxBytes 是内部固定正整数；Math.max 只是让这个帮助函数在未来复用较小上限时仍安全。
  let end = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  // UTF-8 continuation byte 的高两位是 10；向前移动到字符边界，避免返回替换字符。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: `${bytes.subarray(0, end).toString("utf8")}${suffix}`,
    truncated: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
