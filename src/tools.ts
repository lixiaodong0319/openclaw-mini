import Anthropic from "@anthropic-ai/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { applyWorkspacePatch } from "./apply-patch.js";
import {
  DEFAULT_GIT_DIFF_BYTES,
  getGitDiff,
  getGitStatus,
  MAX_GIT_DIFF_BYTES,
} from "./git-tools.js";
import { DEFAULT_FETCH_BYTES, fetchUrlText, MAX_FETCH_BYTES } from "./fetch-url.js";
import {
  DEFAULT_MEMORY_GET_LINES,
  MAX_MEMORY_GET_LINES,
  MAX_MEMORY_SEARCH_RESULTS,
  type MemoryToolService,
} from "./memory-index.js";

// 直接复用 SDK 的 Tool 类型，确保工具定义形状和 Anthropic SDK 保持一致。
// 不额外声明自定义 Tool interface，可以避免 SDK 升级后字段含义或类型漂移。
export type ToolDefinition = Anthropic.Tool;

export interface OpenAIToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Anthropic.Tool["input_schema"];
  strict: boolean;
}

// ToolContext 是工具执行时的可信上下文，由宿主程序提供，不由模型决定。
// 目前只包含 workspaceRoot；模型只能提供相对路径，不能指定根目录。
// 如果后续加入权限确认、审计日志、用户 ID，也应该从这里传入。
export interface ToolContext {
  workspaceRoot: string;
  // 命令超时由宿主配置，不接受模型参数，避免模型自行关闭或无限延长超时。
  commandTimeoutMs?: number;
  // 记忆索引由 Runtime 创建并注入。直接单测普通文件工具时可以省略；只有两个
  // memory_* 工具会要求它存在，模型不能通过参数替换 workspace 或数据库位置。
  memoryIndex?: MemoryToolService;
}

// read_text_file 的模型输入结构。
// 只允许一个 workspace 相对路径，避免工具层出现“读取任意 URL / 任意绝对路径”的能力扩张。
interface ReadTextFileInput {
  path: string;
}

// create_directory 只接受 workspace 相对路径。
// 它可以递归创建缺失的父目录，但属于有副作用操作，必须先经过用户确认。
interface CreateDirectoryInput {
  path: string;
}

// write_text_file 只接受完整的 UTF-8 文本内容。
// 写入是有副作用的操作，因此它不在自动放行列表中。
interface WriteTextFileInput {
  path: string;
  content: string;
}

// edit_text_file 使用“唯一原文 -> 新文”做精确替换。
// 比起覆盖整个文件，它更适合小范围修改，也能防止模型用过时上下文误改文件。
interface EditTextFileInput {
  path: string;
  oldText: string;
  newText: string;
}

// apply_patch 接受统一补丁文本，可在一次确认后新增或更新多个文件。
interface ApplyPatchInput {
  patch: string;
}

// list_directory 的模型输入结构。
// 和 read_text_file 一样只接受 workspace 相对路径；使用 "." 表示 workspace 根目录。
interface ListDirectoryInput {
  path: string;
}

// find_files 只查找路径，不读取文件内容。
// pattern 按 workspace 相对路径匹配，例如 **/*.test.ts。
interface FindFilesInput {
  path: string;
  pattern: string;
  maxResults: number;
}

// search_files 在指定目录下递归搜索文本内容。
// query 按字面量匹配，不作为正则表达式执行；filePattern 只用于过滤文件路径。
interface SearchFilesInput {
  query: string;
  path: string;
  filePattern?: string;
  maxResults: number;
}

interface MemorySearchInput {
  query: string;
  maxResults: number;
}

interface MemoryGetInput {
  path: string;
  fromLine: number;
  lines: number;
}

interface GitStatusInput {
  path: string;
}

interface GitDiffInput {
  path: string;
  file?: string;
  staged: boolean;
  maxBytes: number;
}

interface FetchUrlInput {
  // maxBytes 由宿主限制范围，模型不能借参数无限扩大响应正文。
  url: string;
  maxBytes: number;
}

// calculator 的模型输入结构。
// operation 使用联合类型限定四则运算，避免接收表达式字符串后被迫 eval。
interface CalculatorInput {
  operation: "add" | "subtract" | "multiply" | "divide";
  a: number;
  b: number;
}

// run_command 故意只接收命令文本。cwd、超时和环境变量都由可信宿主决定。
interface RunCommandInput {
  command: string;
}

// 单次读取 1 MiB 是刻意的 MVP 限制。
// 它既能防止误读大文件撑爆上下文，也让工具错误更容易解释和测试。
const MAX_FILE_BYTES = 1024 * 1024;

// 限制单次目录列表的规模，防止大型目录一次性占满模型上下文。
const MAX_DIRECTORY_ENTRIES = 200;

// 文件发现只返回路径，允许比内容搜索更多结果，但仍需限制遍历和返回规模。
const DEFAULT_FIND_RESULTS = 100;
const MAX_FIND_RESULTS = 500;
const MAX_FIND_SCANNED_ENTRIES = 20_000;

// 搜索结果和扫描规模都设置上限，避免大型 workspace 长时间占用 Agent Loop，
// 也避免匹配内容一次性撑满模型上下文。
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCHED_FILES = 10_000;
const MAX_SEARCH_LINE_CHARACTERS = 500;

// Shell 命令默认最长运行 30 秒，宿主可调整，但不允许超过 2 分钟。
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

// stdout/stderr 分别最多回填 64 KiB，超出部分会继续从 pipe 排空但不保存到内存。
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

// 子进程继承 PATH 等必要环境，但不继承常见凭据类变量。
// 这不是 Shell 沙箱，而是防止 `env` 等普通命令直接暴露 API Key 的额外防线。
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|AUTHORIZATION|COOKIE|SESSION|JWT)(?:_|$)/i;

// 当前九个工具都是只读或纯计算能力，可以直接执行。
// 未登记的新工具默认需要用户确认，避免未来加入写文件、Shell 等能力时意外绕过审批。
const AUTO_APPROVED_TOOLS = new Set([
  "calculator",
  "list_directory",
  "find_files",
  "search_files",
  "read_text_file",
  "memory_search",
  "memory_get",
  "git_status",
  "git_diff",
]);

export function requiresToolConfirmation(name: string): boolean {
  return !AUTO_APPROVED_TOOLS.has(name);
}

// 这是传给 Claude 的工具清单，也是模型“看得见”的全部外部能力。
// 工具描述不仅说明工具做什么，也说明什么时候应该调用，帮助模型减少误用。
// strict: true 要求模型按 JSON Schema 生成参数；工具实现层仍会二次校验，因为模型输出不能被视作可信输入。
export const toolDefinitions: ToolDefinition[] = [
  {
    name: "calculator",
    description: "Call this when arithmetic is needed. Performs one basic operation on two finite numbers without evaluating expressions.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["add", "subtract", "multiply", "divide"],
          description: "The arithmetic operation to perform.",
        },
        a: { type: "number", description: "The left operand." },
        b: { type: "number", description: "The right operand." },
      },
      required: ["operation", "a", "b"],
      additionalProperties: false,
    },
  },
  {
    name: "list_directory",
    description: "Call this to discover files and directories inside the workspace before reading them. Lists one directory level only. Use '.' for the workspace root.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to a directory. Use '.' for the workspace root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "find_files",
    description: "Call this to recursively discover regular files by workspace-relative path. Supports simple glob wildcards (*, **, and ?), skips symbolic links, and does not read file contents.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory to search recursively. Use '.' for the workspace root.",
        },
        pattern: {
          type: "string",
          description: "Glob matched against workspace-relative file paths, for example '**/*.test.ts'.",
        },
        max_results: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_FIND_RESULTS },
            { type: "null" },
          ],
          description: `Maximum file paths to return. Use null for the default of ${DEFAULT_FIND_RESULTS}.`,
        },
      },
      // max_results 使用 nullable required 字段，保持 OpenAI strict schema 合法。
      required: ["path", "pattern", "max_results"],
      additionalProperties: false,
    },
  },
  {
    name: "search_files",
    description: "Call this to find a literal text string recursively inside workspace files. Results include workspace-relative file paths, line numbers, columns, and matching line text. This is read-only and case-sensitive.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Non-empty literal text to find. It is not a regular expression.",
        },
        path: {
          type: "string",
          description: "Workspace-relative directory to search recursively. Use '.' for the workspace root.",
        },
        file_pattern: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Glob matched against workspace-relative file paths, for example '**/*.ts'. Use null to search all files.",
        },
        max_results: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
            { type: "null" },
          ],
          description: `Maximum matches to return. Use null for the default of ${DEFAULT_SEARCH_RESULTS}.`,
        },
      },
      // OpenAI strict function schemas require every property name in required.
      // Nullable fields preserve optional behavior while keeping the same definition valid for both Providers.
      required: ["query", "path", "file_pattern", "max_results"],
      additionalProperties: false,
    },
  },
  {
    name: "read_text_file",
    description: "Call this when the user asks about a text file inside the workspace. The path must be relative to the workspace root.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to a UTF-8 text file.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Search long-term MEMORY.md and every memory/*.md file using the local SQLite FTS5/BM25 index. Call this when relevant durable or older daily context may not be present in the current prompt. This tool is read-only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Words or a short phrase to search for in Markdown memory.",
        },
        max_results: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_MEMORY_SEARCH_RESULTS },
            { type: "null" },
          ],
          description: `Maximum matching chunks to return. Use null for the default of 10.`,
        },
      },
      required: ["query", "max_results"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    description: "Read an exact line range directly from MEMORY.md or a direct memory/*.md file after memory_search identifies a relevant result. Markdown, not SQLite, is the source of truth. This tool is read-only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact path returned by memory_search: MEMORY.md or memory/<name>.md.",
        },
        from_line: {
          anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
          description: "First 1-based line to read. Use null to start at line 1.",
        },
        lines: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_MEMORY_GET_LINES },
            { type: "null" },
          ],
          description: `Number of lines to read. Use null for the default of ${DEFAULT_MEMORY_GET_LINES}.`,
        },
      },
      required: ["path", "from_line", "lines"],
      additionalProperties: false,
    },
  },
  {
    name: "git_status",
    description: "Call this to inspect the branch and changed files of a Git repository inside the workspace. This is read-only and returns structured porcelain status without running a shell.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path inside the Git repository. Use '.' when the workspace root is the repository.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "git_diff",
    description: "Call this to inspect staged or unstaged Git changes inside a workspace repository. External diff programs and text conversion are disabled. This tool is read-only.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path inside the Git repository. Use '.' when the workspace root is the repository.",
        },
        file: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "Repository-relative file path to inspect, or null for all changed files.",
        },
        staged: {
          type: "boolean",
          description: "Use true for staged changes and false for unstaged changes.",
        },
        max_bytes: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_GIT_DIFF_BYTES },
            { type: "null" },
          ],
          description: `Maximum diff bytes to return. Use null for the default of ${DEFAULT_GIT_DIFF_BYTES}.`,
        },
      },
      // nullable 字段仍放进 required，满足 OpenAI strict function schema。
      required: ["path", "file", "staged", "max_bytes"],
      additionalProperties: false,
    },
  },
  {
    name: "create_directory",
    description: "Call this to create a directory inside the workspace, including missing parent directories. The user must approve every call before it executes.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path of the directory to create.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_text_file",
    description: "Call this to create or overwrite a UTF-8 text file inside the workspace. The user must approve every write before it executes. The parent directory must already exist.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to the text file to create or overwrite.",
        },
        content: {
          type: "string",
          description: "The complete UTF-8 text content to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_text_file",
    description: "Call this to replace one exact, uniquely occurring text block in an existing UTF-8 workspace file. Read the file first and provide enough surrounding text to make old_text unique. The user must approve every edit.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative path to an existing UTF-8 text file.",
        },
        old_text: {
          type: "string",
          description: "Exact existing text to replace. It must be non-empty and occur exactly once.",
        },
        new_text: {
          type: "string",
          description: "Replacement text. Use an empty string to delete the matched block.",
        },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_patch",
    description: "Call this to add or update one or more workspace files with an exact Begin Patch/End Patch document. Update hunks must match existing text exactly. File deletion is not supported. The user must approve the complete patch before it executes.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: "Patch text using '*** Begin Patch', '*** Add File:' or '*** Update File:', '@@' hunks, and '*** End Patch'.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  {
    name: "fetch_url",
    description: "Call this to fetch text from a public HTTP or HTTPS URL. Requests are pinned to validated public DNS addresses, redirects are revalidated, and private/local destinations are blocked. Every call requires user approval.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute public http or https URL without embedded credentials.",
        },
        max_bytes: {
          anyOf: [
            { type: "integer", minimum: 1, maximum: MAX_FETCH_BYTES },
            { type: "null" },
          ],
          description: `Maximum response body bytes. Use null for the default of ${DEFAULT_FETCH_BYTES}.`,
        },
      },
      required: ["url", "max_bytes"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "Call this to run a shell command for building, testing, or inspecting the workspace. The command starts in the workspace but is not sandboxed, so every call requires explicit user approval. Do not access paths outside the workspace.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The exact shell command to execute from the workspace directory.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

// OpenAI Responses API 使用 parameters 字段描述函数参数。
// 从同一份 Anthropic 工具定义派生，避免两个 Provider 的名称、描述和 schema 漂移。
export const openAIToolDefinitions: OpenAIToolDefinition[] = toolDefinitions.map((tool) => ({
  type: "function",
  name: tool.name,
  description: tool.description ?? "",
  parameters: tool.input_schema,
  strict: tool.strict ?? true,
}));

// 工具分发器是唯一把“模型请求的工具名”映射到“本地函数”的位置。
// 这里使用 switch allowlist，故意不做动态属性访问，避免模型用任意字符串触发宿主对象上的其他方法。
// 抛出的错误会在 AgentLoop 中被转换成 is_error tool_result，让模型看到失败原因并继续对话。
export async function executeTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<string> {
  switch (name) {
    case "calculator":
      return runCalculator(parseCalculatorInput(input));
    case "list_directory":
      return listDirectory(parseListDirectoryInput(input), context);
    case "find_files":
      return findFiles(parseFindFilesInput(input), context);
    case "search_files":
      return searchFiles(parseSearchFilesInput(input), context);
    case "read_text_file":
      return readTextFile(parseReadTextFileInput(input), context);
    case "memory_search": {
      const parsed = parseMemorySearchInput(input);
      const result = await requireMemoryIndex(context).search(parsed.query, parsed.maxResults);
      return JSON.stringify(result, null, 2);
    }
    case "memory_get": {
      const parsed = parseMemoryGetInput(input);
      const result = await requireMemoryIndex(context).get(parsed.path, parsed.fromLine, parsed.lines);
      return JSON.stringify(result, null, 2);
    }
    case "git_status": {
      const parsed = parseGitStatusInput(input);
      return getGitStatus(context.workspaceRoot, parsed.path);
    }
    case "git_diff": {
      const parsed = parseGitDiffInput(input);
      return getGitDiff(context.workspaceRoot, {
        repositoryPath: parsed.path,
        file: parsed.file,
        staged: parsed.staged,
        maxBytes: parsed.maxBytes,
      });
    }
    case "create_directory":
      return createDirectory(parseCreateDirectoryInput(input), context);
    case "write_text_file": {
      const result = await writeTextFile(parseWriteTextFileInput(input), context);
      context.memoryIndex?.scheduleSync();
      return result;
    }
    case "edit_text_file": {
      const result = await editTextFile(parseEditTextFileInput(input), context);
      context.memoryIndex?.scheduleSync();
      return result;
    }
    case "apply_patch": {
      const parsed = parseApplyPatchInput(input);
      const result = await applyWorkspacePatch(parsed.patch, context.workspaceRoot);
      context.memoryIndex?.scheduleSync();
      return result;
    }
    case "fetch_url": {
      const parsed = parseFetchUrlInput(input);
      return fetchUrlText(parsed.url, parsed.maxBytes);
    }
    case "run_command":
      return runCommand(parseRunCommandInput(input), context);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function parseListDirectoryInput(input: unknown): ListDirectoryInput {
  // JSON Schema 能约束模型的正常输出，但不是宿主的安全校验。
  // 兼容 Provider、手写测试或未来非 strict 模型时，工具入口仍必须把 input 当 unknown。
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("list_directory requires a string path");
  }

  return { path: input.path };
}

function parseFindFilesInput(input: unknown): FindFilesInput {
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.pattern !== "string") {
    throw new Error("find_files requires string path and pattern");
  }
  if (input.pattern.length === 0) {
    throw new Error("find_files pattern must not be empty");
  }
  if (Buffer.byteLength(input.pattern, "utf8") > 1024) {
    throw new Error("find_files pattern is too long; maximum is 1024 bytes");
  }

  const maxResults = input.max_results;
  if (
    maxResults !== undefined && maxResults !== null
    && (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_FIND_RESULTS)
  ) {
    throw new Error(`find_files max_results must be an integer between 1 and ${MAX_FIND_RESULTS}`);
  }

  return {
    path: input.path,
    pattern: input.pattern,
    maxResults: maxResults ?? DEFAULT_FIND_RESULTS,
  };
}

function parseSearchFilesInput(input: unknown): SearchFilesInput {
  if (!isRecord(input) || typeof input.query !== "string" || typeof input.path !== "string") {
    throw new Error("search_files requires string query and path");
  }
  if (input.query.length === 0) {
    throw new Error("search_files query must not be empty");
  }
  if (Buffer.byteLength(input.query, "utf8") > 1024) {
    throw new Error("search_files query is too long; maximum is 1024 bytes");
  }
  const filePattern = input.file_pattern;
  if (filePattern !== undefined && filePattern !== null && (typeof filePattern !== "string" || filePattern.length === 0)) {
    throw new Error("search_files file_pattern must be a non-empty string");
  }
  if (typeof filePattern === "string" && Buffer.byteLength(filePattern, "utf8") > 1024) {
    throw new Error("search_files file_pattern is too long; maximum is 1024 bytes");
  }
  const maxResults = input.max_results;
  if (
    maxResults !== undefined && maxResults !== null
    && (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_SEARCH_RESULTS)
  ) {
    throw new Error(`search_files max_results must be an integer between 1 and ${MAX_SEARCH_RESULTS}`);
  }

  return {
    query: input.query,
    path: input.path,
    filePattern: filePattern ?? undefined,
    maxResults: maxResults ?? DEFAULT_SEARCH_RESULTS,
  };
}

// 工具参数来自模型输出，即使 schema 是 strict，也仍然属于系统边界输入。
// 所以这里先判断 input 是普通对象，再检查 path 类型，防止 null、数组或错误字段进入文件逻辑。
function parseReadTextFileInput(input: unknown): ReadTextFileInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("read_text_file requires a string path");
  }

  return { path: input.path };
}

function parseMemorySearchInput(input: unknown): MemorySearchInput {
  if (!isRecord(input) || typeof input.query !== "string") {
    throw new Error("memory_search requires a string query");
  }
  const maxResults = input.max_results;
  if (
    maxResults !== undefined && maxResults !== null
    && (typeof maxResults !== "number" || !Number.isInteger(maxResults)
      || maxResults < 1 || maxResults > MAX_MEMORY_SEARCH_RESULTS)
  ) {
    throw new Error(
      `memory_search max_results must be an integer between 1 and ${MAX_MEMORY_SEARCH_RESULTS}`,
    );
  }
  return { query: input.query, maxResults: maxResults ?? 10 };
}

function parseMemoryGetInput(input: unknown): MemoryGetInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("memory_get requires a string path");
  }
  const fromLine = input.from_line;
  if (
    fromLine !== undefined && fromLine !== null
    && (typeof fromLine !== "number" || !Number.isInteger(fromLine) || fromLine < 1)
  ) {
    throw new Error("memory_get from_line must be a positive integer or null");
  }
  const lines = input.lines;
  if (
    lines !== undefined && lines !== null
    && (typeof lines !== "number" || !Number.isInteger(lines)
      || lines < 1 || lines > MAX_MEMORY_GET_LINES)
  ) {
    throw new Error(`memory_get lines must be an integer between 1 and ${MAX_MEMORY_GET_LINES}`);
  }
  return {
    path: input.path,
    fromLine: fromLine ?? 1,
    lines: lines ?? DEFAULT_MEMORY_GET_LINES,
  };
}

function requireMemoryIndex(context: ToolContext): MemoryToolService {
  if (!context.memoryIndex) {
    throw new Error("memory index is not configured");
  }
  return context.memoryIndex;
}

function parseGitStatusInput(input: unknown): GitStatusInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("git_status requires a string path");
  }
  return { path: input.path };
}

function parseGitDiffInput(input: unknown): GitDiffInput {
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.staged !== "boolean") {
    throw new Error("git_diff requires string path and boolean staged");
  }
  const file = input.file;
  if (file !== undefined && file !== null && (typeof file !== "string" || file.trim().length === 0)) {
    throw new Error("git_diff file must be a non-empty string or null");
  }
  if (typeof file === "string" && Buffer.byteLength(file, "utf8") > 4096) {
    throw new Error("git_diff file is too long; maximum is 4096 bytes");
  }
  const maxBytes = input.max_bytes;
  if (
    maxBytes !== undefined && maxBytes !== null
    && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GIT_DIFF_BYTES)
  ) {
    throw new Error(`git_diff max_bytes must be an integer between 1 and ${MAX_GIT_DIFF_BYTES}`);
  }
  return {
    path: input.path,
    file: file ?? undefined,
    staged: input.staged,
    maxBytes: maxBytes ?? DEFAULT_GIT_DIFF_BYTES,
  };
}

function parseCreateDirectoryInput(input: unknown): CreateDirectoryInput {
  if (!isRecord(input) || typeof input.path !== "string") {
    throw new Error("create_directory requires a string path");
  }
  if (input.path.trim().length === 0) {
    throw new Error("create_directory path must not be empty");
  }
  if (Buffer.byteLength(input.path, "utf8") > 4096) {
    throw new Error("create_directory path is too long; maximum is 4096 bytes");
  }

  return { path: input.path };
}

function parseWriteTextFileInput(input: unknown): WriteTextFileInput {
  // 写入路径和内容必须同时存在；不把 null/undefined 隐式转成字符串，
  // 否则模型参数错误可能意外覆盖文件为 "undefined"。
  if (!isRecord(input) || typeof input.path !== "string" || typeof input.content !== "string") {
    throw new Error("write_text_file requires string path and content");
  }

  return { path: input.path, content: input.content };
}

function parseEditTextFileInput(input: unknown): EditTextFileInput {
  // 使用 API 字段名 old_text/new_text 与 schema 保持一致，进入内部后转成 camelCase。
  if (
    !isRecord(input)
    || typeof input.path !== "string"
    || typeof input.old_text !== "string"
    || typeof input.new_text !== "string"
  ) {
    throw new Error("edit_text_file requires string path, old_text, and new_text");
  }
  if (input.old_text.length === 0) {
    // 空字符串在任何位置都能“匹配”，如果允许会使精确替换语义失效。
    throw new Error("edit_text_file old_text must not be empty");
  }

  return {
    path: input.path,
    oldText: input.old_text,
    newText: input.new_text,
  };
}

function parseApplyPatchInput(input: unknown): ApplyPatchInput {
  if (!isRecord(input) || typeof input.patch !== "string") {
    throw new Error("apply_patch requires a string patch");
  }
  if (input.patch.trim().length === 0) {
    throw new Error("apply_patch patch must not be empty");
  }
  return { patch: input.patch };
}

function parseFetchUrlInput(input: unknown): FetchUrlInput {
  // schema strict 只约束正常模型输出；工具边界仍把参数当 unknown 再校验一次。
  if (!isRecord(input) || typeof input.url !== "string") {
    throw new Error("fetch_url requires a string url");
  }
  if (input.url.trim().length === 0) {
    throw new Error("fetch_url url must not be empty");
  }
  if (Buffer.byteLength(input.url, "utf8") > 8192) {
    throw new Error("fetch_url url is too long; maximum is 8192 bytes");
  }
  const maxBytes = input.max_bytes;
  // OpenAI strict schema 用 null 表示“采用默认值”，同时兼容未传字段的其他调用方。
  if (
    maxBytes !== undefined && maxBytes !== null
    && (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FETCH_BYTES)
  ) {
    throw new Error(`fetch_url max_bytes must be an integer between 1 and ${MAX_FETCH_BYTES}`);
  }
  return { url: input.url, maxBytes: maxBytes ?? DEFAULT_FETCH_BYTES };
}

// calculator 参数校验分两层：先校验 operation 是否属于枚举，再校验两个操作数是否为有限数字。
// Number.isFinite 可以排除 NaN、Infinity 和 -Infinity，避免输出不可解释的结果。
function parseCalculatorInput(input: unknown): CalculatorInput {
  if (!isRecord(input)) {
    throw new Error("calculator input must be an object");
  }

  const { operation, a, b } = input;
  if (operation !== "add" && operation !== "subtract" && operation !== "multiply" && operation !== "divide") {
    throw new Error("calculator operation must be add, subtract, multiply, or divide");
  }
  if (typeof a !== "number" || !Number.isFinite(a) || typeof b !== "number" || !Number.isFinite(b)) {
    throw new Error("calculator operands must be finite numbers");
  }

  return { operation, a, b };
}

function parseRunCommandInput(input: unknown): RunCommandInput {
  if (!isRecord(input) || typeof input.command !== "string") {
    throw new Error("run_command requires a string command");
  }

  if (input.command.trim().length === 0) {
    throw new Error("run_command command must not be empty");
  }
  if (Buffer.byteLength(input.command, "utf8") > 8 * 1024) {
    throw new Error("run_command command is too long; maximum is 8192 bytes");
  }
  return { command: input.command };
}

// 计算器只做固定分支运算，不支持表达式字符串。
// 这是最小实现里重要的安全边界：不引入 eval、Function、shell 或任意脚本执行能力。
function runCalculator(input: CalculatorInput): string {
  switch (input.operation) {
    case "add":
      return String(input.a + input.b);
    case "subtract":
      return String(input.a - input.b);
    case "multiply":
      return String(input.a * input.b);
    case "divide":
      if (input.b === 0) {
        throw new Error("division by zero is not allowed");
      }
      return String(input.a / input.b);
  }
}

interface LimitedCommandOutput {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

async function runCommand(input: RunCommandInput, context: ToolContext): Promise<string> {
  const cwd = await fs.realpath(context.workspaceRoot);
  const timeoutMs = resolveCommandTimeout(context.commandTimeoutMs);
  const stdout: LimitedCommandOutput = { chunks: [], bytes: 0, truncated: false };
  const stderr: LimitedCommandOutput = { chunks: [], bytes: 0, truncated: false };

  // shell: true 让命令在 Windows 使用 ComSpec，在 POSIX 使用 /bin/sh，
  // 从而支持 pnpm scripts、管道和重定向。stdin 固定为 ignore，防止交互命令占用 CLI 输入。
  const child = spawn(input.command, {
    cwd,
    shell: true,
    env: createCommandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX 下创建独立进程组，超时时可以连同 Shell 的子进程一起终止。
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  child.stdout.on("data", (chunk: Buffer) => appendLimitedOutput(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => appendLimitedOutput(stderr, chunk));

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateCommandProcess(child, false);
      // 给进程 1 秒清理时间；仍未退出则强制终止。
      forceKillTimer = setTimeout(() => terminateCommandProcess(child, true), 1_000);
    }, timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(JSON.stringify({
        command: input.command,
        cwd: ".",
        exit_code: exitCode,
        signal,
        timed_out: timedOut,
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
      }, null, 2));
    });
  });
}

function resolveCommandTimeout(configuredTimeoutMs: number | undefined): number {
  const timeoutMs = configuredTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new Error(`command timeout must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_MS} milliseconds`);
  }
  return timeoutMs;
}

function terminateCommandProcess(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined) return;

  if (process.platform === "win32") {
    // Node 在 Windows 上只会终止直接子进程，taskkill /T 用于清理 cmd.exe 启动的整棵子进程树。
    // 第一次不加 /F，给命令正常退出的机会；一秒后仍未退出才强制终止。
    const arguments_ = ["/pid", String(child.pid), "/t"];
    if (force) arguments_.push("/f");
    const killer = spawn("taskkill", arguments_, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill(force ? "SIGKILL" : "SIGTERM"));
    return;
  }

  try {
    // detached: true 使 child.pid 成为新进程组 id，负 pid 会将信号发给整个命令树。
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // 进程可能恰好已退出；直接 kill 作为进程组不存在时的 fallback。
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

function createCommandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENVIRONMENT_NAME.test(name)) {
      environment[name] = value;
    }
  }
  return environment;
}

function appendLimitedOutput(output: LimitedCommandOutput, chunk: Buffer): void {
  const remaining = MAX_COMMAND_OUTPUT_BYTES - output.bytes;
  if (remaining <= 0) {
    output.truncated = true;
    return;
  }

  const selected = chunk.subarray(0, remaining);
  output.chunks.push(selected);
  output.bytes += selected.length;
  if (selected.length < chunk.length) {
    output.truncated = true;
  }
}

async function readTextFile(input: ReadTextFileInput, context: ToolContext): Promise<string> {
  const { realTarget } = await resolveWorkspacePath(input.path, context);

  // 只允许读取普通文件，不允许读取目录、设备文件或其他特殊文件。
  // 目录浏览由 list_directory 独立处理，避免两个工具的能力边界混在一起。
  const stat = await fs.stat(realTarget);
  if (!stat.isFile()) {
    throw new Error("path is not a file");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is too large; maximum is ${MAX_FILE_BYTES} bytes`);
  }

  // MVP 只按 UTF-8 文本读取。
  // 二进制、图片、PDF 等文件类型需要不同的内容块格式，暂不放进最小工具面。
  return fs.readFile(realTarget, "utf8");
}

async function createDirectory(input: CreateDirectoryInput, context: ToolContext): Promise<string> {
  // 先解析完整安全目标，再执行一次 mkdir。recursive 允许模型创建 a/b/c，
  // 但路径边界、已有祖先和符号链接检查仍由工具层掌控。
  const { root, target, existed } = await resolveWorkspaceDirectoryCreationPath(input.path, context);
  if (!existed) {
    await fs.mkdir(target, { recursive: true });
  }

  return JSON.stringify({
    path: path.relative(root, target).split(path.sep).join("/") || ".",
    created: !existed,
  }, null, 2);
}

async function writeTextFile(input: WriteTextFileInput, context: ToolContext): Promise<string> {
  // 限制的是 UTF-8 落盘字节数，而不是 JavaScript UTF-16 string.length；
  // 这样中文、emoji 等多字节内容不会绕过文件大小上限。
  const bytes = Buffer.byteLength(input.content, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`content is too large; maximum is ${MAX_FILE_BYTES} bytes`);
  }

  // 先完成语法路径、真实路径、符号链接和文件类型检查，然后才执行有副作用的 writeFile。
  const { root, target, existed } = await resolveWorkspaceWritePath(input.path, context);
  await fs.writeFile(target, input.content, "utf8");

  const relativePath = path.relative(root, target).split(path.sep).join("/");
  // 返回结构化 JSON 文本，让模型能区分“新建”和“覆盖”，并核对实际字节数。
  return JSON.stringify({
    path: relativePath,
    bytes,
    created: !existed,
  }, null, 2);
}

async function editTextFile(input: EditTextFileInput, context: ToolContext): Promise<string> {
  // 精确编辑不允许新建文件；新建和全量覆盖由 write_text_file 负责，
  // 两个工具能力分开后，确认界面上的操作意图更清晰。
  const { root, target, existed } = await resolveWorkspaceWritePath(input.path, context);
  if (!existed) {
    throw new Error("path does not exist");
  }

  const stat = await fs.stat(target);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`file is too large; maximum is ${MAX_FILE_BYTES} bytes`);
  }

  const content = await fs.readFile(target, "utf8");
  // 先找第一次，再从下一个字符开始找第二次，也能发现重叠匹配。
  // 必须唯一匹配，否则模型应先读文件并提供更多上下文，而不是猜测要改哪一处。
  const matchIndex = content.indexOf(input.oldText);
  if (matchIndex === -1) {
    throw new Error("old_text was not found");
  }
  if (content.indexOf(input.oldText, matchIndex + 1) !== -1) {
    throw new Error("old_text occurs more than once; include more surrounding text");
  }

  // 不用 String.replace 的正则表达式形态，old_text/new_text 始终是字面文本，
  // `$&`、反斜杠或正则元字符都不会被当成特殊替换语法。
  const updatedContent = `${content.slice(0, matchIndex)}${input.newText}${content.slice(matchIndex + input.oldText.length)}`;
  const bytes = Buffer.byteLength(updatedContent, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Error(`edited content is too large; maximum is ${MAX_FILE_BYTES} bytes`);
  }

  // 先在内存中完成替换与结果大小检查，所有检查通过后只写盘一次。
  await fs.writeFile(target, updatedContent, "utf8");

  // line/column 都是 1-based，便于模型回复和人类编辑器定位。
  const beforeMatch = content.slice(0, matchIndex);
  const lastNewlineIndex = beforeMatch.lastIndexOf("\n");
  return JSON.stringify({
    path: path.relative(root, target).split(path.sep).join("/"),
    replacements: 1,
    line: countLineBreaks(beforeMatch) + 1,
    column: matchIndex - lastNewlineIndex,
    bytes,
  }, null, 2);
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === "\n") count += 1;
  }
  return count;
}

async function listDirectory(input: ListDirectoryInput, context: ToolContext): Promise<string> {
  const { root, realTarget } = await resolveWorkspacePath(input.path, context);
  const stat = await fs.stat(realTarget);
  if (!stat.isDirectory()) {
    throw new Error("path is not a directory");
  }

  const allEntries = await fs.readdir(realTarget, { withFileTypes: true });
  // 文件系统返回顺序不稳定，先按名称排序可使模型上下文、测试和用户输出可重复。
  allEntries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  // 先截断再读元数据，避免对超大目录的所有文件发起 lstat。
  const selectedEntries = allEntries.slice(0, MAX_DIRECTORY_ENTRIES);
  const entries = await Promise.all(selectedEntries.map(async (entry) => {
    const type = getDirectoryEntryType(entry);
    if (type !== "file") {
      return { name: entry.name, type };
    }

    // lstat 不跟随符号链接；即使目录内容在读取期间发生变化，也不会借此读取 workspace 外部目标。
    const entryStat = await fs.lstat(path.join(realTarget, entry.name));
    return { name: entry.name, type, size: entryStat.size };
  }));

  const relativePath = path.relative(root, realTarget);
  return JSON.stringify({
    path: relativePath.length === 0 ? "." : relativePath.split(path.sep).join("/"),
    entries,
    truncated: allEntries.length > MAX_DIRECTORY_ENTRIES,
  }, null, 2);
}

interface SearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

async function findFiles(input: FindFilesInput, context: ToolContext): Promise<string> {
  const { root, realTarget } = await resolveWorkspacePath(input.path, context);
  const targetStat = await fs.stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error("find path is not a directory");
  }

  // 工具对外统一使用 /，这样模型给出的 glob 在 Windows 和 POSIX 上语义相同。
  const pattern = input.pattern.replaceAll("\\", "/");
  const patternRegex = compileFilePattern(pattern);
  const files: string[] = [];
  const pendingDirectories = [realTarget];
  let scannedEntries = 0;
  let truncated = false;

  findLoop: while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift();
    if (!directory) break;

    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_FIND_SCANNED_ENTRIES) {
        truncated = true;
        break findLoop;
      }

      // 不跟随文件或目录符号链接，避免越界发现、重复结果和目录循环。
      if (entry.isSymbolicLink()) continue;

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      if (!patternRegex.test(relativePath)) continue;
      if (files.length >= input.maxResults) {
        truncated = true;
        break findLoop;
      }
      files.push(relativePath);
    }
  }

  const relativeSearchPath = path.relative(root, realTarget).split(path.sep).join("/");
  return JSON.stringify({
    path: relativeSearchPath.length === 0 ? "." : relativeSearchPath,
    pattern,
    files,
    truncated,
  }, null, 2);
}

async function searchFiles(input: SearchFilesInput, context: ToolContext): Promise<string> {
  const { root, realTarget } = await resolveWorkspacePath(input.path, context);
  const targetStat = await fs.stat(realTarget);
  if (!targetStat.isDirectory()) {
    throw new Error("search path is not a directory");
  }

  const filePattern = input.filePattern?.replaceAll("\\", "/");
  const filePatternRegex = filePattern ? compileFilePattern(filePattern) : undefined;

  const matches: SearchMatch[] = [];
  const pendingDirectories = [realTarget];
  let searchedFiles = 0;
  let truncated = false;

  searchLoop: while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.shift();
    if (!directory) break;

    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      // 不跟随搜索目录中的符号链接：这样即使链接指向 workspace 内部，也不会重复搜索；
      // 指向 workspace 外部时更不会形成越界读取。
      if (entry.isSymbolicLink()) continue;

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(root, entryPath).split(path.sep).join("/");
      if (filePatternRegex && !filePatternRegex.test(relativePath)) continue;

      searchedFiles += 1;
      if (searchedFiles > MAX_SEARCHED_FILES) {
        truncated = true;
        break searchLoop;
      }

      const stat = await fs.stat(entryPath);
      if (stat.size > MAX_FILE_BYTES) continue;

      const content = await fs.readFile(entryPath);
      // NUL 字节是二进制文件的可靠低成本信号。二进制内容不应作为 UTF-8 行文本返回给模型。
      if (content.includes(0)) continue;

      const lines = content.toString("utf8").split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex]?.replace(/\r$/, "") ?? "";
        const matchIndex = line.indexOf(input.query);
        if (matchIndex === -1) continue;

        // 多个匹配位于同一行时只返回一条，行为接近常用文本搜索工具，且能控制上下文体积。
        if (matches.length >= input.maxResults) {
          truncated = true;
          break searchLoop;
        }
        matches.push({
          path: relativePath,
          line: lineIndex + 1,
          column: matchIndex + 1,
          text: createSearchLinePreview(line, matchIndex, input.query.length),
        });
      }
    }
  }

  const relativeSearchPath = path.relative(root, realTarget).split(path.sep).join("/");
  return JSON.stringify({
    query: input.query,
    path: relativeSearchPath.length === 0 ? "." : relativeSearchPath,
    file_pattern: filePattern,
    matches,
    truncated,
  }, null, 2);
}

function createSearchLinePreview(line: string, matchIndex: number, queryLength: number): string {
  if (line.length <= MAX_SEARCH_LINE_CHARACTERS) return line;

  const contextCharacters = Math.max(0, MAX_SEARCH_LINE_CHARACTERS - Math.min(queryLength, MAX_SEARCH_LINE_CHARACTERS));
  const start = Math.max(0, matchIndex - Math.floor(contextCharacters / 2));
  const end = Math.min(line.length, start + MAX_SEARCH_LINE_CHARACTERS);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function compileFilePattern(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character === "*" && pattern[index + 1] === "*") {
      // **/ 也匹配零层目录，所以 **/*.ts 能同时匹配 a.ts 和 src/a.ts。
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function getDirectoryEntryType(entry: import("node:fs").Dirent): "file" | "directory" | "symbolic_link" | "other" {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symbolic_link";
  return "other";
}

async function resolveWorkspacePath(
  requestedPath: string,
  context: ToolContext,
): Promise<{ root: string; realTarget: string }> {
  // 第一层：直接拒绝绝对路径。
  // 这样模型不能绕过 workspaceRoot，去指定 C:\、/etc 或其他系统位置。
  if (path.isAbsolute(requestedPath)) {
    throw new Error("path must be relative to the workspace");
  }

  // 第二层：在语法路径层面阻止 .. 逃逸。
  const root = await fs.realpath(context.workspaceRoot);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);
  if (isOutsideRoot(relative)) {
    throw new Error("path escapes the workspace");
  }

  // 第三层：检查真实路径，阻止 workspace 内的符号链接指向外部位置。
  const realTarget = await fs.realpath(target);
  const realRelative = path.relative(root, realTarget);
  if (isOutsideRoot(realRelative)) {
    throw new Error("path resolves outside the workspace");
  }

  return { root, realTarget };
}

async function resolveWorkspaceWritePath(
  requestedPath: string,
  context: ToolContext,
): Promise<{ root: string; target: string; existed: boolean }> {
  // 写入路径比读取路径复杂：新文件尚不存在，不能直接对 target 调用 realpath。
  // 因此先做不需要目标存在的语法边界检查，再分“已存在”和“待创建”两条分支。
  if (path.isAbsolute(requestedPath)) {
    throw new Error("path must be relative to the workspace");
  }

  const root = await fs.realpath(context.workspaceRoot);
  const target = path.resolve(root, requestedPath);
  const relative = path.relative(root, target);
  if (isOutsideRoot(relative)) {
    throw new Error("path escapes the workspace");
  }

  let targetStat: import("node:fs").Stats | undefined;
  try {
    // lstat 不跟随最后一段符号链接，因此可以在覆盖前显式拒绝 symlink 目标。
    targetStat = await fs.lstat(target);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }

  if (targetStat) {
    // 已存在的目标只允许普通文件。拒绝目录、设备文件和 symlink，
    // 既防止越界，也避免“覆盖”语义指向用户没有确认的另一个目标。
    if (targetStat.isSymbolicLink()) {
      throw new Error("write target must not be a symbolic link");
    }
    if (!targetStat.isFile()) {
      throw new Error("path is not a file");
    }

    const realTarget = await fs.realpath(target);
    const realRelative = path.relative(root, realTarget);
    if (isOutsideRoot(realRelative)) {
      throw new Error("path resolves outside the workspace");
    }
    return { root, target: realTarget, existed: true };
  }

  let realParent: string;
  try {
    // 对新文件验证真实父目录。如果 workspace 内有一个指向外部的目录 symlink，
    // realpath(parent) 会暴露其真实位置，下方 parentRelative 检查会拒绝该写入。
    realParent = await fs.realpath(path.dirname(target));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new Error("parent directory does not exist");
    }
    throw error;
  }

  const parentRelative = path.relative(root, realParent);
  if (isOutsideRoot(parentRelative)) {
    throw new Error("path resolves outside the workspace");
  }

  return {
    root,
    target: path.join(realParent, path.basename(target)),
    existed: false,
  };
}

async function resolveWorkspaceDirectoryCreationPath(
  requestedPath: string,
  context: ToolContext,
): Promise<{ root: string; target: string; existed: boolean }> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("path must be relative to the workspace");
  }

  const root = await fs.realpath(context.workspaceRoot);
  const requestedTarget = path.resolve(root, requestedPath);
  const relative = path.relative(root, requestedTarget);
  if (isOutsideRoot(relative)) {
    throw new Error("path escapes the workspace");
  }

  let targetStat: import("node:fs").Stats | undefined;
  try {
    // 最后一段若是符号链接，即使指向 workspace 内部也拒绝，避免“创建目录”变成操作另一个名字。
    targetStat = await fs.lstat(requestedTarget);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }

  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      throw new Error("directory target must not be a symbolic link");
    }
    if (!targetStat.isDirectory()) {
      throw new Error("path exists and is not a directory");
    }

    const realTarget = await fs.realpath(requestedTarget);
    const realRelative = path.relative(root, realTarget);
    if (isOutsideRoot(realRelative)) {
      throw new Error("path resolves outside the workspace");
    }
    return { root, target: realTarget, existed: true };
  }

  // recursive mkdir 的直接父目录也可能不存在，因此向上寻找最近的已有祖先，
  // 再验证祖先真实路径并从该真实路径拼回所有缺失目录。
  const missingSegments = [path.basename(requestedTarget)];
  let existingAncestor = path.dirname(requestedTarget);
  let ancestorStat: import("node:fs").Stats;
  while (true) {
    try {
      ancestorStat = await fs.stat(existingAncestor);
      break;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error("could not find an existing parent directory");
      }
      missingSegments.push(path.basename(existingAncestor));
      existingAncestor = parent;
    }
  }

  if (!ancestorStat.isDirectory()) {
    throw new Error("parent path is not a directory");
  }
  const realAncestor = await fs.realpath(existingAncestor);
  const ancestorRelative = path.relative(root, realAncestor);
  if (isOutsideRoot(ancestorRelative)) {
    throw new Error("path resolves outside the workspace");
  }

  const target = path.join(realAncestor, ...missingSegments.reverse());
  const targetRelative = path.relative(root, target);
  if (isOutsideRoot(targetRelative)) {
    throw new Error("path resolves outside the workspace");
  }
  return { root, target, existed: false };
}

function isOutsideRoot(relativePath: string): boolean {
  // path.relative 在目标位于 root 内时不会以 .. 开头。
  // 额外检查 path.isAbsolute 可覆盖 Windows 不同盘符时 relative 返回绝对路径的情况。
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// 判断 unknown 是否为普通对象，供工具参数解析复用。
// 排除数组是为了避免把数组下标误当成对象字段处理。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
