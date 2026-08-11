import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "./agent-loop.js";

export const WORKSPACE_INSTRUCTIONS_FILE = "AGENTS.md";
export const MAX_WORKSPACE_INSTRUCTIONS_BYTES = 32 * 1024;

export interface WorkspaceInstructions {
  relativePath: string;
  content: string;
  bytes: number;
}

// AGENTS.md 是用户放进 workspace 的项目级指令，只读取根目录这一份，
// 不递归查找父目录或子目录，避免指令来源和覆盖优先级变得隐式。
export async function loadWorkspaceInstructions(
  workspaceRoot: string,
): Promise<WorkspaceInstructions | undefined> {
  const instructionPath = path.join(workspaceRoot, WORKSPACE_INSTRUCTIONS_FILE);
  let stat: import("node:fs").Stats;
  try {
    // lstat 不跟随最后一段符号链接，使 AGENTS.md 的来源保持在明确的 workspace 文件中。
    stat = await fs.lstat(instructionPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`${WORKSPACE_INSTRUCTIONS_FILE} must not be a symbolic link`);
  }
  if (!stat.isFile()) {
    throw new Error(`${WORKSPACE_INSTRUCTIONS_FILE} must be a regular file`);
  }
  if (stat.size > MAX_WORKSPACE_INSTRUCTIONS_BYTES) {
    throw new Error(
      `${WORKSPACE_INSTRUCTIONS_FILE} is too large; maximum is ${MAX_WORKSPACE_INSTRUCTIONS_BYTES} bytes`,
    );
  }

  const buffer = await fs.readFile(instructionPath);
  // 文件可能在 lstat 后发生变化，因此读取完成后仍按真实字节数再检查一次。
  if (buffer.length > MAX_WORKSPACE_INSTRUCTIONS_BYTES) {
    throw new Error(
      `${WORKSPACE_INSTRUCTIONS_FILE} is too large; maximum is ${MAX_WORKSPACE_INSTRUCTIONS_BYTES} bytes`,
    );
  }
  if (buffer.includes(0)) {
    throw new Error(`${WORKSPACE_INSTRUCTIONS_FILE} must be a UTF-8 text file`);
  }

  let content: string;
  try {
    // fatal: true 会拒绝非法 UTF-8，而不是悄悄插入替换字符 �。
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${WORKSPACE_INSTRUCTIONS_FILE} must contain valid UTF-8 text`);
  }

  return {
    relativePath: WORKSPACE_INSTRUCTIONS_FILE,
    content,
    bytes: buffer.length,
  };
}

export function buildSystemPrompt(instructions?: WorkspaceInstructions): string {
  if (!instructions) return DEFAULT_SYSTEM_PROMPT;

  // 指令进入每次 Provider 请求的 system/instructions 字段，不作为 user message
  // 追加到原生历史，因此不会写进 Session JSONL，也不会被上下文压缩当成会话内容。
  return `${DEFAULT_SYSTEM_PROMPT}

Follow the workspace instructions below when working in this workspace.

<workspace_instructions file="${instructions.relativePath}">
${instructions.content}
</workspace_instructions>`;
}

export function describeWorkspaceInstructions(instructions?: WorkspaceInstructions): string {
  return instructions
    ? `${instructions.relativePath} (${instructions.bytes} bytes)`
    : "not found";
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
