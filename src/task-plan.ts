import fs from "node:fs/promises";
import path from "node:path";

export const MAX_TASK_PLAN_STEPS = 20;
export const MAX_TASK_PLAN_STEP_BYTES = 1000;
export const MAX_TASK_PLAN_FILE_BYTES = 32 * 1024;

export type TaskPlanStatus = "pending" | "in_progress" | "completed";

export interface TaskPlanStep {
  content: string;
  status: TaskPlanStatus;
}

export interface TaskPlan {
  version: 1;
  updatedAt: string;
  steps: TaskPlanStep[];
}

/**
 * tools.ts 依赖的窄接口。模型只能提交步骤列表，不能控制保存位置、版本或更新时间。
 */
export interface TaskPlanToolService {
  updatePlan(steps: readonly TaskPlanStep[]): Promise<TaskPlan>;
  loadPlan(): Promise<TaskPlan | undefined>;
}

/**
 * 每个 Provider/Session 对应一份独立计划文件。
 *
 * 计划不写进 Provider 原生 JSONL，避免 OpenAI/Anthropic 在恢复历史时读到非协议对象。
 * Store 不缓存内容，每次读取都以磁盘为准；队列只负责串行化同一实例的并发读写。
 */
export class TaskPlanStore implements TaskPlanToolService {
  private readonly filePath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    dataRoot: string,
    private readonly sessionId: string,
    namespace: string,
  ) {
    validatePlanIdentifier(sessionId, "session id");
    validatePlanIdentifier(namespace, "plan namespace");
    this.filePath = getTaskPlanFilePath(dataRoot, sessionId, namespace);
  }

  loadPlan(): Promise<TaskPlan | undefined> {
    return this.serialize(() => loadTaskPlanFile(this.filePath));
  }

  updatePlan(steps: readonly TaskPlanStep[]): Promise<TaskPlan> {
    return this.serialize(async () => {
      const normalizedSteps = validateTaskPlanSteps(steps);
      const plan: TaskPlan = {
        version: 1,
        updatedAt: new Date().toISOString(),
        steps: normalizedSteps,
      };
      const content = `${JSON.stringify(plan, null, 2)}\n`;
      if (Buffer.byteLength(content, "utf8") > MAX_TASK_PLAN_FILE_BYTES) {
        throw new Error(`task plan is too large; maximum is ${MAX_TASK_PLAN_FILE_BYTES} bytes`);
      }

      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        // 临时文件与目标同目录，完整写入后再 rename，进程中断不会留下半截 JSON。
        await fs.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
        await rejectSymbolicLinkTarget(this.filePath);
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
      return plan;
    });
  }

  clearPlan(): Promise<boolean> {
    return this.serialize(() => deleteTaskPlanFile(this.filePath, this.sessionId));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // 前一次失败不能让队列永久 rejected；后续 /plan 或模型更新仍应可以重试。
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function formatTaskPlan(plan?: TaskPlan): string {
  if (!plan) return "[Plan] 当前 Session 暂无任务计划。";
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const lines = [`[Plan] ${completed}/${plan.steps.length} completed`];
  for (const step of plan.steps) {
    const marker = step.status === "completed" ? "✓" : step.status === "in_progress" ? "→" : " ";
    lines.push(`  [${marker}] ${step.content}`);
  }
  return lines.join("\n");
}

/** Session 重命名时同步移动计划；返回 false 表示旧 Session 尚未创建计划。 */
export async function renameTaskPlan(
  dataRoot: string,
  oldSessionId: string,
  newSessionId: string,
  namespace: string,
): Promise<boolean> {
  validatePlanIdentifier(oldSessionId, "session id");
  validatePlanIdentifier(newSessionId, "session id");
  validatePlanIdentifier(namespace, "plan namespace");
  const source = getTaskPlanFilePath(dataRoot, oldSessionId, namespace);
  const target = getTaskPlanFilePath(dataRoot, newSessionId, namespace);
  const sourceStat = await lstatIfExists(source);
  const targetStat = await lstatIfExists(target);
  // 即使旧 Session 没有计划，也不能悄悄让新 Session 接管一个孤立的同名计划。
  if (!sourceStat) {
    if (targetStat) throw new Error(`task plan already exists: ${newSessionId}`);
    return false;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`task plan is not a regular file: ${oldSessionId}`);
  }
  if (targetStat) throw new Error(`task plan already exists: ${newSessionId}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    // 与 Session JSONL 一样先创建排他硬链接，目标存在时绝不覆盖。
    await fs.link(source, target);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`task plan already exists: ${newSessionId}`);
    }
    throw error;
  }
  try {
    await fs.unlink(source);
    return true;
  } catch (error) {
    await fs.unlink(target).catch(() => undefined);
    throw error;
  }
}

/** Session 删除时清理其计划；没有计划属于正常情况。 */
export async function deleteTaskPlan(
  dataRoot: string,
  sessionId: string,
  namespace: string,
): Promise<boolean> {
  validatePlanIdentifier(sessionId, "session id");
  validatePlanIdentifier(namespace, "plan namespace");
  return deleteTaskPlanFile(getTaskPlanFilePath(dataRoot, sessionId, namespace), sessionId);
}

function validateTaskPlanSteps(steps: readonly TaskPlanStep[]): TaskPlanStep[] {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_TASK_PLAN_STEPS) {
    throw new Error(`task plan requires between 1 and ${MAX_TASK_PLAN_STEPS} steps`);
  }

  let inProgress = 0;
  const normalized = steps.map((step, index): TaskPlanStep => {
    if (!isRecord(step) || typeof step.content !== "string") {
      throw new Error(`task plan step ${index + 1} requires string content`);
    }
    const content = step.content.trim();
    if (content.length === 0) throw new Error(`task plan step ${index + 1} must not be empty`);
    if (Buffer.byteLength(content, "utf8") > MAX_TASK_PLAN_STEP_BYTES) {
      throw new Error(
        `task plan step ${index + 1} is too large; maximum is ${MAX_TASK_PLAN_STEP_BYTES} bytes`,
      );
    }
    if (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed") {
      throw new Error(`task plan step ${index + 1} has an invalid status`);
    }
    if (step.status === "in_progress") inProgress += 1;
    return { content, status: step.status };
  });
  if (inProgress > 1) throw new Error("task plan may contain at most one in_progress step");
  return normalized;
}

async function loadTaskPlanFile(filePath: string): Promise<TaskPlan | undefined> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) throw new Error("task plan must not be a symbolic link");
  if (!stat.isFile()) throw new Error("task plan must be a regular file");
  if (stat.size > MAX_TASK_PLAN_FILE_BYTES) {
    throw new Error(`task plan is too large; maximum is ${MAX_TASK_PLAN_FILE_BYTES} bytes`);
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.length > MAX_TASK_PLAN_FILE_BYTES) {
    throw new Error(`task plan is too large; maximum is ${MAX_TASK_PLAN_FILE_BYTES} bytes`);
  }
  if (buffer.includes(0)) throw new Error("task plan must be UTF-8 JSON");

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("task plan must contain valid UTF-8 JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("task plan must contain valid JSON");
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.updatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed.updatedAt)
  ) {
    throw new Error("task plan has an unsupported format");
  }
  if (!Array.isArray(parsed.steps)) throw new Error("task plan has an unsupported format");
  return {
    version: 1,
    updatedAt: parsed.updatedAt,
    steps: validateTaskPlanSteps(parsed.steps as TaskPlanStep[]),
  };
}

async function deleteTaskPlanFile(filePath: string, sessionId: string): Promise<boolean> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`task plan is not a regular file: ${sessionId}`);
  }
  await fs.unlink(filePath);
  return true;
}

async function rejectSymbolicLinkTarget(filePath: string): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (stat?.isSymbolicLink()) throw new Error("task plan must not be a symbolic link");
  if (stat && !stat.isFile()) throw new Error("task plan must be a regular file");
}

function getTaskPlanFilePath(dataRoot: string, sessionId: string, namespace: string): string {
  return path.join(dataRoot, "plans", namespace, `${sessionId}.json`);
}

function validatePlanIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} may only contain letters, numbers, underscores, and hyphens`);
  }
}

async function lstatIfExists(targetPath: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
