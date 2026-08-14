import { randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type {
  AgentEventHandler,
  AgentLoop,
  ToolConfirmationHandler,
} from "./agent-loop.js";
import type { RuntimeConfig } from "./runtime.js";
import { formatRuntimeError } from "./runtime.js";
import type { SessionHistoryView } from "./session-history.js";
import type { WorkspaceInstructions } from "./workspace-instructions.js";
import type { WorkspaceMemoryContext } from "./workspace-memory.js";
import { WEB_PAGE } from "./web-page.js";

type AgentRunner = Pick<AgentLoop, "runTurn">;

export interface WebServerOptions {
  config: RuntimeConfig;
  workspaceInstructions?: WorkspaceInstructions;
  getAgent: (sessionId: string) => Promise<AgentRunner>;
  listSessions: () => Promise<string[]>;
  createSession: (sessionId: string) => Promise<void>;
  renameSession: (oldSessionId: string, newSessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  releaseAgent: (sessionId: string) => void;
  loadHistory: (sessionId: string) => Promise<SessionHistoryView>;
  // Web 只提供 MEMORY.md 和最近每日记忆的读取视图；写入统一由 workspace 文件工具承担。
  loadMemory: () => Promise<WorkspaceMemoryContext>;
  confirmationTimeoutMs?: number;
  page?: string;
}

interface PendingConfirmation {
  sessionId: string;
  settle: (approved: boolean) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createWebServer(options: WebServerOptions): http.Server {
  const busySessions = new Set<string>();
  const pendingConfirmations = new Map<string, PendingConfirmation>();
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? 5 * 60_000;
  if (!Number.isInteger(confirmationTimeoutMs) || confirmationTimeoutMs <= 0) {
    throw new Error("confirmationTimeoutMs must be a positive integer");
  }

  return http.createServer((request, response) => {
    routeRequest(
      request,
      response,
      options,
      busySessions,
      pendingConfirmations,
      confirmationTimeoutMs,
    ).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded) {
          sendSse(response, { type: "error", message: formatRuntimeError(error) });
          response.end();
        }
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      writeJson(response, status, { error: formatRuntimeError(error) });
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebServerOptions,
  busySessions: Set<string>,
  pendingConfirmations: Map<string, PendingConfirmation>,
  confirmationTimeoutMs: number,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(options.page ?? WEB_PAGE);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    writeJson(response, 200, {
      provider: options.config.providerName,
      model: options.config.model,
      workspace: options.config.workspaceRoot,
      instructions: options.workspaceInstructions?.relativePath ?? null,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    writeJson(response, 200, { sessions: await options.listSessions() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/memory") {
    writeJson(response, 200, { memory: await options.loadMemory() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonObject(request);
    const sessionId = requireSessionId(body.sessionId);
    await options.createSession(sessionId);
    writeJson(response, 201, { sessionId });
    return;
  }

  const sessionMutationMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMutationMatch && (request.method === "PATCH" || request.method === "DELETE")) {
    const sessionId = requireSessionId(decodePathSegment(sessionMutationMatch[1] ?? ""));
    if (busySessions.has(sessionId)) {
      throw new HttpError(409, `session ${sessionId} already has a running turn`);
    }
    if (request.method === "PATCH") {
      const body = await readJsonObject(request);
      const newSessionId = requireSessionId(body.newSessionId);
      if (busySessions.has(newSessionId)) {
        throw new HttpError(409, `session ${newSessionId} already has a running turn`);
      }
      await options.renameSession(sessionId, newSessionId);
      options.releaseAgent(sessionId);
      options.releaseAgent(newSessionId);
      writeJson(response, 200, { sessionId: newSessionId });
      return;
    }
    await options.deleteSession(sessionId);
    options.releaseAgent(sessionId);
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  if (request.method === "GET") {
    const historyMatch = /^\/api\/sessions\/([^/]+)\/history$/.exec(url.pathname);
    if (historyMatch) {
      const sessionId = requireSessionId(decodePathSegment(historyMatch[1] ?? ""));
      writeJson(response, 200, await options.loadHistory(sessionId));
      return;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJsonObject(request);
    const sessionId = requireSessionId(body.sessionId);
    const message = requireMessage(body.message);
    await handleChat(
      response,
      sessionId,
      message,
      options,
      busySessions,
      pendingConfirmations,
      confirmationTimeoutMs,
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/confirm") {
    const body = await readJsonObject(request);
    if (typeof body.requestId !== "string" || typeof body.approved !== "boolean") {
      throw new HttpError(400, "requestId and approved are required");
    }
    const sessionId = requireSessionId(body.sessionId);
    const pending = pendingConfirmations.get(body.requestId);
    if (!pending || pending.sessionId !== sessionId) {
      throw new HttpError(404, "confirmation request not found or already settled");
    }
    pending.settle(body.approved);
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
    return;
  }

  throw new HttpError(404, "not found");
}

async function handleChat(
  response: ServerResponse,
  sessionId: string,
  message: string,
  options: WebServerOptions,
  busySessions: Set<string>,
  pendingConfirmations: Map<string, PendingConfirmation>,
  confirmationTimeoutMs: number,
): Promise<void> {
  if (busySessions.has(sessionId)) {
    throw new HttpError(409, `session ${sessionId} already has a running turn`);
  }
  // 在异步加载 Agent 前先占用 session，防止两个首次请求同时加载并各自写同一个 JSONL。
  busySessions.add(sessionId);

  let agent: AgentRunner;
  try {
    agent = await options.getAgent(sessionId);
  } catch (error) {
    busySessions.delete(sessionId);
    throw error;
  }
  if (response.destroyed) {
    busySessions.delete(sessionId);
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.write(": connected\n\n");

  const localConfirmationIds = new Set<string>();
  let disconnected = false;
  response.once("close", () => {
    if (response.writableEnded) return;
    disconnected = true;
    denyOutstandingConfirmations(localConfirmationIds, pendingConfirmations);
  });

  const onEvent: AgentEventHandler = (event) => {
    sendSse(response, { type: "agent_event", event });
  };
  const confirmTool: ToolConfirmationHandler = (request) => new Promise<boolean>((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const timer = setTimeout(() => settle(false), confirmationTimeoutMs);
    const settle = (approved: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingConfirmations.delete(requestId);
      localConfirmationIds.delete(requestId);
      resolve(approved);
    };
    pendingConfirmations.set(requestId, { sessionId, settle });
    localConfirmationIds.add(requestId);
    sendSse(response, { type: "confirmation_required", requestId, request });
    if (disconnected || response.writableEnded || response.destroyed) settle(false);
  });

  try {
    const result = await agent.runTurn(message, onEvent, confirmTool);
    sendSse(response, { type: "done", stopReason: result.stopReason });
  } catch (error) {
    sendSse(response, { type: "error", message: formatRuntimeError(error) });
  } finally {
    denyOutstandingConfirmations(localConfirmationIds, pendingConfirmations);
    busySessions.delete(sessionId);
    if (!response.writableEnded) response.end();
  }
}

function denyOutstandingConfirmations(
  ids: Set<string>,
  pendingConfirmations: Map<string, PendingConfirmation>,
): void {
  for (const id of [...ids]) pendingConfirmations.get(id)?.settle(false);
}

function sendSse(response: ServerResponse, payload: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new HttpError(413, "request body is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (!isRecord(value)) throw new HttpError(400, "request body must be a JSON object");
  return value;
}

function requireSessionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, "sessionId may only contain letters, numbers, underscores, and hyphens");
  }
  return value;
}

function requireMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "message must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > 32 * 1024) {
    throw new HttpError(400, "message must not exceed 32768 bytes");
  }
  return value;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "sessionId path encoding is invalid");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
