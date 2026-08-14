import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DAILY_MEMORY_DIRECTORY,
  WORKSPACE_MEMORY_FILE,
} from "./workspace-memory.js";

// SQLite 只保存可从 Markdown 重新生成的派生索引。用户的长期记忆真相源仍然只有
// workspace/MEMORY.md 和 workspace/memory/*.md，删除这个数据库不会丢失记忆。
export const MEMORY_INDEX_RELATIVE_PATH = "memory/index.sqlite";

const MEMORY_INDEX_SCHEMA_VERSION = 1;
const MAX_INDEXED_MEMORY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_QUERY_BYTES = 1024;
const DEFAULT_MEMORY_SEARCH_RESULTS = 10;
export const MAX_MEMORY_SEARCH_RESULTS = 20;
export const DEFAULT_MEMORY_GET_LINES = 80;
export const MAX_MEMORY_GET_LINES = 200;
const MAX_CHUNK_CHARACTERS = 1_600;
const MAX_SNIPPET_CHARACTERS = 500;
const INDEX_DEBOUNCE_MS = 250;

interface MemorySource {
  relativePath: string;
  content: string;
  bytes: number;
  hash: string;
}

interface MemoryChunk {
  relativePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface MemorySearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

export interface MemorySearchResponse {
  query: string;
  results: MemorySearchResult[];
  indexedFiles: number;
  indexedChunks: number;
}

export interface MemoryGetResponse {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}

export interface MemoryIndexStats {
  indexedFiles: number;
  indexedChunks: number;
  rebuilt: boolean;
}

// tools.ts 只依赖这个窄接口，不需要知道 SQLite、分块和同步细节。
export interface MemoryToolService {
  search(query: string, maxResults?: number): Promise<MemorySearchResponse>;
  get(relativePath: string, fromLine?: number, lines?: number): Promise<MemoryGetResponse>;
  scheduleSync(): void;
}

/**
 * 管理单个 workspace 的 Markdown 记忆索引。
 *
 * DatabaseSync 的每次使用都在一个很短的同步阶段内打开并关闭连接，避免 CLI 切换
 * Session 或 Web 创建多个 Agent 时持有多份数据库句柄。文件读取和目录遍历仍然使用
 * 异步 API；真正写数据库时用事务一次性替换，搜索不会看到半份新索引。
 */
export class WorkspaceMemoryIndex implements MemoryToolService {
  private syncPromise?: Promise<MemoryIndexStats>;
  private debounceTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly workspaceRoot: string,
    private readonly indexPath: string,
  ) {}

  async sync(): Promise<MemoryIndexStats> {
    // 多个并发的 Web 请求可能同时发现文件变化。复用同一个 Promise，避免它们争抢
    // BEGIN IMMEDIATE 锁，也避免相同 Markdown 被重复读取和分块。
    if (this.syncPromise) return this.syncPromise;
    const pending = this.performSync();
    this.syncPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.syncPromise === pending) this.syncPromise = undefined;
    }
  }

  scheduleSync(): void {
    // 一次模型操作可能连续创建目录、写文件和精确编辑。防抖把这些动作合并为一次索引
    // 检查；unref 使等待中的计时器不会阻止 CLI 正常退出。
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      // 后台同步失败不制造未处理 Promise。下一次 memory_search 会再次同步并把错误
      // 正常回填给模型，所以不会静默使用一个明知过期的结果。
      void this.sync().catch(() => undefined);
    }, INDEX_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  async search(query: string, maxResults = DEFAULT_MEMORY_SEARCH_RESULTS): Promise<MemorySearchResponse> {
    const normalizedQuery = validateMemorySearchQuery(query);
    validateResultLimit(maxResults);

    // 每次查找前同步一次，使用户在编辑器里直接修改 Markdown 后无需重启进程。
    const stats = await this.sync();
    if (stats.indexedChunks === 0) {
      return {
        query: normalizedQuery,
        results: [],
        indexedFiles: stats.indexedFiles,
        indexedChunks: stats.indexedChunks,
      };
    }

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(this.indexPath, { readOnly: true });
    try {
      const terms = normalizedQuery.split(/\s+/u);
      const canUseTrigram = terms.every((term) => [...term].length >= 3);
      const rows = canUseTrigram
        ? database.prepare(`
            SELECT relative_path, start_line, end_line, content, bm25(memory_chunks) AS rank
            FROM memory_chunks
            WHERE memory_chunks MATCH ?
            ORDER BY rank, relative_path, start_line
            LIMIT ?
          `).all(toFtsQuery(terms), maxResults)
        : database.prepare(`
            SELECT relative_path, start_line, end_line, content, 0.0 AS rank
            FROM memory_chunks
            WHERE ${terms.map(() => "instr(lower(content), lower(?)) > 0").join(" AND ")}
            ORDER BY relative_path, start_line
            LIMIT ?
          `).all(...terms, maxResults);

      return {
        query: normalizedQuery,
        results: rows.map((row) => {
          const record = row as Record<string, unknown>;
          const content = String(record.content);
          const rank = Number(record.rank);
          return {
            path: String(record.relative_path),
            startLine: Number(record.start_line),
            endLine: Number(record.end_line),
            // FTS5 bm25 的相关度越高，返回值越负。对外转成“越大越相关”的正数；
            // 短查询使用字面量回退，没有可靠 BM25，因此分数为 0。
            score: rank < 0 ? Number((-rank).toFixed(6)) : 0,
            snippet: createSnippet(content, terms),
          };
        }),
        indexedFiles: stats.indexedFiles,
        indexedChunks: stats.indexedChunks,
      };
    } finally {
      database.close();
    }
  }

  async get(
    relativePath: string,
    fromLine = 1,
    lines = DEFAULT_MEMORY_GET_LINES,
  ): Promise<MemoryGetResponse> {
    validateLineRange(fromLine, lines);
    const source = await readRequestedMemorySource(this.workspaceRoot, relativePath);
    const allLines = splitLines(source.content);
    // 空文件仍被视为一行空文本；超出末尾返回空 content，但保留可核对的总行数。
    const startIndex = Math.min(fromLine - 1, allLines.length);
    const selected = allLines.slice(startIndex, startIndex + lines);
    return {
      path: source.relativePath,
      startLine: selected.length > 0 ? startIndex + 1 : fromLine,
      endLine: selected.length > 0 ? startIndex + selected.length : fromLine - 1,
      totalLines: allLines.length,
      content: selected.join("\n"),
    };
  }

  private async performSync(): Promise<MemoryIndexStats> {
    const sources = await discoverMemorySources(this.workspaceRoot);
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(this.indexPath);
    try {
      initializeSchema(database);
      const currentFiles = database.prepare(
        "SELECT relative_path, hash FROM memory_files ORDER BY relative_path",
      ).all() as Array<Record<string, unknown>>;
      const unchanged = currentFiles.length === sources.length && sources.every((source, index) => (
        currentFiles[index]?.relative_path === source.relativePath
        && currentFiles[index]?.hash === source.hash
      ));

      if (unchanged) {
        return {
          indexedFiles: sources.length,
          indexedChunks: readCount(database, "memory_chunks"),
          rebuilt: false,
        };
      }

      const chunks = sources.flatMap(chunkMemorySource);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("DELETE FROM memory_chunks; DELETE FROM memory_files;");
        const insertFile = database.prepare(
          "INSERT INTO memory_files(relative_path, hash, bytes) VALUES (?, ?, ?)",
        );
        const insertChunk = database.prepare(`
          INSERT INTO memory_chunks(relative_path, start_line, end_line, content)
          VALUES (?, ?, ?, ?)
        `);
        for (const source of sources) {
          insertFile.run(source.relativePath, source.hash, source.bytes);
        }
        for (const chunk of chunks) {
          insertChunk.run(chunk.relativePath, chunk.startLine, chunk.endLine, chunk.content);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return { indexedFiles: sources.length, indexedChunks: chunks.length, rebuilt: true };
    } finally {
      database.close();
    }
  }
}

type SQLiteDatabase = import("node:sqlite").DatabaseSync;

function initializeSchema(database: SQLiteDatabase): void {
  const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (version !== 0 && version !== MEMORY_INDEX_SCHEMA_VERSION) {
    // 数据库是派生缓存，schema 升级时直接重建比维护迁移链更安全、也更容易验证。
    database.exec("DROP TABLE IF EXISTS memory_chunks; DROP TABLE IF EXISTS memory_files;");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      relative_path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      bytes INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks USING fts5(
      relative_path UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED,
      content,
      tokenize='trigram'
    );
    PRAGMA user_version = ${MEMORY_INDEX_SCHEMA_VERSION};
  `);
}

async function discoverMemorySources(workspaceRoot: string): Promise<MemorySource[]> {
  const sources: MemorySource[] = [];
  const longTermPath = path.join(workspaceRoot, WORKSPACE_MEMORY_FILE);
  const longTerm = await readOptionalMemoryFile(longTermPath, WORKSPACE_MEMORY_FILE);
  if (longTerm) sources.push(longTerm);

  const dailyDirectoryPath = path.join(workspaceRoot, DAILY_MEMORY_DIRECTORY);
  let directoryStat: import("node:fs").Stats;
  try {
    directoryStat = await fs.lstat(dailyDirectoryPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return sources;
    throw error;
  }
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`${DAILY_MEMORY_DIRECTORY} must not be a symbolic link`);
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`${DAILY_MEMORY_DIRECTORY} must be a directory`);
  }

  // 检索层索引全部每日 Markdown，不受“提示词只注入今天和昨天”的限制。
  // 目前只接受 memory/ 直属 .md 文件，与 OpenClaw 的 YYYY-MM-DD.md 约定保持明确。
  const entries = await fs.readdir(dailyDirectoryPath, { withFileTypes: true });
  const markdownNames = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of markdownNames) {
    const relativePath = `${DAILY_MEMORY_DIRECTORY}/${name}`;
    const source = await readOptionalMemoryFile(path.join(dailyDirectoryPath, name), relativePath);
    if (source) sources.push(source);
  }
  return sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function readOptionalMemoryFile(
  filePath: string,
  relativePath: string,
): Promise<MemorySource | undefined> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${relativePath} must not be a symbolic link`);
  if (!stat.isFile()) throw new Error(`${relativePath} must be a regular file`);
  if (stat.size > MAX_INDEXED_MEMORY_FILE_BYTES) {
    throw new Error(`${relativePath} is too large; maximum is ${MAX_INDEXED_MEMORY_FILE_BYTES} bytes`);
  }

  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) throw new Error(`${relativePath} must be a UTF-8 text file`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${relativePath} must contain valid UTF-8 text`);
  }
  return {
    relativePath,
    content,
    bytes: buffer.length,
    hash: createHash("sha256").update(buffer).digest("hex"),
  };
}

async function readRequestedMemorySource(
  workspaceRoot: string,
  requestedPath: string,
): Promise<MemorySource> {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new Error("memory_get path must be a non-empty string");
  }
  if (Buffer.byteLength(requestedPath, "utf8") > 4096) {
    throw new Error("memory_get path is too long; maximum is 4096 bytes");
  }
  const normalized = requestedPath.replaceAll("\\", "/");
  // memory_get 的能力面故意只包含两个记忆层，不退化成第二个任意文件读取工具。
  if (
    normalized !== WORKSPACE_MEMORY_FILE
    && !new RegExp(`^${DAILY_MEMORY_DIRECTORY}/[^/]+\\.md$`, "i").test(normalized)
  ) {
    throw new Error("memory_get path must be MEMORY.md or a direct memory/*.md file");
  }
  if (normalized.includes("/../") || normalized.includes("/./") || normalized.includes("\0")) {
    throw new Error("memory_get path contains an invalid path segment");
  }
  const source = await readOptionalMemoryFile(
    path.join(workspaceRoot, ...normalized.split("/")),
    normalized,
  );
  if (!source) throw new Error(`memory file does not exist: ${normalized}`);
  return source;
}

function chunkMemorySource(source: MemorySource): MemoryChunk[] {
  const lines = splitLines(source.content);
  const chunks: MemoryChunk[] = [];
  let startLine = 1;
  let selected: string[] = [];
  let characters = 0;

  const flush = (): void => {
    if (selected.length === 0) return;
    chunks.push({
      relativePath: source.relativePath,
      startLine,
      endLine: startLine + selected.length - 1,
      content: selected.join("\n"),
    });
    selected = [];
    characters = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    // 标题开启新块，搜索结果因此更容易保持在同一个 Markdown 语义小节内。
    if (/^#{1,6}\s/u.test(line) && selected.length > 0) flush();
    if (selected.length === 0) startLine = index + 1;

    if (line.length > MAX_CHUNK_CHARACTERS) {
      flush();
      for (let offset = 0; offset < line.length; offset += MAX_CHUNK_CHARACTERS) {
        chunks.push({
          relativePath: source.relativePath,
          startLine: index + 1,
          endLine: index + 1,
          content: line.slice(offset, offset + MAX_CHUNK_CHARACTERS),
        });
      }
      continue;
    }

    const addedCharacters = line.length + (selected.length > 0 ? 1 : 0);
    if (selected.length > 0 && characters + addedCharacters > MAX_CHUNK_CHARACTERS) {
      flush();
      startLine = index + 1;
    }
    selected.push(line);
    characters += line.length + (selected.length > 1 ? 1 : 0);
  }
  flush();
  return chunks;
}

function splitLines(content: string): string[] {
  // 去掉结尾换行产生的额外空元素，使 line 统计与常见编辑器一致；空文件仍算一行。
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function validateMemorySearchQuery(query: string): string {
  if (typeof query !== "string") throw new Error("memory_search requires a string query");
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) throw new Error("memory_search query must not be empty");
  if (!/[\p{L}\p{N}]/u.test(normalized)) {
    throw new Error("memory_search query must contain a letter or number");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_MEMORY_QUERY_BYTES) {
    throw new Error(`memory_search query is too long; maximum is ${MAX_MEMORY_QUERY_BYTES} bytes`);
  }
  return normalized;
}

function validateResultLimit(maxResults: number): void {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_MEMORY_SEARCH_RESULTS) {
    throw new Error(`memory_search max_results must be an integer between 1 and ${MAX_MEMORY_SEARCH_RESULTS}`);
  }
}

function validateLineRange(fromLine: number, lines: number): void {
  if (!Number.isInteger(fromLine) || fromLine < 1) {
    throw new Error("memory_get from_line must be a positive integer");
  }
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_MEMORY_GET_LINES) {
    throw new Error(`memory_get lines must be an integer between 1 and ${MAX_MEMORY_GET_LINES}`);
  }
}

function toFtsQuery(terms: string[]): string {
  // 用户输入永远不直接作为 MATCH 语法执行。每个词都转义成 FTS5 字符串并用 AND
  // 连接，既保留多词检索语义，也阻止引号、NEAR、列过滤等查询语法注入。
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function createSnippet(content: string, terms: string[]): string {
  if (content.length <= MAX_SNIPPET_CHARACTERS) return content;
  const lowerContent = content.toLocaleLowerCase();
  let matchIndex = -1;
  for (const term of terms) {
    const found = lowerContent.indexOf(term.toLocaleLowerCase());
    if (found !== -1 && (matchIndex === -1 || found < matchIndex)) matchIndex = found;
  }
  const center = matchIndex === -1 ? 0 : matchIndex;
  const start = Math.max(0, center - Math.floor(MAX_SNIPPET_CHARACTERS / 3));
  const end = Math.min(content.length, start + MAX_SNIPPET_CHARACTERS);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function readCount(database: SQLiteDatabase, table: "memory_chunks"): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
