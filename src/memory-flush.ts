import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DAILY_MEMORY_DIRECTORY,
  formatLocalDate,
} from "./workspace-memory.js";

// memory-index 对单个 Markdown 的上限也是 8 MiB。Memory Flush 遵守相同边界，
// 避免自动压缩不断追加内容后，生成一个无法被后续 memory_search 索引的文件。
const MAX_DAILY_MEMORY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_FLUSH_BYTES = 64 * 1024;
const MEMORY_FLUSH_MARKER_PREFIX = "openclaw:memory-flush:";

export interface MemoryFlushResult {
  path: string;
  // false 表示相同摘要以前已经落盘。它仍然是成功，不应显示为错误或阻止压缩。
  written: boolean;
  bytesWritten: number;
}

export type MemoryFlushHandler = (summary: string) => Promise<MemoryFlushResult>;

/**
 * 把即将替代早期会话的压缩摘要写入当天 Markdown。
 *
 * Provider 已经用专用摘要提示词提取了目标、决策、约束、重要事实、文件路径和未完成
 * 工作，因此这里复用摘要，不再额外请求一次模型。写入发生在 Provider 替换原生历史
 * 之前；即使之后 Session 被清理，重要上下文仍保留在 workspace 的每日记忆中。
 */
export class WorkspaceMemoryFlusher {
  // CLI 的不同 Session 和 Web 的并发请求共享同一个实例。Promise 链让“读取旧内容、
  // 判断重复、追加新块”成为进程内串行操作，避免两个压缩同时覆盖或重复写入。
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  flush(summary: string): Promise<MemoryFlushResult> {
    const pending = this.writeQueue.then(() => this.performFlush(summary));
    // 无论本次成功还是失败，都把队列恢复为 fulfilled，后续压缩仍可继续尝试写入。
    this.writeQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async performFlush(summary: string): Promise<MemoryFlushResult> {
    const normalized = validateSummary(summary);
    const now = this.now();
    const date = formatLocalDate(now);
    const relativePath = `${DAILY_MEMORY_DIRECTORY}/${date}.md`;
    const directoryPath = path.join(this.workspaceRoot, DAILY_MEMORY_DIRECTORY);
    const filePath = path.join(directoryPath, `${date}.md`);

    await ensureMemoryDirectory(directoryPath);
    const existing = await readExistingDailyMemory(filePath, relativePath);
    // Marker 使用摘要内容 Hash，而不是时间。手动重复 /compact 或失败重试产生相同摘要时，
    // 可以稳定识别为同一份记忆，不会因为标题时间不同而重复追加。
    const summaryHash = createHash("sha256").update(normalized, "utf8").digest("hex");
    const marker = `<!-- ${MEMORY_FLUSH_MARKER_PREFIX}${summaryHash} -->`;
    if (existing.includes(marker)) {
      return { path: relativePath, written: false, bytesWritten: 0 };
    }

    const time = formatLocalTime(now);
    const block = `## 压缩前会话记忆 ${time}\n${marker}\n\n${normalized}\n`;
    const prefix = existing.length === 0
      ? `# ${date}\n\n`
      : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    const addition = `${prefix}${block}`;
    const bytesWritten = Buffer.byteLength(addition, "utf8");
    if (Buffer.byteLength(existing, "utf8") + bytesWritten > MAX_DAILY_MEMORY_FILE_BYTES) {
      throw new Error(`${relativePath} is too large for automatic memory flush`);
    }

    // appendFile 保留用户手工写入的每日记录；Memory Flush 永远不重写整个 Markdown。
    await fs.appendFile(filePath, addition, { encoding: "utf8", flag: "a" });
    return { path: relativePath, written: true, bytesWritten };
  }
}

function validateSummary(summary: string): string {
  if (typeof summary !== "string") throw new Error("memory flush summary must be a string");
  const normalized = summary.trim();
  if (normalized.length === 0) throw new Error("memory flush summary must not be empty");
  if (normalized.includes("\0")) throw new Error("memory flush summary must be UTF-8 text");
  if (Buffer.byteLength(normalized, "utf8") > MAX_MEMORY_FLUSH_BYTES) {
    throw new Error(`memory flush summary exceeds ${MAX_MEMORY_FLUSH_BYTES} bytes`);
  }
  return normalized;
}

async function ensureMemoryDirectory(directoryPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(directoryPath);
    if (stat.isSymbolicLink()) throw new Error(`${DAILY_MEMORY_DIRECTORY} must not be a symbolic link`);
    if (!stat.isDirectory()) throw new Error(`${DAILY_MEMORY_DIRECTORY} must be a directory`);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
    await fs.mkdir(directoryPath, { recursive: true });
  }
}

async function readExistingDailyMemory(filePath: string, relativePath: string): Promise<string> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${relativePath} must not be a symbolic link`);
    if (!stat.isFile()) throw new Error(`${relativePath} must be a regular file`);
    if (stat.size > MAX_DAILY_MEMORY_FILE_BYTES) {
      throw new Error(`${relativePath} is too large for automatic memory flush`);
    }
    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) throw new Error(`${relativePath} must be a UTF-8 text file`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`${relativePath} must contain valid UTF-8 text`);
    }
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return "";
    throw error;
  }
}

function formatLocalTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
