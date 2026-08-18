import Anthropic from "@anthropic-ai/sdk";
import { constants as fsConstants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { deleteTaskPlan, renameTaskPlan } from "./task-plan.js";

// 简单的泛型 JSONL 会话存储。
// 平时逐条追加；只有上下文压缩后才原子替换整个历史文件。
// 对这个 MVP 来说，它比数据库更容易观察，也方便手动查看一次会话中模型和工具之间发生了什么。
export class SessionStore<T = Anthropic.MessageParam> {
  private readonly filePath: string;

  constructor(dataRoot: string, sessionId: string, namespace?: string) {
    // sessionId 会直接参与生成文件名，所以这里把允许字符限制到非常小的集合。
    // 这样可以阻止 ../、斜杠、反斜杠、盘符等路径穿越或跨目录写入问题。
    validateSessionId(sessionId);
    validateSessionNamespace(namespace);

    // 所有会话统一放在 data/sessions 下。
    // data/ 已在 .gitignore 中忽略，避免把用户对话内容或工具结果误提交。
    this.filePath = namespace
      ? path.join(dataRoot, "sessions", namespace, `${sessionId}.jsonl`)
      : path.join(dataRoot, "sessions", `${sessionId}.jsonl`);
  }

  async load(): Promise<T[]> {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      // 过滤空行，允许文件最后以换行结尾。
      const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
      return lines.map((line, index) => {
        try {
          // Anthropic 会保存完整 MessageParam；OpenAI 会保存完整 Responses input/output item。
          // 如果只保存最终文本，会导致重启后工具调用链或 reasoning replay 断裂。
          return JSON.parse(line) as T;
        } catch (error) {
          // 损坏的 JSONL 不做静默跳过。
          // 静默丢弃历史会让模型基于缺失上下文继续工作，比直接报错更难排查。
          throw new Error(`invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    } catch (error) {
      // 新 session 第一次启动时文件不存在，这是正常空历史。
      // 其他 IO 错误继续抛出，例如权限不足或路径被目录占用。
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async append(message: T): Promise<void> {
    // append 前创建父目录，允许用户直接运行 CLI 而不需要手动创建 data/sessions。
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // 每条消息一行，按发生顺序追加。
    // MVP 限定单进程单 session 写入，所以暂不引入文件锁或数据库事务。
    await fs.appendFile(this.filePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  async replace(messages: T[]): Promise<void> {
    // 压缩后的数组已经是完整、有序的 Provider 原生历史。
    // 这里仍保持“每条历史一行”的 JSONL 格式，load() 不需要区分是原始会话还是压缩会话。
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const content = messages.map((message) => JSON.stringify(message)).join("\n");
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    // 临时文件与目标位于同一目录，rename 不需要跨文件系统复制。
    // 先完整写入再 rename 替换，可避免进程在 writeFile 中途退出时留下半截主 JSONL。
    try {
      await fs.writeFile(temporaryPath, content.length > 0 ? `${content}\n` : "", "utf8");
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      // 临时文件是可回收的中间状态；主历史仍保持 rename 之前的完整内容。
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

// Web UI 用它填充 session 下拉框。只返回符合 SessionStore 命名规则的 JSONL 文件，
// 临时文件、损坏命名和子目录都不会暴露给浏览器。
export async function listSessionIds(dataRoot: string, namespace?: string): Promise<string[]> {
  validateSessionNamespace(namespace);
  const directory = getSessionDirectory(dataRoot, namespace);
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -".jsonl".length))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

// 显式创建一个空 JSONL，使尚未发生对话的新会话也能立即出现在 CLI/Web 列表中。
// wx 使用排他创建，同名会话不会被截断或覆盖。
export async function createSession(
  dataRoot: string,
  sessionId: string,
  namespace?: string,
): Promise<void> {
  const filePath = getSessionFilePath(dataRoot, sessionId, namespace);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const handle = await fs.open(filePath, "wx");
    await handle.close();
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`session already exists: ${sessionId}`);
    }
    throw error;
  }
}

export async function sessionExists(
  dataRoot: string,
  sessionId: string,
  namespace?: string,
): Promise<boolean> {
  const filePath = getSessionFilePath(dataRoot, sessionId, namespace);
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

// 先以硬链接排他创建新名称，再删除旧名称：目标已存在时绝不覆盖；
// 两步之间进程退出时最多留下两个指向同一完整内容的名称，不会损坏历史。
export async function renameSession(
  dataRoot: string,
  oldSessionId: string,
  newSessionId: string,
  namespace?: string,
): Promise<void> {
  const source = getSessionFilePath(dataRoot, oldSessionId, namespace);
  const target = getSessionFilePath(dataRoot, newSessionId, namespace);
  await requireRegularSessionFile(source, oldSessionId);
  try {
    await fs.link(source, target);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`session already exists: ${newSessionId}`);
    }
    throw error;
  }
  let planRenamed = false;
  try {
    // 先保留新历史硬链接，再移动可选的计划文件。计划移动失败时删除新历史链接，
    // 旧 Session 仍然完整；历史源删除失败时也把计划移回旧名称。
    if (namespace) {
      planRenamed = await renameTaskPlan(dataRoot, oldSessionId, newSessionId, namespace);
    }
    await fs.unlink(source);
  } catch (error) {
    if (namespace && planRenamed) {
      await renameTaskPlan(dataRoot, newSessionId, oldSessionId, namespace).catch(() => undefined);
    }
    // 删除旧名称失败时撤销新链接，恢复到调用前状态。
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

export async function deleteSession(
  dataRoot: string,
  sessionId: string,
  namespace?: string,
): Promise<void> {
  const filePath = getSessionFilePath(dataRoot, sessionId, namespace);
  await requireRegularSessionFile(filePath, sessionId);
  await fs.unlink(filePath);
  // 计划是 Session 的附属状态；删除会话后同步清理。没有计划时 deleteTaskPlan 返回 false。
  if (namespace) await deleteTaskPlan(dataRoot, sessionId, namespace);
}

// 早期版本把 Anthropic 会话直接写在 data/sessions/*.jsonl。
// 新版本启动时将这些合法会话移动到 data/sessions/anthropic/，使两个 Provider 的目录结构一致。
export async function migrateLegacyAnthropicSessions(dataRoot: string): Promise<number> {
  const sessionsRoot = path.join(dataRoot, "sessions");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return 0;
    throw error;
  }

  const legacyFiles = entries.filter(
    (entry) => entry.isFile() && /^[A-Za-z0-9_-]+\.jsonl$/.test(entry.name),
  );
  if (legacyFiles.length === 0) return 0;

  const targetDirectory = path.join(sessionsRoot, "anthropic");
  await fs.mkdir(targetDirectory, { recursive: true });
  let migrated = 0;
  for (const entry of legacyFiles) {
    const source = path.join(sessionsRoot, entry.name);
    const target = path.join(targetDirectory, entry.name);
    try {
      // link 会以排他方式原子创建目标且不复制内容，同名新会话绝不被旧数据覆盖。
      // 链接成功后再删除旧路径；进程在两步之间退出只会留下两个完整的硬链接。
      await fs.link(source, target);
      await fs.unlink(source);
      migrated += 1;
    } catch (error) {
      if (isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOENT")) {
        continue;
      }
      throw error;
    }
  }
  return migrated;
}

// Node 的 fs 错误会携带 code 字段。
// 这里用窄化函数避免在 catch 的 unknown 上直接访问 error.code。
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error("session id may only contain letters, numbers, underscores, and hyphens");
  }
}

function validateSessionNamespace(namespace?: string): void {
  if (namespace !== undefined && !/^[A-Za-z0-9_-]+$/.test(namespace)) {
    throw new Error("session namespace may only contain letters, numbers, underscores, and hyphens");
  }
}

function getSessionDirectory(dataRoot: string, namespace?: string): string {
  validateSessionNamespace(namespace);
  return namespace
    ? path.join(dataRoot, "sessions", namespace)
    : path.join(dataRoot, "sessions");
}

function getSessionFilePath(dataRoot: string, sessionId: string, namespace?: string): string {
  validateSessionId(sessionId);
  return path.join(getSessionDirectory(dataRoot, namespace), `${sessionId}.jsonl`);
}

async function requireRegularSessionFile(filePath: string, sessionId: string): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`session is not a regular file: ${sessionId}`);
    // access 明确检查当前进程能否读写，避免 rename/delete 到一半才发现权限问题。
    await fs.access(filePath, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`session not found: ${sessionId}`);
    }
    throw error;
  }
}
