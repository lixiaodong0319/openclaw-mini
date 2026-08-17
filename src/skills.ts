import fs from "node:fs/promises";
import path from "node:path";

export const SKILLS_DIRECTORY = "skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const MAX_SKILLS = 50;
export const MAX_SKILL_FILE_BYTES = 64 * 1024;
export const MAX_SKILL_DESCRIPTION_BYTES = 1024;

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 暴露给 CLI 和系统提示词的轻量目录项。
 *
 * 这里刻意不保存 SKILL.md 正文：启动和每轮模型请求只需要名称与描述，
 * 完整指令必须等模型明确调用 read_skill 后再进入上下文。
 */
export interface WorkspaceSkill {
  name: string;
  description: string;
  enabled: boolean;
  relativePath: string;
}

/** tools.ts 依赖的最小接口，避免工具层知道扫描器的文件系统实现细节。 */
export interface SkillToolService {
  readSkill(name: string): Promise<string>;
}

interface ParsedWorkspaceSkill {
  catalog: WorkspaceSkill;
  body: string;
}

/**
 * 管理 workspace/skills 下由用户维护的技能。
 *
 * 管理器本身不缓存目录或正文。loadCatalog/readSkill 每次都重新检查磁盘，
 * 因此新增、修改、启用或禁用技能后，不需要重启正在运行的 CLI/Web。
 */
export class WorkspaceSkillManager implements SkillToolService {
  constructor(private readonly workspaceRoot: string) {}

  async loadCatalog(): Promise<WorkspaceSkill[]> {
    const skillsRoot = path.join(this.workspaceRoot, SKILLS_DIRECTORY);
    const rootStat = await lstatIfExists(skillsRoot);
    if (!rootStat) return [];
    if (rootStat.isSymbolicLink()) {
      throw new Error(`${SKILLS_DIRECTORY} must not be a symbolic link`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`${SKILLS_DIRECTORY} must be a directory`);
    }

    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const skills: WorkspaceSkill[] = [];

    // 文件系统返回顺序没有保证；固定按目录名排序，让提示词、CLI 和测试输出稳定。
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(skillsRoot, entry.name);
      const entryStat = await fs.lstat(entryPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(`${toSkillRelativePath(entry.name)} must not be a symbolic link`);
      }
      // skills 根目录下的普通说明文件等内容不属于技能，直接忽略。
      if (!entryStat.isDirectory()) continue;

      const parsed = await this.readSkillDirectory(entry.name);
      // 没有 SKILL.md 的普通目录不是技能，允许与其他 workspace 内容共存。
      if (!parsed) continue;
      skills.push(parsed.catalog);
      if (skills.length > MAX_SKILLS) {
        throw new Error(`too many skills; maximum is ${MAX_SKILLS}`);
      }
    }

    return skills;
  }

  async readSkill(name: string): Promise<string> {
    validateSkillName(name);

    // 先通过完整目录扫描确认技能仍存在且处于启用状态。这样 read_skill 不能通过
    // 猜测路径读取禁用技能，也会沿用目录数量与符号链接等全部安全检查。
    const catalog = await this.loadCatalog();
    const discovered = catalog.find((skill) => skill.name === name);
    if (!discovered) throw new Error(`skill not found: ${name}`);
    if (!discovered.enabled) throw new Error(`skill is disabled: ${name}`);

    // 扫描结束后再读取一次目标，确保运行期刚保存的正文可以立即生效。
    // readSkillDirectory 会重新执行大小、UTF-8、frontmatter 和符号链接校验。
    const parsed = await this.readSkillDirectory(name);
    if (!parsed || parsed.catalog.name !== name) {
      throw new Error(`skill not found: ${name}`);
    }
    if (!parsed.catalog.enabled) throw new Error(`skill is disabled: ${name}`);

    return `[Skill] ${parsed.catalog.name}\nSource: ${parsed.catalog.relativePath}\n\n<skill_instructions>\n${parsed.body}\n</skill_instructions>`;
  }

  private async readSkillDirectory(directoryName: string): Promise<ParsedWorkspaceSkill | undefined> {
    const directoryRelativePath = toSkillRelativePath(directoryName);
    const directoryPath = path.join(this.workspaceRoot, SKILLS_DIRECTORY, directoryName);
    const directoryStat = await fs.lstat(directoryPath);
    if (directoryStat.isSymbolicLink()) {
      throw new Error(`${directoryRelativePath} must not be a symbolic link`);
    }
    if (!directoryStat.isDirectory()) return undefined;

    const skillPath = path.join(directoryPath, SKILL_FILE_NAME);
    const skillRelativePath = `${directoryRelativePath}/${SKILL_FILE_NAME}`;
    const skillStat = await lstatIfExists(skillPath);
    if (!skillStat) return undefined;
    if (skillStat.isSymbolicLink()) {
      throw new Error(`${skillRelativePath} must not be a symbolic link`);
    }
    if (!skillStat.isFile()) {
      throw new Error(`${skillRelativePath} must be a regular file`);
    }
    if (skillStat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`${skillRelativePath} is too large; maximum is ${MAX_SKILL_FILE_BYTES} bytes`);
    }

    const buffer = await fs.readFile(skillPath);
    // lstat 和 readFile 之间文件可能被编辑，因此真实读取后必须再次检查字节数。
    if (buffer.length > MAX_SKILL_FILE_BYTES) {
      throw new Error(`${skillRelativePath} is too large; maximum is ${MAX_SKILL_FILE_BYTES} bytes`);
    }
    if (buffer.includes(0)) {
      throw new Error(`${skillRelativePath} must be a UTF-8 text file`);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`${skillRelativePath} must contain valid UTF-8 text`);
    }

    return parseSkillFile(content, directoryName, skillRelativePath);
  }
}

function parseSkillFile(
  content: string,
  directoryName: string,
  relativePath: string,
): ParsedWorkspaceSkill {
  // 第一版只实现简单的单行 YAML frontmatter，不引入 YAML 依赖。未知字段的值被忽略，
  // 便于以后增加版本或作者信息；所有字段名仍不得重复，核心字段还会严格校验值。
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(content);
  if (!match) {
    throw new Error(`${relativePath} must start with a valid --- frontmatter block`);
  }

  const values = new Map<string, string>();
  for (const sourceLine of (match[1] ?? "").split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line);
    if (!field) throw new Error(`${relativePath} contains invalid frontmatter: ${sourceLine}`);
    const key = field[1] ?? "";
    if (values.has(key)) throw new Error(`${relativePath} contains duplicate frontmatter field: ${key}`);
    values.set(key, unwrapQuotedValue((field[2] ?? "").trim()));
  }

  const name = values.get("name") ?? "";
  const description = values.get("description") ?? "";
  const enabledValue = values.get("enabled");
  validateSkillName(name, relativePath);
  if (name !== directoryName) {
    throw new Error(`${relativePath} name must match its directory: ${directoryName}`);
  }
  if (description.trim().length === 0) {
    throw new Error(`${relativePath} requires a non-empty description`);
  }
  if (Buffer.byteLength(description, "utf8") > MAX_SKILL_DESCRIPTION_BYTES) {
    throw new Error(
      `${relativePath} description is too large; maximum is ${MAX_SKILL_DESCRIPTION_BYTES} bytes`,
    );
  }
  if (enabledValue !== undefined && enabledValue !== "true" && enabledValue !== "false") {
    throw new Error(`${relativePath} enabled must be true or false`);
  }

  const body = match[2] ?? "";
  if (body.trim().length === 0) {
    throw new Error(`${relativePath} requires non-empty skill instructions`);
  }

  return {
    catalog: {
      name,
      description,
      enabled: enabledValue !== "false",
      relativePath,
    },
    body,
  };
}

function validateSkillName(name: string, relativePath = "skill name"): void {
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`${relativePath} has an invalid skill name`);
  }
}

function unwrapQuotedValue(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === last && (first === "\"" || first === "'"))
    ? value.slice(1, -1)
    : value;
}

function toSkillRelativePath(directoryName: string): string {
  // 对外展示始终使用 `/`，避免 Windows 路径分隔符进入模型提示词或快照测试。
  return `${SKILLS_DIRECTORY}/${directoryName}`;
}

async function lstatIfExists(targetPath: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
