import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { EmbeddingClient } from "./embedding.js";
import {
  DAILY_MEMORY_DIRECTORY,
  WORKSPACE_MEMORY_FILE,
} from "./workspace-memory.js";

// SQLite 只保存可从 Markdown 重新生成的派生索引。用户的长期记忆真相源仍然只有
// workspace/MEMORY.md 和 workspace/memory/*.md，删除这个数据库不会丢失记忆。
export const MEMORY_INDEX_RELATIVE_PATH = "memory/index.sqlite";

const MEMORY_INDEX_SCHEMA_VERSION = 2;
const MAX_INDEXED_MEMORY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_QUERY_BYTES = 1024;
const DEFAULT_MEMORY_SEARCH_RESULTS = 10;
export const MAX_MEMORY_SEARCH_RESULTS = 20;
export const DEFAULT_MEMORY_GET_LINES = 80;
export const MAX_MEMORY_GET_LINES = 200;
const MAX_CHUNK_CHARACTERS = 1_600;
const MAX_SNIPPET_CHARACTERS = 500;
const INDEX_DEBOUNCE_MS = 250;
// 最终只返回 maxResults 条，但融合前需要给关键词和向量两条检索路径保留更大的候选
// 集合，否则某一侧过早截断后，真正的混合高分结果可能没有机会参与排序。
const SEARCH_CANDIDATE_MULTIPLIER = 4;
// 低于该值的向量结果通常语义关系很弱。关键词命中的分块不受此阈值影响，仍然会
// 进入融合候选，因此阈值不会吞掉确定的字面量命中。
const MIN_VECTOR_SIMILARITY = 0.2;

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
  hash: string;
}

interface SearchCandidate extends MemoryChunk {
  // keywordScore 是供混合排序使用的倒数名次分数；keywordDisplayScore 则保留旧版
  // memory_search 对外展示的 BM25 分数。二者分开可避免新增向量功能破坏工具协议。
  keywordScore: number;
  keywordDisplayScore: number;
  // vectorScore 是查询与分块向量的余弦相似度；纯关键词候选初始化为 0。
  vectorScore: number;
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
  searchMode: "keyword" | "hybrid";
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

export interface WorkspaceMemoryIndexOptions {
  embeddingClient?: EmbeddingClient;
  vectorWeight?: number;
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
  // 文档向量补齐可能包含远程请求。并发搜索共用同一个 Promise，避免相同分块被
  // 重复发送给 Embeddings API，也避免多个写事务竞争 SQLite 锁。
  private embeddingSyncPromise?: Promise<void>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly embeddingClient?: EmbeddingClient;
  private readonly vectorWeight: number;
  // Map 同时承担缓存和值的最近使用顺序；命中时删除再插入，最前面的键就是 LRU。
  private readonly queryEmbeddingCache = new Map<string, number[]>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly indexPath: string,
    options: WorkspaceMemoryIndexOptions = {},
  ) {
    const vectorWeight = options.vectorWeight ?? 0.5;
    if (!Number.isFinite(vectorWeight) || vectorWeight < 0 || vectorWeight > 1) {
      throw new Error("memory vector weight must be a number between 0 and 1");
    }
    this.embeddingClient = options.embeddingClient;
    this.vectorWeight = vectorWeight;
  }

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
        searchMode: "keyword",
      };
    }

    const terms = normalizedQuery.split(/\s+/u);
    // 两路检索都先扩大候选集合，最后统一融合和截断。即使 maxResults 很小，也至少
    // 保留 20 条候选，给语义召回纠正关键词排序留下空间。
    const candidateLimit = Math.max(maxResults * SEARCH_CANDIDATE_MULTIPLIER, 20);
    const keywordCandidates = await this.searchKeywords(terms, candidateLimit);

    // Embedding 未配置、权重为 0，或远端请求/响应校验失败时，完整保留原 BM25 行为。
    // 向量检索是增强层，不能让网络问题破坏本地 Markdown 关键词搜索。
    if (!this.embeddingClient || this.vectorWeight === 0) {
      return this.keywordResponse(normalizedQuery, terms, keywordCandidates, stats, maxResults);
    }
    try {
      // 顺序很重要：先补齐文档向量，再生成查询向量并计算相似度。只有三步全部成功
      // 才标记为 hybrid；任一步失败都会复用上面已得到的本地关键词候选。
      await this.ensureDocumentEmbeddings();
      const queryVector = await this.getQueryEmbedding(normalizedQuery);
      const vectorCandidates = await this.searchVectors(queryVector, candidateLimit);
      return {
        query: normalizedQuery,
        results: fuseCandidates(
          keywordCandidates,
          vectorCandidates,
          terms,
          this.vectorWeight,
          maxResults,
        ),
        indexedFiles: stats.indexedFiles,
        indexedChunks: stats.indexedChunks,
        searchMode: "hybrid",
      };
    } catch {
      // Embedding 是可选增强能力。这里故意不把远端故障升级为 memory_search 失败，
      // 以便离线、限流或第三方兼容接口异常时，Agent 仍能检索本地 Markdown。
      return this.keywordResponse(normalizedQuery, terms, keywordCandidates, stats, maxResults);
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
          INSERT INTO memory_chunks(relative_path, start_line, end_line, content, chunk_hash)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const source of sources) {
          insertFile.run(source.relativePath, source.hash, source.bytes);
        }
        for (const chunk of chunks) {
          insertChunk.run(
            chunk.relativePath,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            chunk.hash,
          );
        }
        // 只清理当前 Markdown 已不再引用的内容向量。未变化的 chunk_hash 即使因为
        // FTS 全量重建而换了 rowid，仍能直接复用，不会重复调用 Embeddings API。
        database.exec(`
          DELETE FROM memory_embeddings
          WHERE chunk_hash NOT IN (SELECT DISTINCT chunk_hash FROM memory_chunks)
        `);
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

  private async searchKeywords(terms: string[], limit: number): Promise<SearchCandidate[]> {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(this.indexPath, { readOnly: true });
    try {
      // trigram tokenizer 无法为少于 3 个 Unicode 字符的词构造三元组。只要任意词
      // 太短，整条查询就退回 instr，并继续用 AND 语义要求每个词都出现在同一分块。
      // [...term] 按 Unicode code point 计数，比 JS 的 UTF-16 length 更符合用户字符。
      const canUseTrigram = terms.every((term) => [...term].length >= 3);
      const rows = canUseTrigram
        ? database.prepare(`
            SELECT relative_path, start_line, end_line, content, chunk_hash,
                   bm25(memory_chunks) AS rank
            FROM memory_chunks
            WHERE memory_chunks MATCH ?
            ORDER BY rank, relative_path, start_line
            LIMIT ?
          `).all(toFtsQuery(terms), limit)
        : database.prepare(`
            SELECT relative_path, start_line, end_line, content, chunk_hash, 0.0 AS rank
            FROM memory_chunks
            WHERE ${terms.map(() => "instr(lower(content), lower(?)) > 0").join(" AND ")}
            ORDER BY relative_path, start_line
            LIMIT ?
          `).all(...terms, limit);
      return rows.map((row, index) => rowToCandidate(row, {
        // 混合阶段使用倒数名次归一化，避免极小的原始 BM25 数值与 0~1 余弦值直接
        // 相加。第一名为 1、第二名为 0.5、第三名约为 0.333。
        keywordScore: 1 / (index + 1),
        keywordDisplayScore: (() => {
          const rank = Number((row as Record<string, unknown>).rank);
          return rank < 0 ? Number((-rank).toFixed(6)) : 0;
        })(),
        vectorScore: 0,
      }));
    } finally {
      database.close();
    }
  }

  private keywordResponse(
    query: string,
    terms: string[],
    candidates: SearchCandidate[],
    stats: MemoryIndexStats,
    maxResults: number,
  ): MemorySearchResponse {
    return {
      query,
      results: candidates.slice(0, maxResults).map((candidate) => ({
        path: candidate.relativePath,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        // 对外沿用旧版 BM25 分数；短词字面量搜索仍为 0，避免开启/关闭向量配置时
        // 无故改变已有工具协议。名次归一化分数只在内部混合阶段使用。
        score: candidate.keywordDisplayScore,
        snippet: createSnippet(candidate.content, terms),
      })),
      indexedFiles: stats.indexedFiles,
      indexedChunks: stats.indexedChunks,
      searchMode: "keyword",
    };
  }

  private async ensureDocumentEmbeddings(): Promise<void> {
    // 与 syncPromise 相同的 single-flight 模式：已经有搜索在补向量时，后来的搜索
    // 只等待同一个任务，不再重复查缺失记录和发网络请求。
    if (this.embeddingSyncPromise) return this.embeddingSyncPromise;
    const pending = this.performEmbeddingSync();
    this.embeddingSyncPromise = pending;
    try {
      await pending;
    } finally {
      if (this.embeddingSyncPromise === pending) this.embeddingSyncPromise = undefined;
    }
  }

  private async performEmbeddingSync(): Promise<void> {
    const client = this.embeddingClient;
    if (!client) return;
    const { DatabaseSync } = await import("node:sqlite");
    let database = new DatabaseSync(this.indexPath);
    let missing: Array<{ hash: string; content: string }>;
    try {
      // chunk_hash 只由内容决定，model_key 表示模型和可选 dimensions。两者共同决定
      // 是否可以安全复用向量。DISTINCT 还能让内容完全相同的多个分块只向量化一次。
      missing = database.prepare(`
        SELECT DISTINCT c.chunk_hash, c.content
        FROM memory_chunks AS c
        LEFT JOIN memory_embeddings AS e
          ON e.chunk_hash = c.chunk_hash AND e.model_key = ?
        WHERE e.chunk_hash IS NULL AND trim(c.content) <> ''
        ORDER BY c.chunk_hash
      `).all(client.cacheKey).map((row) => {
        const record = row as Record<string, unknown>;
        return { hash: String(record.chunk_hash), content: String(record.content) };
      });
    } finally {
      database.close();
    }
    if (missing.length === 0) return;

    // 网络请求期间不持有 SQLite 连接或事务，避免慢 API 阻塞本地关键词搜索。
    const vectors = await client.embed(missing.map((item) => item.content));
    if (vectors.length !== missing.length) {
      throw new Error("embedding client returned an unexpected vector count");
    }

    const validatedVectors = vectors.map(validateVector);
    const dimensions = validatedVectors[0]?.length;
    // 一批文档向量必须拥有完全相同的维度，否则即使分别合法，也无法与同一个查询
    // 向量做余弦比较。异常直接触发上层 BM25 降级，避免写入半有效缓存。
    if (validatedVectors.some((vector) => vector.length !== dimensions)) {
      throw new Error("embedding client returned inconsistent vector dimensions");
    }

    database = new DatabaseSync(this.indexPath);
    try {
      // 远程结果全部验证通过后才开启短事务一次写入，保证不会留下部分成功、部分缺失
      // 的批次。INSERT OR REPLACE 也让并发或重试写入保持幂等。
      database.exec("BEGIN IMMEDIATE");
      const insert = database.prepare(`
        INSERT OR REPLACE INTO memory_embeddings(chunk_hash, model_key, dimensions, vector)
        VALUES (?, ?, ?, ?)
      `);
      for (let index = 0; index < missing.length; index += 1) {
        const vector = validatedVectors[index] as number[];
        insert.run(
          missing[index]?.hash,
          client.cacheKey,
          vector.length,
          encodeVector(vector),
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  private async getQueryEmbedding(query: string): Promise<number[]> {
    const client = this.embeddingClient;
    if (!client) throw new Error("embedding client is not configured");
    // 查询文本前拼上向量空间 cacheKey；更换模型或 dimensions 后，即使问题相同也
    // 必须重新生成。NUL 作为分隔符避免普通文本拼接产生键碰撞。
    const cacheKey = `${client.cacheKey}\0${query}`;
    const cached = this.queryEmbeddingCache.get(cacheKey);
    if (cached) {
      // 命中时刷新插入顺序，Map 的第一个键始终是最久未使用的查询。
      this.queryEmbeddingCache.delete(cacheKey);
      this.queryEmbeddingCache.set(cacheKey, cached);
      return cached;
    }
    const vectors = await client.embed([query]);
    if (vectors.length !== 1) throw new Error("embedding client returned an unexpected query vector count");
    const [vector] = vectors;
    const validated = validateVector(vector);
    // 小型 LRU 上限足以覆盖连续追问，同时避免长时间 Web 进程无限增长。
    this.queryEmbeddingCache.set(cacheKey, validated);
    if (this.queryEmbeddingCache.size > 100) {
      const oldest = this.queryEmbeddingCache.keys().next().value as string | undefined;
      if (oldest !== undefined) this.queryEmbeddingCache.delete(oldest);
    }
    return validated;
  }

  private async searchVectors(queryVector: number[], limit: number): Promise<SearchCandidate[]> {
    const client = this.embeddingClient;
    if (!client) return [];
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(this.indexPath, { readOnly: true });
    try {
      // 当前记忆规模较小，因此直接加载当前 model_key 下的全部分块向量，在 Node.js
      // 中线性计算余弦相似度。以后数据量显著增长时，这里可替换为向量扩展/ANN 索引，
      // 而上层缓存、融合和降级协议无需改变。
      const rows = database.prepare(`
        SELECT c.relative_path, c.start_line, c.end_line, c.content, c.chunk_hash,
               e.dimensions, e.vector
        FROM memory_chunks AS c
        JOIN memory_embeddings AS e
          ON e.chunk_hash = c.chunk_hash AND e.model_key = ?
      `).all(client.cacheKey);
      return rows.map((row) => {
        const record = row as Record<string, unknown>;
        const vector = decodeVector(record.vector, Number(record.dimensions));
        return rowToCandidate(row, {
          keywordScore: 0,
          keywordDisplayScore: 0,
          vectorScore: cosineSimilarity(queryVector, vector),
        });
      }).filter((candidate) => candidate.vectorScore >= MIN_VECTOR_SIMILARITY)
        .sort((left, right) => right.vectorScore - left.vectorScore
          || left.relativePath.localeCompare(right.relativePath)
          || left.startLine - right.startLine)
        .slice(0, limit);
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
    database.exec(`
      DROP TABLE IF EXISTS memory_chunks;
      DROP TABLE IF EXISTS memory_embeddings;
      DROP TABLE IF EXISTS memory_files;
    `);
  }
  // memory_chunks 是关键词检索的 FTS5 派生表；memory_embeddings 是内容寻址的向量
  // 缓存。向量不绑定 FTS rowid，所以 FTS 全量重建后，只要 chunk_hash 没变仍可复用。
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
      chunk_hash UNINDEXED,
      tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      chunk_hash TEXT NOT NULL,
      model_key TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      PRIMARY KEY (chunk_hash, model_key)
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
      hash: hashChunk(selected.join("\n")),
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
          hash: hashChunk(line.slice(offset, offset + MAX_CHUNK_CHARACTERS)),
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

function fuseCandidates(
  keywordCandidates: SearchCandidate[],
  vectorCandidates: SearchCandidate[],
  terms: string[],
  vectorWeight: number,
  limit: number,
): MemorySearchResult[] {
  // 同一分块可能同时出现在两路候选中。路径和行号区分展示位置，hash 防止文件刚好
  // 在相同行范围内换了内容时把新旧候选错误合并。
  const merged = new Map<string, SearchCandidate>();
  for (const candidate of [...keywordCandidates, ...vectorCandidates]) {
    const key = candidateKey(candidate);
    const existing = merged.get(key);
    if (existing) {
      existing.keywordScore = Math.max(existing.keywordScore, candidate.keywordScore);
      existing.vectorScore = Math.max(existing.vectorScore, candidate.vectorScore);
    } else {
      merged.set(key, { ...candidate });
    }
  }
  // 关键词侧使用倒数名次分数，向量侧使用余弦相似度，二者大致都落在 0~1。权重
  // 为 0 时等价于纯关键词排序，为 1 时等价于纯向量排序（入口会对 0 提前降级）。
  return [...merged.values()].map((candidate) => ({
    candidate,
    score: (1 - vectorWeight) * candidate.keywordScore
      + vectorWeight * candidate.vectorScore,
  })).sort((left, right) => right.score - left.score
    || right.candidate.vectorScore - left.candidate.vectorScore
    || right.candidate.keywordScore - left.candidate.keywordScore
    || left.candidate.relativePath.localeCompare(right.candidate.relativePath)
    || left.candidate.startLine - right.candidate.startLine)
    .slice(0, limit)
    .map(({ candidate, score }) => ({
      path: candidate.relativePath,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      score: Number(score.toFixed(6)),
      snippet: createSnippet(candidate.content, terms),
    }));
}

function rowToCandidate(
  row: unknown,
  scores: Pick<SearchCandidate, "keywordScore" | "keywordDisplayScore" | "vectorScore">,
): SearchCandidate {
  const record = row as Record<string, unknown>;
  return {
    relativePath: String(record.relative_path),
    startLine: Number(record.start_line),
    endLine: Number(record.end_line),
    content: String(record.content),
    hash: String(record.chunk_hash),
    ...scores,
  };
}

function candidateKey(candidate: MemoryChunk): string {
  return `${candidate.relativePath}\0${candidate.startLine}\0${candidate.endLine}\0${candidate.hash}`;
}

function hashChunk(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateVector(vector: number[] | undefined): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("embedding client returned an invalid vector");
  }
  return vector;
}

function encodeVector(vector: number[]): Buffer {
  // Float32 将默认 1536 维向量压到约 6 KiB；检索精度足够，且 BLOB 比 JSON 数组更小。
  const buffer = Buffer.allocUnsafe(vector.length * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

function decodeVector(value: unknown, dimensions: number): number[] {
  // SQLite BLOB 在 Node 中表现为 Uint8Array。dimensions 同时用于检查字节长度，防止
  // 损坏或旧格式数据被误读；任何异常都会由 search() 回退到关键词结果。
  if (!(value instanceof Uint8Array) || !Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("memory index contains an invalid embedding vector");
  }
  const buffer = Buffer.from(value);
  if (buffer.length !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error("memory index embedding dimensions do not match its BLOB");
  }
  const vector = new Array<number>(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = buffer.readFloatLE(index * 4);
  }
  return vector;
}

function cosineSimilarity(left: number[], right: number[]): number {
  // 余弦只比较方向而不比较向量长度，适合衡量文本 Embedding 的语义接近程度。
  // 先显式校验维度，避免数组越界被 ?? 0 掩盖成看似有效的低分结果。
  if (left.length !== right.length || left.length === 0) {
    throw new Error("query and document embedding dimensions do not match");
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  // Float32 持久化可能产生极小舍入误差，最后夹紧到余弦相似度的理论范围。
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

function readCount(database: SQLiteDatabase, table: "memory_chunks"): number {
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
