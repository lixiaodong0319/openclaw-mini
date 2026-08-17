import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  WorkspaceMemoryConsolidator,
  formatMemoryConsolidationPreview,
} from "../src/memory-consolidation.js";

describe("WorkspaceMemoryConsolidator", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-consolidate-"));
    await fs.mkdir(path.join(workspaceRoot, "memory"));
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "# 偏好\n\n- 喜欢 TypeScript\n", "utf8");
    await fs.writeFile(
      path.join(workspaceRoot, "memory", "2026-08-17.md"),
      "# 今日\n\n用户确认后端统一使用 TypeScript。\n临时构建错误已经解决。\n",
      "utf8",
    );
  });

  it("builds a full replacement proposal and applies it without deleting daily memory", async () => {
    const onApplied = vi.fn();
    const consolidator = new WorkspaceMemoryConsolidator(workspaceRoot, onApplied);
    const generate = vi.fn(async (_request: string) => (
      "```markdown\n# 长期偏好\n\n- 后端统一使用 TypeScript\n```"
    ));

    const plan = await consolidator.prepare(generate);

    expect(plan).toBeDefined();
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0]).toContain("memory/2026-08-17.md");
    expect(generate.mock.calls[0]?.[0]).toContain("临时构建错误已经解决");
    expect(formatMemoryConsolidationPreview(plan!)).toContain("[建议完整替换 MEMORY.md]");

    const result = await consolidator.apply(plan!);

    expect(result.path).toBe("MEMORY.md");
    expect(onApplied).toHaveBeenCalledOnce();
    await expect(fs.readFile(path.join(workspaceRoot, "MEMORY.md"), "utf8"))
      .resolves.toBe("# 长期偏好\n\n- 后端统一使用 TypeScript\n");
    await expect(fs.readFile(path.join(workspaceRoot, "memory", "2026-08-17.md"), "utf8"))
      .resolves.toContain("临时构建错误已经解决");
  });

  it("returns no plan when the model reports no durable changes", async () => {
    const consolidator = new WorkspaceMemoryConsolidator(workspaceRoot);

    await expect(consolidator.prepare(async () => "NO_CHANGES")).resolves.toBeUndefined();
  });

  it("refuses to overwrite MEMORY.md when it changed after preview", async () => {
    const consolidator = new WorkspaceMemoryConsolidator(workspaceRoot);
    const plan = await consolidator.prepare(async () => "# 新提案\n");
    await fs.writeFile(path.join(workspaceRoot, "MEMORY.md"), "# 用户刚刚手工修改\n", "utf8");

    await expect(consolidator.apply(plan!)).rejects.toThrow("changed after preview");
    await expect(fs.readFile(path.join(workspaceRoot, "MEMORY.md"), "utf8"))
      .resolves.toBe("# 用户刚刚手工修改\n");
  });

  it("rejects a proposal that appears to contain credentials", async () => {
    const consolidator = new WorkspaceMemoryConsolidator(workspaceRoot);

    await expect(consolidator.prepare(async () => (
      "# 凭据\n\n- api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456\n"
    ))).rejects.toThrow("credential");
  });

  it("does not call the model when there are no daily memories", async () => {
    await fs.rm(path.join(workspaceRoot, "memory"), { recursive: true });
    const generate = vi.fn(async () => "# 不应生成\n");
    const consolidator = new WorkspaceMemoryConsolidator(workspaceRoot);

    await expect(consolidator.prepare(generate)).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });
});
