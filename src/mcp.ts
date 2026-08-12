import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { OpenAIToolDefinition } from "./tools.js";

const MCP_CONFIG_FILE = "mcp.json";
const MCP_REQUEST_TIMEOUT_MS = 30_000;
const MAX_MCP_TOOLS = 200;
const MAX_EXPOSED_TOOL_NAME_CHARACTERS = 64;
const MAX_MCP_RESULT_BYTES = 256 * 1024;

interface McpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  enabled: boolean;
}

interface McpToolClient {
  listTools(params?: { cursor?: string }, options?: { timeout?: number }): Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema: Record<string, unknown>;
    }>;
    nextCursor?: string;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface McpConnection {
  client: McpToolClient;
  close(): Promise<void>;
}

interface McpDependencies {
  connect(serverName: string, config: McpServerConfig, projectRoot: string): Promise<McpConnection>;
}

interface RegisteredMcpTool {
  exposedName: string;
  remoteName: string;
  serverName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  client: McpToolClient;
}

export interface McpToolDefinitions {
  anthropic: Anthropic.Tool[];
  openai: OpenAIToolDefinition[];
}

// McpManager 是运行期 MCP 连接和动态工具定义的唯一所有者。
// AgentLoop 仍只看到普通工具名和字符串结果，不依赖 MCP SDK。
export class McpManager {
  private readonly tools = new Map<string, RegisteredMcpTool>();
  private readonly connections: McpConnection[] = [];

  static async load(
    projectRoot: string,
    dependencyOverrides: Partial<McpDependencies> = {},
  ): Promise<McpManager> {
    const manager = new McpManager();
    const config = await loadMcpConfig(projectRoot);
    const dependencies: McpDependencies = {
      connect: connectStdioServer,
      ...dependencyOverrides,
    };

    try {
      for (const [serverName, serverConfig] of Object.entries(config)) {
        if (!serverConfig.enabled) continue;
        const connection = await dependencies.connect(serverName, serverConfig, projectRoot);
        manager.connections.push(connection);
        await manager.registerServerTools(serverName, connection.client);
      }
      return manager;
    } catch (error) {
      await manager.close();
      throw error;
    }
  }

  get serverCount(): number {
    return this.connections.length;
  }

  get toolCount(): number {
    return this.tools.size;
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  getDefinitions(): McpToolDefinitions {
    const tools = [...this.tools.values()];
    return {
      anthropic: tools.map((tool) => ({
        name: tool.exposedName,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      })),
      openai: tools.map((tool) => ({
        type: "function",
        name: tool.exposedName,
        description: tool.description,
        parameters: tool.inputSchema as Anthropic.Tool.InputSchema,
        strict: false,
      })),
    };
  }

  async execute(name: string, input: unknown): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    if (!isRecord(input)) throw new Error(`MCP tool ${name} requires an object input`);

    const result = await tool.client.callTool(
      { name: tool.remoteName, arguments: input },
      undefined,
      { timeout: MCP_REQUEST_TIMEOUT_MS },
    );
    const formatted = limitUtf8Text(formatMcpToolResult(result), MAX_MCP_RESULT_BYTES);
    if (isRecord(result) && result.isError === true) {
      throw new Error(formatted || `MCP tool ${name} failed`);
    }
    return formatted;
  }

  async close(): Promise<void> {
    const connections = this.connections.splice(0).reverse();
    this.tools.clear();
    await Promise.allSettled(connections.map((connection) => connection.close()));
  }

  private async registerServerTools(serverName: string, client: McpToolClient): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        timeout: MCP_REQUEST_TIMEOUT_MS,
      });
      for (const tool of page.tools) {
        if (this.tools.size >= MAX_MCP_TOOLS) {
          throw new Error(`MCP tool limit exceeded; maximum is ${MAX_MCP_TOOLS}`);
        }
        const exposedName = createExposedToolName(serverName, tool.name);
        if (this.tools.has(exposedName)) {
          throw new Error(`Duplicate MCP tool name: ${exposedName}`);
        }
        if (!isObjectJsonSchema(tool.inputSchema)) {
          throw new Error(`MCP tool ${exposedName} must use an object input schema`);
        }
        this.tools.set(exposedName, {
          exposedName,
          remoteName: tool.name,
          serverName,
          description: `[MCP server: ${serverName}] ${tool.description?.trim() || tool.name}`,
          inputSchema: tool.inputSchema,
          client,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

async function loadMcpConfig(projectRoot: string): Promise<Record<string, McpServerConfig>> {
  const configPath = path.join(projectRoot, MCP_CONFIG_FILE);
  let text: string;
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${MCP_CONFIG_FILE} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(payload) || !isRecord(payload.mcpServers)) {
    throw new Error(`${MCP_CONFIG_FILE} must contain an mcpServers object`);
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(payload.mcpServers)) {
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(name)) {
      throw new Error(`MCP server name must match [A-Za-z0-9_-]{1,24}: ${name}`);
    }
    servers[name] = parseServerConfig(name, value);
  }
  return servers;
}

function parseServerConfig(name: string, value: unknown): McpServerConfig {
  if (!isRecord(value) || typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`MCP server ${name} requires a non-empty command`);
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error(`MCP server ${name} args must be an array of strings`);
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error(`MCP server ${name} cwd must be a string`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error(`MCP server ${name} enabled must be a boolean`);
  }
  const env = value.env ?? {};
  if (!isRecord(env) || Object.values(env).some((entry) => typeof entry !== "string")) {
    throw new Error(`MCP server ${name} env must contain only string values`);
  }
  return {
    command: value.command.trim(),
    args: [...args],
    cwd: value.cwd,
    env: env as Record<string, string>,
    enabled: value.enabled ?? true,
  };
}

async function connectStdioServer(
  serverName: string,
  config: McpServerConfig,
  projectRoot: string,
): Promise<McpConnection> {
  const client = new Client({ name: "openclaw-mini", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd ? path.resolve(projectRoot, config.cwd) : projectRoot,
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "inherit",
  });
  try {
    await client.connect(transport, { timeout: MCP_REQUEST_TIMEOUT_MS });
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw new Error(`Failed to connect MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    client,
    close: () => client.close(),
  };
}

function formatMcpToolResult(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result);
  const output: unknown[] = [];
  if (isRecord(result.structuredContent)) {
    output.push({ structuredContent: result.structuredContent });
  }
  if (Array.isArray(result.content)) {
    for (const content of result.content) {
      if (!isRecord(content) || typeof content.type !== "string") continue;
      if (content.type === "text" && typeof content.text === "string") {
        output.push(content.text);
      } else if (content.type === "resource_link" && typeof content.uri === "string") {
        output.push({ type: content.type, uri: content.uri, name: content.name });
      } else if (content.type === "resource" && isRecord(content.resource)) {
        output.push({ type: content.type, resource: content.resource });
      } else if ((content.type === "image" || content.type === "audio") && typeof content.mimeType === "string") {
        // 当前 AgentLoop 的工具结果是文本，因此不把可能很大的 base64 媒体塞进会话。
        output.push({ type: content.type, mimeType: content.mimeType, omitted: true });
      }
    }
  }
  if (output.length === 1 && typeof output[0] === "string") return output[0];
  return JSON.stringify(output, null, 2);
}

function createExposedToolName(serverName: string, remoteName: string): string {
  const prefix = `mcp__${serverName}__`;
  const normalized = remoteName.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  const available = MAX_EXPOSED_TOOL_NAME_CHARACTERS - prefix.length;
  if (normalized === remoteName && normalized.length <= available) return `${prefix}${normalized}`;

  // MCP 允许的工具名可能比模型厂商的 function name 更宽松或更长。
  // 保留可读前缀，并用远端原名哈希避免清洗/截断后的碰撞。
  const hash = createHash("sha256").update(remoteName).digest("hex").slice(0, 8);
  const readableLength = Math.max(1, available - hash.length - 2);
  return `${prefix}${normalized.slice(0, readableLength)}__${hash}`;
}

function limitUtf8Text(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // UTF-8 continuation byte 10xxxxxx 不能作为截断后第一个被丢弃字节的内部边界。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n[MCP result truncated at ${maxBytes} bytes]`;
}

function isObjectJsonSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
