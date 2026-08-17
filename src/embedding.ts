export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_MEMORY_VECTOR_WEIGHT = 0.5;

// 这些限制属于客户端保护策略，不是 OpenAI API 的理论上限。记忆文件可能一次产生
// 很多分块，主动控制批大小和等待时间可以避免单个搜索长期占用 CLI/Web 请求。
const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000;
const MAX_EMBEDDING_TIMEOUT_MS = 120_000;
const MAX_EMBEDDING_BATCH_SIZE = 64;

export interface EmbeddingClient {
  // memory-index 只面向这个最小接口编程，因此测试可以传入本地假向量生成器，未来也
  // 可以接入其他兼容的 Embedding 服务，而不需要修改索引和融合逻辑。
  // cacheKey 必须随会改变向量空间的配置变化。模型或 dimensions 改变后，旧向量
  // 仍可留在 SQLite 中，但不会与新查询向量混用。
  readonly cacheKey: string;
  embed(inputs: readonly string[]): Promise<number[][]>;
}

export interface OpenAIEmbeddingClientOptions {
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * OpenAI Embeddings API 的最小 HTTP 客户端。
 *
 * 项目没有引入完整 OpenAI SDK，因此这里沿用 Provider 的低层 fetch 风格。客户端只
 * 暴露“字符串数组 -> float 向量数组”，HTTP 鉴权、批处理和响应边界都封装在内部。
 */
export class OpenAIEmbeddingHTTPClient implements EmbeddingClient {
  readonly cacheKey: string;
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly organization?: string;
  private readonly project?: string;
  private readonly model: string;
  private readonly dimensions?: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIEmbeddingClientOptions = {}) {
    // 显式 options 优先于环境变量，方便单元测试注入配置；生产环境则与现有
    // OpenAI Provider 共用 Key、Base URL、Organization 和 Project 配置。
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.baseURL = (options.baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1")
      .replace(/\/+$/, "");
    this.organization = options.organization ?? process.env.OPENAI_ORG_ID;
    this.project = options.project ?? process.env.OPENAI_PROJECT_ID;
    this.model = validateModel(options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL);
    this.dimensions = validateDimensions(options.dimensions);
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS);
    this.fetchImpl = options.fetch ?? fetch;
    // cacheKey 表示一个确定的“向量空间”。相同文本由不同模型或 dimensions 生成的
    // 向量不可直接比较，所以必须落到不同的 SQLite 缓存记录中。
    this.cacheKey = this.dimensions === undefined
      ? this.model
      : `${this.model}:dimensions=${this.dimensions}`;
  }

  async embed(inputs: readonly string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for memory vector search");
    for (const input of inputs) {
      if (typeof input !== "string" || input.length === 0) {
        throw new Error("embedding input must be a non-empty string");
      }
    }

    const embeddings: number[][] = [];
    // 批量请求显著减少重建索引时的 HTTP 往返；单批保持较小，避免大量记忆一次性
    // 形成过大的 JSON 请求。API 返回 index，因此每批内部仍按原输入顺序重排。
    for (let offset = 0; offset < inputs.length; offset += MAX_EMBEDDING_BATCH_SIZE) {
      const batch = inputs.slice(offset, offset + MAX_EMBEDDING_BATCH_SIZE);
      embeddings.push(...await this.requestBatch(batch));
    }
    return embeddings;
  }

  private async requestBatch(inputs: readonly string[]): Promise<number[][]> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    if (this.project) headers["OpenAI-Project"] = this.project;

    const body: Record<string, unknown> = {
      model: this.model,
      input: inputs,
      encoding_format: "float",
    };
    if (this.dimensions !== undefined) body.dimensions = this.dimensions;

    let response: Response;
    try {
      // AbortSignal.timeout 让底层连接、TLS、响应读取共享同一超时边界。超时异常会在
      // memory-index 的混合搜索层被捕获，搜索随后安全降级为纯关键词结果。
      response = await this.fetchImpl(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `OpenAI embeddings connection failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    const payload = await parseJsonBody(response);
    if (!response.ok) {
      throw new Error(`OpenAI embeddings request failed (${response.status}): ${readErrorMessage(payload)}`);
    }
    return parseEmbeddingResponse(payload, inputs.length);
  }
}

export interface MemoryEmbeddingEnvironmentOptions {
  client?: EmbeddingClient;
  vectorWeight: number;
}

export function resolveMemoryEmbeddingEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): MemoryEmbeddingEnvironmentOptions {
  // 先解析开关和权重，即使没有 Key 也能尽早暴露拼写错误或越界配置，避免用户以为
  // 某项配置已经生效，实际上却被静默忽略。
  const vectorWeight = parseVectorWeight(environment.OPENCLAW_MEMORY_VECTOR_WEIGHT);
  const enabled = parseEnabled(environment.OPENCLAW_MEMORY_EMBEDDINGS);
  // weight=0 是显式的“只用关键词”；没有 Key 时也安静降级，Anthropic 用户不需要
  // 为了启动项目而额外配置 OpenAI。之后补上 Key 并重启即可启用混合检索。
  if (!enabled || vectorWeight === 0 || !environment.OPENAI_API_KEY) {
    return { vectorWeight, client: undefined };
  }

  return {
    vectorWeight,
    client: new OpenAIEmbeddingHTTPClient({
      apiKey: environment.OPENAI_API_KEY,
      baseURL: environment.OPENAI_BASE_URL,
      organization: environment.OPENAI_ORG_ID,
      project: environment.OPENAI_PROJECT_ID,
      model: environment.OPENCLAW_EMBEDDING_MODEL || DEFAULT_OPENAI_EMBEDDING_MODEL,
      dimensions: parseOptionalPositiveInteger(
        environment.OPENCLAW_EMBEDDING_DIMENSIONS,
        "OPENCLAW_EMBEDDING_DIMENSIONS",
      ),
      timeoutMs: parseOptionalPositiveInteger(
        environment.OPENCLAW_EMBEDDING_TIMEOUT_MS,
        "OPENCLAW_EMBEDDING_TIMEOUT_MS",
      ),
    }),
  };
}

function parseEmbeddingResponse(payload: unknown, expectedCount: number): number[][] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("OpenAI embeddings response is missing data");
  }
  const ordered = new Array<number[]>(expectedCount);
  // API 的 data 数组不承诺必须按输入顺序返回，真正的对应关系由 item.index 表示。
  // 因此先按 index 放回固定位置，再交给调用方按输入顺序写入 chunk_hash。
  for (const item of payload.data) {
    if (!isRecord(item) || !Number.isInteger(item.index) || !Array.isArray(item.embedding)) {
      throw new Error("OpenAI embeddings response contains an invalid item");
    }
    const index = Number(item.index);
    if (index < 0 || index >= expectedCount || ordered[index] !== undefined) {
      throw new Error("OpenAI embeddings response contains an invalid index");
    }
    const vector = item.embedding.map(Number);
    if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
      throw new Error("OpenAI embeddings response contains an invalid vector");
    }
    ordered[index] = vector;
  }
  if (ordered.some((vector) => vector === undefined)) {
    throw new Error("OpenAI embeddings response returned fewer vectors than requested");
  }
  const dimensions = ordered[0]?.length;
  // 同一批向量必须处于同一个维度空间；否则后续余弦计算无法成立，也不能写入缓存。
  if (ordered.some((vector) => vector.length !== dimensions)) {
    throw new Error("OpenAI embeddings response returned inconsistent vector dimensions");
  }
  return ordered;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`OpenAI embeddings returned invalid JSON (${response.status})`);
  }
}

function readErrorMessage(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  return "unknown error";
}

function validateModel(model: string): string {
  const normalized = model.trim();
  if (normalized.length === 0) throw new Error("embedding model must not be empty");
  if (Buffer.byteLength(normalized, "utf8") > 256) {
    throw new Error("embedding model is too long; maximum is 256 bytes");
  }
  return normalized;
}

function validateDimensions(dimensions?: number): number | undefined {
  if (dimensions === undefined) return undefined;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) {
    throw new Error("embedding dimensions must be an integer between 1 and 8192");
  }
  return dimensions;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_EMBEDDING_TIMEOUT_MS) {
    throw new Error(`embedding timeout must be an integer between 1 and ${MAX_EMBEDDING_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function parseVectorWeight(value?: string): number {
  if (value === undefined || value.length === 0) return DEFAULT_MEMORY_VECTOR_WEIGHT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error("OPENCLAW_MEMORY_VECTOR_WEIGHT must be a number between 0 and 1");
  }
  return parsed;
}

function parseEnabled(value?: string): boolean {
  if (value === undefined || value.length === 0) return true;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error("OPENCLAW_MEMORY_EMBEDDINGS must be true or false");
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
