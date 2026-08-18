import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatTaskPlan, TaskPlanStore } from "../src/task-plan.js";

describe("TaskPlanStore", () => {
  const roots: string[] = [];

  async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-"));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("persists and reloads a plan for one Provider Session", async () => {
    const root = await createRoot();
    const store = new TaskPlanStore(root, "demo", "openai");

    const saved = await store.updatePlan([
      { content: "分析代码", status: "completed" },
      { content: "实现功能", status: "in_progress" },
      { content: "运行测试", status: "pending" },
    ]);
    const reloaded = await new TaskPlanStore(root, "demo", "openai").loadPlan();

    expect(reloaded).toEqual(saved);
    expect(formatTaskPlan(reloaded)).toContain("[Plan] 1/3 completed");
    expect(formatTaskPlan(reloaded)).toContain("[→] 实现功能");
    await expect(new TaskPlanStore(root, "demo", "anthropic").loadPlan())
      .resolves.toBeUndefined();
  });

  it("serializes concurrent replacements and keeps the final update", async () => {
    const root = await createRoot();
    const store = new TaskPlanStore(root, "demo", "openai");

    await Promise.all([
      store.updatePlan([{ content: "first", status: "in_progress" }]),
      store.updatePlan([{ content: "second", status: "completed" }]),
    ]);

    expect((await store.loadPlan())?.steps).toEqual([{ content: "second", status: "completed" }]);
  });

  it("validates step count, text, status, and the single in-progress invariant", async () => {
    const root = await createRoot();
    const store = new TaskPlanStore(root, "demo", "openai");

    await expect(store.updatePlan([])).rejects.toThrow("between 1 and 20");
    await expect(store.updatePlan([{ content: " ", status: "pending" }]))
      .rejects.toThrow("must not be empty");
    await expect(store.updatePlan([
      { content: "one", status: "in_progress" },
      { content: "two", status: "in_progress" },
    ])).rejects.toThrow("at most one in_progress");
    await expect(store.updatePlan([{
      content: "invalid",
      status: "running" as "pending",
    }])).rejects.toThrow("invalid status");
  });

  it("clears an existing plan idempotently", async () => {
    const root = await createRoot();
    const store = new TaskPlanStore(root, "demo", "openai");
    await store.updatePlan([{ content: "work", status: "pending" }]);

    await expect(store.clearPlan()).resolves.toBe(true);
    await expect(store.loadPlan()).resolves.toBeUndefined();
    await expect(store.clearPlan()).resolves.toBe(false);
    expect(formatTaskPlan()).toContain("暂无任务计划");
  });

  it("rejects corrupted, oversized, and symbolic-link plan files", async () => {
    const root = await createRoot();
    const planDirectory = path.join(root, "plans", "openai");
    const planPath = path.join(planDirectory, "demo.json");
    await fs.mkdir(planDirectory, { recursive: true });
    const store = new TaskPlanStore(root, "demo", "openai");

    await fs.writeFile(planPath, "not json", "utf8");
    await expect(store.loadPlan()).rejects.toThrow("valid JSON");

    await fs.writeFile(planPath, Buffer.alloc(32 * 1024 + 1, 0x61));
    await expect(store.loadPlan()).rejects.toThrow("too large");

    if (process.platform !== "win32") {
      await fs.unlink(planPath);
      const target = path.join(root, "target.json");
      await fs.writeFile(target, "{}", "utf8");
      await fs.symlink(target, planPath);
      await expect(store.loadPlan()).rejects.toThrow("symbolic link");
    }
  });
});
