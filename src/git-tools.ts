import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_STATUS_BYTES = 1024 * 1024;
const MAX_GIT_STATUS_ENTRIES = 500;
export const DEFAULT_GIT_DIFF_BYTES = 64 * 1024;
export const MAX_GIT_DIFF_BYTES = 256 * 1024;
const MAX_GIT_ERROR_BYTES = 64 * 1024;
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|AUTHORIZATION|COOKIE|SESSION|JWT)(?:_|$)/i;

export interface GitDiffOptions {
  repositoryPath: string;
  file?: string;
  staged: boolean;
  maxBytes: number;
}

interface GitCommandResult {
  stdout: Buffer;
  stdoutTruncated: boolean;
}

interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  original_path?: string;
}

export async function getGitStatus(workspaceRoot: string, repositoryPath: string): Promise<string> {
  const repository = await resolveWorkspaceRepository(workspaceRoot, repositoryPath);
  const result = await runGit(repository.target, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=all",
  ], MAX_GIT_STATUS_BYTES);

  let statusOutput = result.stdout;
  if (result.stdoutTruncated && statusOutput.at(-1) !== 0) {
    // porcelain -z 的完整记录都以 NUL 结尾；截断时丢弃最后一条半记录。
    const lastSeparator = statusOutput.lastIndexOf(0);
    statusOutput = lastSeparator === -1 ? Buffer.alloc(0) : statusOutput.subarray(0, lastSeparator + 1);
  }
  const parsed = parseGitStatus(statusOutput.toString("utf8"));
  const entriesTruncated = parsed.entries.length > MAX_GIT_STATUS_ENTRIES;
  return JSON.stringify({
    repository: repository.relativePath,
    branch: parsed.branch,
    entries: parsed.entries.slice(0, MAX_GIT_STATUS_ENTRIES),
    truncated: result.stdoutTruncated || entriesTruncated,
  }, null, 2);
}

export async function getGitDiff(workspaceRoot: string, options: GitDiffOptions): Promise<string> {
  const repository = await resolveWorkspaceRepository(workspaceRoot, options.repositoryPath);
  const file = options.file === undefined ? undefined : resolveGitFilePath(repository.target, options.file);
  const arguments_ = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=all",
  ];
  if (options.staged) arguments_.push("--cached");
  if (file) arguments_.push("--", `:(literal)${file}`);

  // 多取一个字节用来判断是否恰好超过上限，返回正文时再精确截断。
  const result = await runGit(repository.target, arguments_, options.maxBytes + 1);
  const truncated = result.stdoutTruncated || result.stdout.length > options.maxBytes;
  const selected = result.stdout.subarray(0, options.maxBytes);
  const decoder = new StringDecoder("utf8");
  return JSON.stringify({
    repository: repository.relativePath,
    file,
    staged: options.staged,
    // 不调用 decoder.end()，让末尾不完整的 UTF-8 字节留在内部缓冲而不是变成替换字符。
    diff: decoder.write(selected),
    truncated,
  }, null, 2);
}

async function resolveWorkspaceRepository(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ target: string; relativePath: string }> {
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Git repository path must be relative to the workspace");
  }

  const root = await fs.realpath(workspaceRoot);
  const requestedTarget = path.resolve(root, requestedPath);
  const requestedRelative = path.relative(root, requestedTarget);
  if (isOutsideRoot(requestedRelative)) {
    throw new Error("Git repository path escapes the workspace");
  }

  const realTarget = await fs.realpath(requestedTarget);
  const realRelative = path.relative(root, realTarget);
  if (isOutsideRoot(realRelative)) {
    throw new Error("Git repository path resolves outside the workspace");
  }
  if (!(await fs.stat(realTarget)).isDirectory()) {
    throw new Error("Git repository path is not a directory");
  }

  // Git 会自动向父目录寻找仓库。显式读取 toplevel 并再次检查，防止 workspace
  // 只是外部仓库的子目录时，无意查看 workspace 外的状态或差异。
  const topLevelResult = await runGit(realTarget, ["rev-parse", "--show-toplevel"], 16 * 1024);
  const topLevelText = topLevelResult.stdout.toString("utf8").trim();
  if (topLevelText.length === 0) {
    throw new Error("Git did not return a repository root");
  }
  const topLevel = await fs.realpath(topLevelText);
  const topLevelRelative = path.relative(root, topLevel);
  if (isOutsideRoot(topLevelRelative)) {
    throw new Error("Git repository root is outside the workspace");
  }

  return {
    target: topLevel,
    relativePath: topLevelRelative.length === 0 ? "." : topLevelRelative.split(path.sep).join("/"),
  };
}

function resolveGitFilePath(repositoryRoot: string, requestedFile: string): string {
  if (requestedFile.trim().length === 0) {
    throw new Error("git_diff file must not be empty");
  }
  if (path.isAbsolute(requestedFile)) {
    throw new Error("git_diff file must be relative to the repository");
  }

  // 被删除的文件已不存在，不能依赖 realpath；词法边界检查配合 :(literal) pathspec
  // 既允许查看删除差异，也阻止 .. 和 Git pathspec magic 扩大范围。
  const target = path.resolve(repositoryRoot, requestedFile);
  const relative = path.relative(repositoryRoot, target);
  if (isOutsideRoot(relative) || relative.length === 0) {
    throw new Error("git_diff file escapes the repository");
  }
  return relative.split(path.sep).join("/");
}

function parseGitStatus(output: string): {
  branch: { head?: string; oid?: string; upstream?: string; ahead?: number; behind?: number };
  entries: GitStatusEntry[];
} {
  const branch: { head?: string; oid?: string; upstream?: string; ahead?: number; behind?: number } = {};
  const entries: GitStatusEntry[] = [];
  const records = output.split("\0");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    if (record.startsWith("# branch.oid ")) {
      branch.oid = record.slice("# branch.oid ".length);
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      branch.head = record.slice("# branch.head ".length);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      branch.upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("? ")) {
      entries.push({ path: record.slice(2), index: "?", worktree: "?" });
      continue;
    }
    if (record.startsWith("! ")) continue;

    const fields = record.split(" ");
    const type = fields[0];
    const status = fields[1];
    if (!status || status.length !== 2) continue;
    if (type === "1" && fields.length >= 9) {
      entries.push({ path: fields.slice(8).join(" "), index: status[0] ?? ".", worktree: status[1] ?? "." });
    } else if (type === "2" && fields.length >= 10) {
      const originalPath = records[index + 1];
      entries.push({
        path: fields.slice(9).join(" "),
        index: status[0] ?? ".",
        worktree: status[1] ?? ".",
        ...(originalPath ? { original_path: originalPath } : {}),
      });
      index += 1;
    } else if (type === "u" && fields.length >= 11) {
      entries.push({ path: fields.slice(10).join(" "), index: status[0] ?? "U", worktree: status[1] ?? "U" });
    }
  }

  return { branch, entries };
}

function runGit(cwd: string, arguments_: string[], maxOutputBytes: number): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [
      "--no-pager",
      "-c", "core.fsmonitor=false",
      "-c", "core.quotepath=false",
      ...arguments_,
    ], {
      cwd,
      env: createGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = maxOutputBytes - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      const selected = chunk.subarray(0, remaining);
      stdoutChunks.push(selected);
      stdoutBytes += selected.length;
      if (selected.length < chunk.length) stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_GIT_ERROR_BYTES - stderrBytes;
      if (remaining <= 0) return;
      const selected = chunk.subarray(0, remaining);
      stderrChunks.push(selected);
      stderrBytes += selected.length;
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Git command timed out after ${GIT_TIMEOUT_MS} milliseconds`));
    }, GIT_TIMEOUT_MS);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Could not start Git: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const stdout = Buffer.concat(stdoutChunks);
      if (exitCode !== 0) {
        const errorText = Buffer.concat(stderrChunks).toString("utf8").trim()
          || stdout.toString("utf8").trim()
          || `Git exited with code ${exitCode ?? "unknown"}`;
        reject(new Error(errorText));
        return;
      }
      resolve({ stdout, stdoutTruncated });
    });
  });
}

function createGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENVIRONMENT_NAME.test(name)) {
      environment[name] = value;
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_PAGER = "cat";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  return environment;
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
}
