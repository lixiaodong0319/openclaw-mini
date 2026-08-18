import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceMemoryFlusher } from "../src/memory-flush.js";

describe("WorkspaceMemoryFlusher", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-"));
  });

  it("appends a compaction summary to today's daily Markdown", async () => {
    const now = new Date(2026, 7, 17, 9, 8, 7);
    const flusher = new WorkspaceMemoryFlusher(workspaceRoot, () => now);

    const result = await flusher.flush("用户选择 TypeScript。\n尚未完成发布流程。");

    expect(result).toEqual({
      path: "memory/2026-08-17.md",
      written: true,
      bytesWritten: expect.any(Number),
    });
    const content = await fs.readFile(
      path.join(workspaceRoot, "memory", "2026-08-17.md"),
      "utf8",
    );
    expect(content).toContain("# 2026-08-17");
    expect(content).toContain("## 压缩前会话记忆 09:08:07");
    expect(content).toContain("用户选择 TypeScript。\n尚未完成发布流程。");
    expect(content).toMatch(/openclaw:memory-flush:[a-f0-9]{64}/u);
  });

  it("preserves handwritten content and skips an identical summary", async () => {
    const memoryDirectory = path.join(workspaceRoot, "memory");
    await fs.mkdir(memoryDirectory);
    const filePath = path.join(memoryDirectory, "2026-08-17.md");
    await fs.writeFile(filePath, "# 手工记录\n\n不要覆盖。\n", "utf8");
    const flusher = new WorkspaceMemoryFlusher(
      workspaceRoot,
      () => new Date(2026, 7, 17, 10, 0, 0),
    );

    const first = await flusher.flush("同一份压缩摘要");
    const second = await flusher.flush("  同一份压缩摘要  ");

    expect(first.written).toBe(true);
    expect(second).toEqual({
      path: "memory/2026-08-17.md",
      written: false,
      bytesWritten: 0,
    });
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("# 手工记录\n\n不要覆盖。");
    expect(content.match(/同一份压缩摘要/gu)).toHaveLength(1);
  });

  it("serializes concurrent writes without losing either summary", async () => {
    const flusher = new WorkspaceMemoryFlusher(
      workspaceRoot,
      () => new Date(2026, 7, 17, 11, 0, 0),
    );

    await Promise.all([
      flusher.flush("第一个并发摘要"),
      flusher.flush("第二个并发摘要"),
    ]);

    const content = await fs.readFile(
      path.join(workspaceRoot, "memory", "2026-08-17.md"),
      "utf8",
    );
    expect(content).toContain("第一个并发摘要");
    expect(content).toContain("第二个并发摘要");
  });

  it("rejects a symbolic-link memory directory", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-flush-outside-"));
    try {
      await fs.symlink(outside, path.join(workspaceRoot, "memory"), "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const flusher = new WorkspaceMemoryFlusher(workspaceRoot);

    await expect(flusher.flush("不能写到 workspace 外")).rejects.toThrow("symbolic link");
  });
});
