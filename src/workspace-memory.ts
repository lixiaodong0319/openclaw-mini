import fs from "node:fs/promises";
import path from "node:path";

// OpenClaw 风格的第一层长期记忆：Markdown 是唯一真相源。
// 之后即使增加 SQLite/向量索引，索引也只是可重建的派生数据。
export const WORKSPACE_MEMORY_FILE = "MEMORY.md";
export const DAILY_MEMORY_DIRECTORY = "memory";

// 只限制注入模型的副本，不截断或改写磁盘上的 MEMORY.md。
// 文件过大时，用户可以把细节迁移到后续实现的 memory/*.md 中。
export const MAX_MEMORY_BOOTSTRAP_BYTES = 32 * 1024;
// 今天和昨天的所有日期文件共享一份预算；文件过多时优先保留今天，再保留昨天。
export const MAX_DAILY_MEMORY_BOOTSTRAP_BYTES = 32 * 1024;
export const MAX_DAILY_MEMORY_FILES = 20;

export interface WorkspaceMemory {
  relativePath: typeof WORKSPACE_MEMORY_FILE;
  content: string;
  bytes: number;
  injectedBytes: number;
  truncated: boolean;
}

export interface DailyWorkspaceMemory {
  relativePath: string;
  date: string;
  content: string;
  bytes: number;
  injectedBytes: number;
  truncated: boolean;
}

export interface WorkspaceMemoryContext {
  longTerm?: WorkspaceMemory;
  daily: DailyWorkspaceMemory[];
  today: string;
  yesterday: string;
  // discoveredDailyFiles 包含因文件数或字节预算没有进入 daily 数组的匹配文件。
  discoveredDailyFiles: number;
  dailyTruncated: boolean;
}

export async function loadWorkspaceMemory(
  workspaceRoot: string,
): Promise<WorkspaceMemory | undefined> {
  const memoryPath = path.join(workspaceRoot, WORKSPACE_MEMORY_FILE);
  let stat: import("node:fs").Stats;
  try {
    // lstat 不跟随最后一段符号链接，让记忆来源始终是 workspace 中的明确文件。
    stat = await fs.lstat(memoryPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }

  if (stat.isSymbolicLink()) throw new Error(`${WORKSPACE_MEMORY_FILE} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${WORKSPACE_MEMORY_FILE} must be a regular file`);

  // 只读 bootstrap 预算所需的前缀，避免为了注入一小段而把超大文件全部载入内存。
  const file = await fs.open(memoryPath, "r");
  let prefix: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_MEMORY_BOOTSTRAP_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }

  let content: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // 文件超过预算时使用 stream:true：它只保留末尾被切断的合法 UTF-8 码点，
    // 前缀内真正的非法序列仍会在 fatal 模式下抛错。完整文件则必须正常 flush。
    content = decoder.decode(prefix, { stream: stat.size > prefix.length });
  } catch {
    throw new Error(`${WORKSPACE_MEMORY_FILE} must contain valid UTF-8 text`);
  }
  if (content.includes("\0")) throw new Error(`${WORKSPACE_MEMORY_FILE} must be a UTF-8 text file`);
  const injectedBytes = Buffer.byteLength(content, "utf8");
  return {
    relativePath: WORKSPACE_MEMORY_FILE,
    content,
    bytes: stat.size,
    injectedBytes,
    truncated: stat.size > injectedBytes,
  };
}

export async function loadWorkspaceMemoryContext(
  workspaceRoot: string,
  now = new Date(),
): Promise<WorkspaceMemoryContext> {
  const [longTerm, dailyResult] = await Promise.all([
    loadWorkspaceMemory(workspaceRoot),
    loadRecentDailyMemories(workspaceRoot, now),
  ]);
  return {
    longTerm,
    daily: dailyResult.memories,
    today: dailyResult.today,
    yesterday: dailyResult.yesterday,
    discoveredDailyFiles: dailyResult.discoveredFiles,
    dailyTruncated: dailyResult.truncated,
  };
}

export async function loadRecentDailyMemories(
  workspaceRoot: string,
  now = new Date(),
): Promise<{
  memories: DailyWorkspaceMemory[];
  today: string;
  yesterday: string;
  discoveredFiles: number;
  truncated: boolean;
}> {
  const memoryDirectory = path.join(workspaceRoot, DAILY_MEMORY_DIRECTORY);
  let directoryStat: import("node:fs").Stats;
  try {
    // memory/ 也必须是真实目录，不能通过目录符号链接把每日记忆源扩展到 workspace 外。
    directoryStat = await fs.lstat(memoryDirectory);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      const today = formatLocalDate(now);
      const yesterdayDate = new Date(now);
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      return {
        memories: [],
        today,
        yesterday: formatLocalDate(yesterdayDate),
        discoveredFiles: 0,
        truncated: false,
      };
    }
    throw error;
  }
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`${DAILY_MEMORY_DIRECTORY} must not be a symbolic link`);
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`${DAILY_MEMORY_DIRECTORY} must be a directory`);
  }

  const today = formatLocalDate(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = formatLocalDate(yesterdayDate);
  const entries = await fs.readdir(memoryDirectory, { withFileTypes: true });

  // 先按“今天 → 昨天”选择，确保预算不足时较新的运行上下文优先进入提示词。
  // 同一天内 date-only 文件排在 slug 变体前，之后按文件名稳定排序。
  const candidates = [today, yesterday].flatMap((date) => entries
    .filter((entry) => isDailyMemoryFileName(entry.name, date))
    .sort((left, right) => compareDailyNames(left.name, right.name, date))
    .map((entry) => ({ entry, date })));

  let remainingBytes = MAX_DAILY_MEMORY_BOOTSTRAP_BYTES;
  const memories: DailyWorkspaceMemory[] = [];
  for (const candidate of candidates.slice(0, MAX_DAILY_MEMORY_FILES)) {
    if (remainingBytes <= 0) break;
    const relativePath = `${DAILY_MEMORY_DIRECTORY}/${candidate.entry.name}`;
    const filePath = path.join(memoryDirectory, candidate.entry.name);
    // Dirent 信息可能在 readdir 后变化，因此实际读取前仍用 lstat 重新验证。
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new Error(`${relativePath} must not be a symbolic link`);
    if (!stat.isFile()) throw new Error(`${relativePath} must be a regular file`);
    const loaded = await readMarkdownPrefix(filePath, relativePath, stat.size, remainingBytes);
    memories.push({
      relativePath,
      date: candidate.date,
      content: loaded.content,
      bytes: stat.size,
      injectedBytes: loaded.injectedBytes,
      truncated: stat.size > loaded.injectedBytes,
    });
    remainingBytes -= loaded.injectedBytes;
  }

  // 注入和展示时恢复为“昨天 → 今天”的自然时间顺序；预算优先级不受影响。
  memories.sort((left, right) => left.date.localeCompare(right.date)
    || compareDailyNames(path.basename(left.relativePath), path.basename(right.relativePath), left.date));
  return {
    memories,
    today,
    yesterday,
    discoveredFiles: candidates.length,
    truncated: candidates.length > memories.length || memories.some((memory) => memory.truncated),
  };
}

export function describeWorkspaceMemory(memory?: WorkspaceMemory): string {
  if (!memory) return "not found";
  const suffix = memory.truncated ? `, ${memory.injectedBytes} bytes injected` : "";
  return `${memory.relativePath} (${memory.bytes} bytes${suffix})`;
}

export function describeDailyMemories(context: WorkspaceMemoryContext): string {
  if (context.discoveredDailyFiles === 0) return "not found";
  const injectedBytes = context.daily.reduce((total, memory) => total + memory.injectedBytes, 0);
  const suffix = context.dailyTruncated ? ", truncated" : "";
  return `${context.daily.length}/${context.discoveredDailyFiles} file(s), ${injectedBytes} bytes injected${suffix}`;
}

// Memory Flush 与每日记忆加载必须使用完全相同的本地日期规则，否则临近午夜时可能
// 写入一个不会被当前 bootstrap 发现的文件。导出该函数以避免复制日期算法。
export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDailyMemoryFileName(name: string, date: string): boolean {
  if (name === `${date}.md`) return true;
  // slug 只接受便于跨平台使用的安全字符，例如 2026-08-13-session-a.md。
  const escapedDate = date.replaceAll("-", "\\-");
  return new RegExp(`^${escapedDate}-[A-Za-z0-9][A-Za-z0-9_-]*\\.md$`).test(name);
}

function compareDailyNames(left: string, right: string, date: string): number {
  const dateOnly = `${date}.md`;
  if (left === dateOnly) return right === dateOnly ? 0 : -1;
  if (right === dateOnly) return 1;
  return left.localeCompare(right);
}

async function readMarkdownPrefix(
  filePath: string,
  relativePath: string,
  fileBytes: number,
  byteBudget: number,
): Promise<{ content: string; injectedBytes: number }> {
  const file = await fs.open(filePath, "r");
  let prefix: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(fileBytes, byteBudget));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }

  let content: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    content = decoder.decode(prefix, { stream: fileBytes > prefix.length });
  } catch {
    throw new Error(`${relativePath} must contain valid UTF-8 text`);
  }
  if (content.includes("\0")) throw new Error(`${relativePath} must be a UTF-8 text file`);
  return { content, injectedBytes: Buffer.byteLength(content, "utf8") };
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
