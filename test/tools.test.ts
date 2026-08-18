import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  executeTool,
  openAIToolDefinitions,
  requiresToolConfirmation,
  toolDefinitions,
} from "../src/tools.js";

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

  it("creates nested directories inside the workspace", async () => {
    const result = await executeTool(
      "create_directory",
      { path: "src/components" },
      { workspaceRoot },
    );

    expect(JSON.parse(result)).toEqual({
      path: "src/components",
      created: true,
    });
    expect((await fs.stat(path.join(workspaceRoot, "src", "components"))).isDirectory()).toBe(true);
  });

  it("treats creating an existing directory as an idempotent success", async () => {
    await fs.mkdir(path.join(workspaceRoot, "docs"));

    const result = await executeTool("create_directory", { path: "docs" }, { workspaceRoot });

    expect(JSON.parse(result)).toEqual({ path: "docs", created: false });
  });

  it("rejects invalid directory creation paths", async () => {
    await expect(executeTool("create_directory", { path: "../outside" }, { workspaceRoot }))
      .rejects.toThrow("workspace");
    await expect(executeTool(
      "create_directory",
      { path: path.resolve(workspaceRoot, "absolute") },
      { workspaceRoot },
    )).rejects.toThrow("relative");
    await expect(executeTool("create_directory", { path: "   " }, { workspaceRoot }))
      .rejects.toThrow("must not be empty");
  });

  it("rejects files used as directory targets or parents", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "hello", "utf8");

    await expect(executeTool("create_directory", { path: "note.txt" }, { workspaceRoot }))
      .rejects.toThrow("not a directory");
    await expect(executeTool("create_directory", { path: "note.txt/nested" }, { workspaceRoot }))
      .rejects.toThrow("not a directory");
  });

  it.skipIf(process.platform === "win32")("rejects directory creation through escaping symbolic links", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-directory-"));
    try {
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked"));

      await expect(executeTool(
        "create_directory",
        { path: "linked/nested" },
        { workspaceRoot },
      )).rejects.toThrow("outside the workspace");
      await expect(fs.stat(path.join(outsideRoot, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
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

  it("finds workspace files recursively by glob", async () => {
    await fs.mkdir(path.join(workspaceRoot, "nested"));
    await fs.writeFile(path.join(workspaceRoot, "root.test.ts"), "", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "nested", "agent.test.ts"), "", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "nested", "agent.ts"), "", "utf8");

    const output = JSON.parse(await executeTool(
      "find_files",
      { path: ".", pattern: "**/*.test.ts", max_results: null },
      { workspaceRoot },
    ));

    expect(output).toEqual({
      path: ".",
      pattern: "**/*.test.ts",
      files: ["root.test.ts", "nested/agent.test.ts"],
      truncated: false,
    });
  });

  it("scopes file discovery to the requested directory", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "outside.ts"), "", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "index.ts"), "", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "nested", "config.ts"), "", "utf8");

    const output = JSON.parse(await executeTool(
      "find_files",
      { path: "src", pattern: "**/*.ts", max_results: 10 },
      { workspaceRoot },
    )) as { path: string; files: string[] };

    expect(output.path).toBe("src");
    expect(output.files).toEqual(["src/index.ts", "src/nested/config.ts"]);
  });

  it("limits discovered files and reports truncation", async () => {
    await Promise.all(["a.ts", "b.ts", "c.ts"].map((name) =>
      fs.writeFile(path.join(workspaceRoot, name), "", "utf8")
    ));

    const output = JSON.parse(await executeTool(
      "find_files",
      { path: ".", pattern: "*.ts", max_results: 2 },
      { workspaceRoot },
    )) as { files: string[]; truncated: boolean };

    expect(output.files).toEqual(["a.ts", "b.ts"]);
    expect(output.truncated).toBe(true);
  });

  it.skipIf(process.platform === "win32")("does not follow symbolic links while finding files", async () => {
    await fs.mkdir(path.join(workspaceRoot, "real"));
    await fs.writeFile(path.join(workspaceRoot, "real", "note.txt"), "", "utf8");
    await fs.symlink(path.join(workspaceRoot, "real"), path.join(workspaceRoot, "linked"));

    const output = JSON.parse(await executeTool(
      "find_files",
      { path: ".", pattern: "**/*.txt", max_results: null },
      { workspaceRoot },
    )) as { files: string[] };

    expect(output.files).toEqual(["real/note.txt"]);
  });

  it("validates file discovery paths, patterns, and limits", async () => {
    await expect(executeTool(
      "find_files",
      { path: "..", pattern: "**/*", max_results: null },
      { workspaceRoot },
    )).rejects.toThrow("workspace");
    await expect(executeTool(
      "find_files",
      { path: ".", pattern: "", max_results: null },
      { workspaceRoot },
    )).rejects.toThrow("must not be empty");
    await expect(executeTool(
      "find_files",
      { path: ".", pattern: "**/*", max_results: 501 },
      { workspaceRoot },
    )).rejects.toThrow("between 1 and 500");
  });

  it("searches text files recursively with line and column locations", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "README.md"), "OpenClaw Mini\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "agent.ts"), "first line\nconst name = 'OpenClaw';\n", "utf8");

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "OpenClaw", path: "." },
      { workspaceRoot },
    )) as {
      query: string;
      path: string;
      matches: Array<{ path: string; line: number; column: number; text: string }>;
      truncated: boolean;
    };

    expect(output).toEqual({
      query: "OpenClaw",
      path: ".",
      matches: [
        { path: "README.md", line: 1, column: 1, text: "OpenClaw Mini" },
        { path: "src/agent.ts", line: 2, column: 15, text: "const name = 'OpenClaw';" },
      ],
      truncated: false,
    });
  });

  it("filters searches by directory and workspace-relative glob", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "src", "agent.ts"), "needle", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "agent.js"), "needle", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "outside.ts"), "needle", "utf8");

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "needle", path: "src", file_pattern: "**/*.ts" },
      { workspaceRoot },
    )) as { path: string; file_pattern: string; matches: Array<{ path: string }> };

    expect(output.path).toBe("src");
    expect(output.file_pattern).toBe("**/*.ts");
    expect(output.matches).toEqual([{ path: "src/agent.ts", line: 1, column: 1, text: "needle" }]);
  });

  it("limits search results and reports truncation", async () => {
    await fs.writeFile(path.join(workspaceRoot, "matches.txt"), "hit\nhit\nhit\n", "utf8");

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "hit", path: ".", max_results: 2 },
      { workspaceRoot },
    )) as { matches: unknown[]; truncated: boolean };

    expect(output.matches).toHaveLength(2);
    expect(output.truncated).toBe(true);
  });

  it("uses search defaults when strict Provider arguments are null", async () => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "needle", "utf8");

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "needle", path: ".", file_pattern: null, max_results: null },
      { workspaceRoot },
    )) as { matches: unknown[]; truncated: boolean };

    expect(output.matches).toHaveLength(1);
    expect(output.truncated).toBe(false);
  });

  it("skips binary files while searching", async () => {
    await fs.writeFile(path.join(workspaceRoot, "binary.dat"), Buffer.from([110, 101, 101, 100, 108, 101, 0]));
    await fs.writeFile(path.join(workspaceRoot, "real.txt"), "needle", "utf8");

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "needle", path: "." },
      { workspaceRoot },
    )) as { matches: Array<{ path: string }> };

    expect(output.matches.map((match) => match.path)).toEqual(["real.txt"]);
  });

  it.skipIf(process.platform === "win32")("does not follow symbolic links while searching", async () => {
    await fs.writeFile(path.join(workspaceRoot, "real.txt"), "needle", "utf8");
    await fs.symlink(path.join(workspaceRoot, "real.txt"), path.join(workspaceRoot, "link.txt"));

    const output = JSON.parse(await executeTool(
      "search_files",
      { query: "needle", path: "." },
      { workspaceRoot },
    )) as { matches: Array<{ path: string }> };

    expect(output.matches.map((match) => match.path)).toEqual(["real.txt"]);
  });

  it("validates search paths and limits", async () => {
    await expect(executeTool("search_files", { query: "x", path: ".." }, { workspaceRoot }))
      .rejects.toThrow("workspace");
    await expect(executeTool("search_files", { query: "", path: "." }, { workspaceRoot }))
      .rejects.toThrow("must not be empty");
    await expect(executeTool(
      "search_files",
      { query: "x", path: ".", max_results: 201 },
      { workspaceRoot },
    )).rejects.toThrow("between 1 and 200");
  });

  it("runs calculator operations", async () => {
    await expect(executeTool("calculator", { operation: "multiply", a: 12, b: 7 }, { workspaceRoot })).resolves.toBe("84");
  });

  it("rejects division by zero", async () => {
    await expect(executeTool("calculator", { operation: "divide", a: 1, b: 0 }, { workspaceRoot })).rejects.toThrow("division by zero");
  });

  it("runs shell commands from the workspace and captures stdout", async () => {
    const output = JSON.parse(await executeTool(
      "run_command",
      { command: "echo 4" },
      { workspaceRoot },
    )) as {
      command: string;
      cwd: string;
      exit_code: number | null;
      signal: string | null;
      timed_out: boolean;
      stdout: string;
      stderr: string;
      stdout_truncated: boolean;
      stderr_truncated: boolean;
    };

    expect(output).toEqual({
      command: "echo 4",
      cwd: ".",
      exit_code: 0,
      signal: null,
      timed_out: false,
      stdout: `4${os.EOL}`,
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
    });
  });

  it("starts shell commands in the configured workspace", async () => {
    const output = JSON.parse(await executeTool(
      "run_command",
      { command: process.platform === "win32" ? "cd" : "pwd" },
      { workspaceRoot },
    )) as { stdout: string };

    expect(output.stdout.trim()).toBe(await fs.realpath(workspaceRoot));
  });

  it("returns non-zero exit codes and stderr without throwing", async () => {
    const output = JSON.parse(await executeTool(
      "run_command",
      { command: process.platform === "win32" ? "echo 123 1>&2 & exit /b 7" : "printf 123 >&2; exit 7" },
      { workspaceRoot },
    )) as { exit_code: number | null; stderr: string; timed_out: boolean };

    expect(output).toMatchObject({
      exit_code: 7,
      stderr: "123",
      timed_out: false,
    });
  });

  it("terminates shell commands after the configured timeout", async () => {
    const output = JSON.parse(await executeTool(
      "run_command",
      { command: process.platform === "win32" ? "ping -n 6 127.0.0.1 >nul" : "sleep 5" },
      { workspaceRoot, commandTimeoutMs: 50 },
    )) as { exit_code: number | null; signal: string | null; timed_out: boolean };

    expect(output.timed_out).toBe(true);
    expect(output.exit_code === null || output.exit_code !== 0).toBe(true);
  });

  it("truncates command output after 64 KiB", async () => {
    const output = JSON.parse(await executeTool(
      "run_command",
      {
        command: process.platform === "win32"
          ? 'powershell -NoProfile -Command "[Console]::Out.Write(\'1\' * 70000)"'
          : "awk 'BEGIN { for (i = 0; i < 70000; i++) printf \"1\" }'",
      },
      { workspaceRoot },
    )) as { stdout: string; stdout_truncated: boolean };

    expect(Buffer.byteLength(output.stdout, "utf8")).toBe(64 * 1024);
    expect(output.stdout_truncated).toBe(true);
  });

  it("does not pass API keys to command processes", async () => {
    const previousApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-secret-that-must-not-leak";
    try {
      const output = JSON.parse(await executeTool(
        "run_command",
        {
          command: process.platform === "win32"
            ? "if defined OPENAI_API_KEY (echo set) else (echo 0)"
            : "if [ -n \"${OPENAI_API_KEY:-}\" ]; then printf set; else printf 0; fi",
        },
        { workspaceRoot },
      )) as { stdout: string };

      expect(output.stdout.trim()).toBe("0");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it("rejects empty and oversized shell commands", async () => {
    await expect(executeTool("run_command", { command: "   " }, { workspaceRoot }))
      .rejects.toThrow("must not be empty");
    await expect(executeTool("run_command", { command: "x".repeat(8193) }, { workspaceRoot }))
      .rejects.toThrow("maximum is 8192 bytes");
  });

  it("rejects unknown tools", async () => {
    await expect(executeTool("shell", {}, { workspaceRoot })).rejects.toThrow("Unknown tool");
  });

  it("dispatches read-only memory tools through the runtime memory service", async () => {
    const memoryIndex = {
      search: vi.fn(async () => ({
        query: "TypeScript",
        results: [],
        indexedFiles: 1,
        indexedChunks: 1,
        searchMode: "keyword" as const,
      })),
      get: vi.fn(async () => ({
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        content: "TypeScript",
      })),
      scheduleSync: vi.fn(),
    };

    const searchOutput = JSON.parse(await executeTool(
      "memory_search",
      { query: "TypeScript", max_results: null },
      { workspaceRoot, memoryIndex },
    ));
    const getOutput = JSON.parse(await executeTool(
      "memory_get",
      { path: "MEMORY.md", from_line: null, lines: null },
      { workspaceRoot, memoryIndex },
    ));

    expect(searchOutput.indexedFiles).toBe(1);
    expect(memoryIndex.search).toHaveBeenCalledWith("TypeScript", 10);
    expect(getOutput.content).toBe("TypeScript");
    expect(memoryIndex.get).toHaveBeenCalledWith("MEMORY.md", 1, 80);
  });

  it("dispatches read_skill through the runtime skill service", async () => {
    const skills = {
      readSkill: vi.fn(async (name: string) => `[Skill] ${name}`),
    };

    await expect(executeTool(
      "read_skill",
      { name: "code-review" },
      { workspaceRoot, skills },
    )).resolves.toBe("[Skill] code-review");
    expect(skills.readSkill).toHaveBeenCalledWith("code-review");

    await expect(executeTool(
      "read_skill",
      { name: 123 },
      { workspaceRoot, skills },
    )).rejects.toThrow("string name");
    await expect(executeTool(
      "read_skill",
      { name: "code-review" },
      { workspaceRoot },
    )).rejects.toThrow("skill manager is not configured");
  });

  it("exposes read_skill to both Anthropic and OpenAI Providers", () => {
    expect(toolDefinitions).toContainEqual(expect.objectContaining({ name: "read_skill" }));
    expect(openAIToolDefinitions).toContainEqual(expect.objectContaining({
      type: "function",
      name: "read_skill",
      strict: true,
    }));
  });

  it("validates and dispatches auto-approved task plan updates", async () => {
    const taskPlan = {
      updatePlan: vi.fn(async (steps) => ({
        version: 1 as const,
        updatedAt: "2026-08-17T00:00:00.000Z",
        steps: [...steps],
      })),
      loadPlan: vi.fn(),
    };
    const input = {
      steps: [
        { content: "分析代码", status: "completed" },
        { content: "实现功能", status: "in_progress" },
      ],
    };

    const result = JSON.parse(await executeTool("update_plan", input, { workspaceRoot, taskPlan }));

    expect(result.steps).toEqual(input.steps);
    expect(taskPlan.updatePlan).toHaveBeenCalledWith(input.steps);
    await expect(executeTool("update_plan", {
      steps: [
        { content: "one", status: "in_progress" },
        { content: "two", status: "in_progress" },
      ],
    }, { workspaceRoot, taskPlan })).rejects.toThrow("at most one in_progress");
    await expect(executeTool("update_plan", input, { workspaceRoot }))
      .rejects.toThrow("task plan store is not configured");
  });

  it("exposes update_plan to both Providers", () => {
    expect(toolDefinitions).toContainEqual(expect.objectContaining({ name: "update_plan" }));
    expect(openAIToolDefinitions).toContainEqual(expect.objectContaining({
      type: "function",
      name: "update_plan",
      strict: true,
    }));
  });

  it("schedules a derived memory-index sync after successful file writes", async () => {
    const memoryIndex = {
      search: vi.fn(),
      get: vi.fn(),
      scheduleSync: vi.fn(),
    };

    await executeTool(
      "write_text_file",
      { path: "MEMORY.md", content: "remember this" },
      { workspaceRoot, memoryIndex },
    );

    expect(memoryIndex.scheduleSync).toHaveBeenCalledOnce();
  });

  it("requires confirmation by default except for registered safe tools", () => {
    expect(requiresToolConfirmation("calculator")).toBe(false);
    expect(requiresToolConfirmation("list_directory")).toBe(false);
    expect(requiresToolConfirmation("find_files")).toBe(false);
    expect(requiresToolConfirmation("search_files")).toBe(false);
    expect(requiresToolConfirmation("read_text_file")).toBe(false);
    expect(requiresToolConfirmation("read_skill")).toBe(false);
    expect(requiresToolConfirmation("update_plan")).toBe(false);
    expect(requiresToolConfirmation("memory_search")).toBe(false);
    expect(requiresToolConfirmation("memory_get")).toBe(false);
    expect(requiresToolConfirmation("git_status")).toBe(false);
    expect(requiresToolConfirmation("git_diff")).toBe(false);
    expect(requiresToolConfirmation("create_directory")).toBe(true);
    expect(requiresToolConfirmation("write_text_file")).toBe(true);
    expect(requiresToolConfirmation("edit_text_file")).toBe(true);
    expect(requiresToolConfirmation("apply_patch")).toBe(true);
    expect(requiresToolConfirmation("fetch_url")).toBe(true);
    expect(requiresToolConfirmation("run_command")).toBe(true);
    expect(requiresToolConfirmation("shell")).toBe(true);
  });
});
