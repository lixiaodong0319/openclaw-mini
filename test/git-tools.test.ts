import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/tools.js";

describe("Git tools", () => {
  let workspaceRoot: string;
  let repositoryRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-"));
    repositoryRoot = path.join(workspaceRoot, "repo");
    await fs.mkdir(repositoryRoot);
    runGit(repositoryRoot, "init", "--quiet");
    runGit(repositoryRoot, "config", "user.name", "OpenClaw Test");
    runGit(repositoryRoot, "config", "user.email", "openclaw@example.test");
    await fs.writeFile(path.join(repositoryRoot, "tracked.txt"), "old\n", "utf8");
    runGit(repositoryRoot, "add", "tracked.txt");
    runGit(repositoryRoot, "commit", "--quiet", "-m", "initial");
  });

  it("returns structured branch and worktree status", async () => {
    await fs.writeFile(path.join(repositoryRoot, "tracked.txt"), "new\n", "utf8");
    await fs.writeFile(path.join(repositoryRoot, "untracked file.txt"), "hello\n", "utf8");

    const output = JSON.parse(await executeTool(
      "git_status",
      { path: "repo" },
      { workspaceRoot },
    )) as {
      repository: string;
      branch: { head: string; oid: string };
      entries: Array<{ path: string; index: string; worktree: string }>;
      truncated: boolean;
    };

    expect(output.repository).toBe("repo");
    expect(output.branch.head).toBeTruthy();
    expect(output.branch.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(output.entries).toEqual([
      { path: "tracked.txt", index: ".", worktree: "M" },
      { path: "untracked file.txt", index: "?", worktree: "?" },
    ]);
    expect(output.truncated).toBe(false);
  });

  it("returns an unstaged diff for one literal file path", async () => {
    await fs.writeFile(path.join(repositoryRoot, "tracked.txt"), "new\n", "utf8");

    const output = JSON.parse(await executeTool(
      "git_diff",
      { path: "repo", file: "tracked.txt", staged: false, max_bytes: null },
      { workspaceRoot },
    )) as { repository: string; file: string; staged: boolean; diff: string; truncated: boolean };

    expect(output).toMatchObject({
      repository: "repo",
      file: "tracked.txt",
      staged: false,
      truncated: false,
    });
    expect(output.diff).toContain("--- a/tracked.txt");
    expect(output.diff).toContain("-old");
    expect(output.diff).toContain("+new");
  });

  it("returns staged changes and truncates the diff by bytes", async () => {
    await fs.writeFile(path.join(repositoryRoot, "tracked.txt"), `${"中文".repeat(100)}\n`, "utf8");
    runGit(repositoryRoot, "add", "tracked.txt");

    const output = JSON.parse(await executeTool(
      "git_diff",
      { path: "repo", file: null, staged: true, max_bytes: 40 },
      { workspaceRoot },
    )) as { staged: boolean; diff: string; truncated: boolean };

    expect(output.staged).toBe(true);
    expect(Buffer.byteLength(output.diff, "utf8")).toBeLessThanOrEqual(40);
    expect(output.diff).not.toContain("�");
    expect(output.truncated).toBe(true);
  });

  it("discovers the repository root from a nested directory", async () => {
    await fs.mkdir(path.join(repositoryRoot, "src"));

    const output = JSON.parse(await executeTool(
      "git_status",
      { path: "repo/src" },
      { workspaceRoot },
    )) as { repository: string };

    expect(output.repository).toBe("repo");
  });

  it("rejects repositories and diff paths outside their allowed roots", async () => {
    await expect(executeTool("git_status", { path: ".." }, { workspaceRoot }))
      .rejects.toThrow("workspace");
    await expect(executeTool(
      "git_status",
      { path: path.resolve(repositoryRoot) },
      { workspaceRoot },
    )).rejects.toThrow("relative");
    await expect(executeTool(
      "git_diff",
      { path: "repo", file: "../outside.txt", staged: false, max_bytes: null },
      { workspaceRoot },
    )).rejects.toThrow("repository");
    await expect(executeTool("git_status", { path: "." }, { workspaceRoot }))
      .rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects repository paths resolving outside the workspace", async () => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-outside-"));
    try {
      runGit(outsideRoot, "init", "--quiet");
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "linked"));

      await expect(executeTool("git_status", { path: "linked" }, { workspaceRoot }))
        .rejects.toThrow("outside the workspace");
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

function runGit(cwd: string, ...arguments_: string[]): void {
  execFileSync("git", arguments_, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}
