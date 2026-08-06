import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool, requiresToolConfirmation } from "../src/tools.js";

describe("tools", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-tools-"));
  });

  it("reads text files inside the workspace", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool("read_text_file", { path: "note.txt" }, { workspaceRoot })).resolves.toBe("hello");
  });

  it("rejects paths outside the workspace", async () => {
    await expect(executeTool("read_text_file", { path: "../secret.txt" }, { workspaceRoot })).rejects.toThrow("workspace");
  });

  it("rejects absolute paths", async () => {
    await expect(executeTool("read_text_file", { path: path.resolve(workspaceRoot, "note.txt") }, { workspaceRoot })).rejects.toThrow("relative");
  });

  it("creates UTF-8 text files inside the workspace", async () => {
    const result = await executeTool(
      "write_text_file",
      { path: "hello.txt", content: "你好" },
      { workspaceRoot },
    );

    expect(JSON.parse(result)).toEqual({
      path: "hello.txt",
      bytes: 6,
      created: true,
    });
    await expect(fs.readFile(path.join(workspaceRoot, "hello.txt"), "utf8")).resolves.toBe("你好");
  });

  it("overwrites existing text files", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "old", "utf8");

    const result = await executeTool(
      "write_text_file",
      { path: "note.txt", content: "new" },
      { workspaceRoot },
    );

    expect(JSON.parse(result)).toEqual({
      path: "note.txt",
      bytes: 3,
      created: false,
    });
    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("new");
  });

  it("rejects writes outside the workspace", async () => {
    await expect(executeTool(
      "write_text_file",
      { path: "../outside.txt", content: "no" },
      { workspaceRoot },
    )).rejects.toThrow("workspace");
  });

  it("rejects absolute write paths", async () => {
    await expect(executeTool(
      "write_text_file",
      { path: path.resolve(workspaceRoot, "note.txt"), content: "no" },
      { workspaceRoot },
    )).rejects.toThrow("relative");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic link write targets", async () => {
    const outsideFile = path.join(os.tmpdir(), `openclaw-outside-${process.pid}.txt`);
    await fs.writeFile(outsideFile, "outside", "utf8");
    await fs.symlink(outsideFile, path.join(workspaceRoot, "link.txt"));

    await expect(executeTool(
      "write_text_file",
      { path: "link.txt", content: "no" },
      { workspaceRoot },
    )).rejects.toThrow("symbolic link");
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await fs.unlink(outsideFile);
  });

  it("rejects writes larger than 1 MiB", async () => {
    await expect(executeTool(
      "write_text_file",
      { path: "large.txt", content: "x".repeat(1024 * 1024 + 1) },
      { workspaceRoot },
    )).rejects.toThrow("too large");
  });

  it("requires an existing parent directory for new files", async () => {
    await expect(executeTool(
      "write_text_file",
      { path: "missing/note.txt", content: "hello" },
      { workspaceRoot },
    )).rejects.toThrow("parent directory");
  });

  it("edits one uniquely matching text block", async () => {
    await fs.writeFile(path.join(workspaceRoot, "config.txt"), "name=demo\nport=3000\n", "utf8");

    const result = await executeTool(
      "edit_text_file",
      { path: "config.txt", old_text: "port=3000", new_text: "port=8080" },
      { workspaceRoot },
    );

    expect(JSON.parse(result)).toEqual({
      path: "config.txt",
      replacements: 1,
      line: 2,
      column: 1,
      bytes: 20,
    });
    await expect(fs.readFile(path.join(workspaceRoot, "config.txt"), "utf8"))
      .resolves.toBe("name=demo\nport=8080\n");
  });

  it("rejects edits when old_text is not found", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool(
      "edit_text_file",
      { path: "note.txt", old_text: "missing", new_text: "new" },
      { workspaceRoot },
    )).rejects.toThrow("not found");
    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("hello");
  });

  it("rejects edits when old_text occurs more than once", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello hello", "utf8");

    await expect(executeTool(
      "edit_text_file",
      { path: "note.txt", old_text: "hello", new_text: "hi" },
      { workspaceRoot },
    )).rejects.toThrow("more than once");
    await expect(fs.readFile(path.join(workspaceRoot, "note.txt"), "utf8")).resolves.toBe("hello hello");
  });

  it("rejects an empty old_text", async () => {
    await expect(executeTool(
      "edit_text_file",
      { path: "note.txt", old_text: "", new_text: "hello" },
      { workspaceRoot },
    )).rejects.toThrow("must not be empty");
  });

  it("rejects edits of missing files", async () => {
    await expect(executeTool(
      "edit_text_file",
      { path: "missing.txt", old_text: "old", new_text: "new" },
      { workspaceRoot },
    )).rejects.toThrow("does not exist");
  });

  it("rejects edits whose result exceeds 1 MiB", async () => {
    const content = `${"x".repeat(1024 * 1024 - 1)}a`;
    await fs.writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");

    await expect(executeTool(
      "edit_text_file",
      { path: "large.txt", old_text: "a", new_text: "abc" },
      { workspaceRoot },
    )).rejects.toThrow("too large");
    await expect(fs.stat(path.join(workspaceRoot, "large.txt")))
      .resolves.toMatchObject({ size: 1024 * 1024 });
  });

  it("lists one directory level with sorted entry metadata", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs"));
    await fs.writeFile(path.join(workspaceRoot, "z.txt"), "hello", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "a.txt"), "ok", "utf8");

    const output = await executeTool("list_directory", { path: "." }, { workspaceRoot });

    expect(JSON.parse(output)).toEqual({
      path: ".",
      entries: [
        { name: "a.txt", type: "file", size: 2 },
        { name: "docs", type: "directory" },
        { name: "z.txt", type: "file", size: 5 },
      ],
      truncated: false,
    });
  });

  it("lists a nested directory without recursing", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "note.txt"), "hello", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "docs", "nested", "hidden.txt"), "hidden", "utf8");

    const output = await executeTool("list_directory", { path: "docs" }, { workspaceRoot });

    expect(JSON.parse(output)).toEqual({
      path: "docs",
      entries: [
        { name: "nested", type: "directory" },
        { name: "note.txt", type: "file", size: 5 },
      ],
      truncated: false,
    });
  });

  it("rejects directory paths outside the workspace", async () => {
    await expect(executeTool("list_directory", { path: ".." }, { workspaceRoot })).rejects.toThrow("workspace");
  });

  it("rejects files passed to list_directory", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool("list_directory", { path: "note.txt" }, { workspaceRoot })).rejects.toThrow("not a directory");
  });

  it("limits directory listings to 200 entries", async () => {
    await Promise.all(Array.from({ length: 201 }, (_, index) =>
      fs.writeFile(path.join(workspaceRoot, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8")
    ));

    const output = JSON.parse(await executeTool("list_directory", { path: "." }, { workspaceRoot })) as {
      entries: unknown[];
      truncated: boolean;
    };

    expect(output.entries).toHaveLength(200);
    expect(output.truncated).toBe(true);
  });

  it("runs calculator operations", async () => {
    await expect(executeTool("calculator", { operation: "multiply", a: 12, b: 7 }, { workspaceRoot })).resolves.toBe("84");
  });

  it("rejects division by zero", async () => {
    await expect(executeTool("calculator", { operation: "divide", a: 1, b: 0 }, { workspaceRoot })).rejects.toThrow("division by zero");
  });

  it("rejects unknown tools", async () => {
    await expect(executeTool("shell", {}, { workspaceRoot })).rejects.toThrow("Unknown tool");
  });

  it("requires confirmation by default except for registered safe tools", () => {
    expect(requiresToolConfirmation("calculator")).toBe(false);
    expect(requiresToolConfirmation("list_directory")).toBe(false);
    expect(requiresToolConfirmation("read_text_file")).toBe(false);
    expect(requiresToolConfirmation("write_text_file")).toBe(true);
    expect(requiresToolConfirmation("edit_text_file")).toBe(true);
    expect(requiresToolConfirmation("shell")).toBe(true);
  });
});
