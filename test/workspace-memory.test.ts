import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_MEMORY_BOOTSTRAP_BYTES,
  MAX_DAILY_MEMORY_BOOTSTRAP_BYTES,
  describeWorkspaceMemory,
  loadRecentDailyMemories,
  loadWorkspaceMemoryContext,
  loadWorkspaceMemory,
} from "../src/workspace-memory.js";

describe("workspace MEMORY.md", () => {
  const roots: string[] = [];

  async function createWorkspace(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-md-"));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("returns undefined when MEMORY.md does not exist", async () => {
    await expect(loadWorkspaceMemory(await createWorkspace())).resolves.toBeUndefined();
    expect(describeWorkspaceMemory()).toBe("not found");
  });

  it("loads Markdown without interpreting its structure", async () => {
    const root = await createWorkspace();
    const content = "# 长期记忆\n\n- 使用 TypeScript\n";
    await fs.writeFile(path.join(root, "MEMORY.md"), content, "utf8");

    const memory = await loadWorkspaceMemory(root);
    expect(memory).toEqual({
      relativePath: "MEMORY.md",
      content,
      bytes: Buffer.byteLength(content),
      injectedBytes: Buffer.byteLength(content),
      truncated: false,
    });
    expect(describeWorkspaceMemory(memory)).toContain("MEMORY.md");
  });

  it("truncates only the injected copy at a valid UTF-8 boundary", async () => {
    const root = await createWorkspace();
    const content = `${"a".repeat(MAX_MEMORY_BOOTSTRAP_BYTES - 1)}中文尾部`;
    await fs.writeFile(path.join(root, "MEMORY.md"), content, "utf8");

    const memory = await loadWorkspaceMemory(root);
    expect(memory?.truncated).toBe(true);
    expect(memory?.injectedBytes).toBeLessThanOrEqual(MAX_MEMORY_BOOTSTRAP_BYTES);
    expect(memory?.content).not.toContain("�");
    expect(await fs.readFile(path.join(root, "MEMORY.md"), "utf8")).toBe(content);
  });

  it("rejects invalid UTF-8, NUL bytes, and directories", async () => {
    const root = await createWorkspace();
    const memoryPath = path.join(root, "MEMORY.md");
    await fs.writeFile(memoryPath, Buffer.from([0xc3, 0x28]));
    await expect(loadWorkspaceMemory(root)).rejects.toThrow("valid UTF-8");
    await fs.writeFile(memoryPath, Buffer.from([0x61, 0x00, 0x62]));
    await expect(loadWorkspaceMemory(root)).rejects.toThrow("UTF-8 text file");
    await fs.rm(memoryPath);
    await fs.mkdir(memoryPath);
    await expect(loadWorkspaceMemory(root)).rejects.toThrow("regular file");
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic link", async () => {
    const root = await createWorkspace();
    const target = path.join(root, "target.md");
    await fs.writeFile(target, "memory", "utf8");
    await fs.symlink(target, path.join(root, "MEMORY.md"));
    await expect(loadWorkspaceMemory(root)).rejects.toThrow("symbolic link");
  });

  it("loads today, yesterday, and slugged variants but ignores older notes", async () => {
    const root = await createWorkspace();
    const directory = path.join(root, "memory");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "2026-08-13.md"), "today base", "utf8");
    await fs.writeFile(path.join(directory, "2026-08-13-session-a.md"), "today slug", "utf8");
    await fs.writeFile(path.join(directory, "2026-08-12.md"), "yesterday", "utf8");
    await fs.writeFile(path.join(directory, "2026-08-11.md"), "old", "utf8");
    await fs.writeFile(path.join(directory, "2026-08-13 bad.md"), "invalid slug", "utf8");

    const context = await loadWorkspaceMemoryContext(root, new Date(2026, 7, 13, 12));
    expect(context.daily.map((memory) => memory.relativePath)).toEqual([
      "memory/2026-08-12.md",
      "memory/2026-08-13.md",
      "memory/2026-08-13-session-a.md",
    ]);
    expect(context.discoveredDailyFiles).toBe(3);
    expect(context.today).toBe("2026-08-13");
    expect(context.yesterday).toBe("2026-08-12");
  });

  it("shares a bounded injection budget across recent daily files", async () => {
    const root = await createWorkspace();
    const directory = path.join(root, "memory");
    await fs.mkdir(directory);
    await fs.writeFile(
      path.join(directory, "2026-08-13.md"),
      "t".repeat(MAX_DAILY_MEMORY_BOOTSTRAP_BYTES - 10),
      "utf8",
    );
    await fs.writeFile(path.join(directory, "2026-08-12.md"), "y".repeat(100), "utf8");

    const result = await loadRecentDailyMemories(root, new Date(2026, 7, 13, 12));
    expect(result.memories.reduce((sum, memory) => sum + memory.injectedBytes, 0))
      .toBeLessThanOrEqual(MAX_DAILY_MEMORY_BOOTSTRAP_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.memories.find((memory) => memory.date === "2026-08-13")?.injectedBytes)
      .toBe(MAX_DAILY_MEMORY_BOOTSTRAP_BYTES - 10);
  });

  it("rejects an invalid daily memory directory", async () => {
    const root = await createWorkspace();
    await fs.writeFile(path.join(root, "memory"), "not a directory", "utf8");
    await expect(loadRecentDailyMemories(root, new Date(2026, 7, 13)))
      .rejects.toThrow("must be a directory");
  });
});
