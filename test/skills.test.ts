import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_SKILLS,
  MAX_SKILL_FILE_BYTES,
  WorkspaceSkillManager,
} from "../src/skills.js";

describe("workspace skills", () => {
  const temporaryDirectories: string[] = [];

  async function createWorkspace(): Promise<string> {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-"));
    temporaryDirectories.push(workspaceRoot);
    return workspaceRoot;
  }

  async function writeSkill(
    workspaceRoot: string,
    name: string,
    options: { description?: string; enabled?: boolean; body?: string } = {},
  ): Promise<void> {
    const directory = path.join(workspaceRoot, "skills", name);
    await fs.mkdir(directory, { recursive: true });
    const enabled = options.enabled === undefined ? "" : `enabled: ${options.enabled}\n`;
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${options.description ?? `Use ${name}`}\n${enabled}---\n\n${options.body ?? `# ${name}\n\nFollow this workflow.`}\n`,
      "utf8",
    );
  }

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
      recursive: true,
      force: true,
    })));
  });

  it("returns an empty catalog when workspace/skills does not exist", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(new WorkspaceSkillManager(workspaceRoot).loadCatalog()).resolves.toEqual([]);
  });

  it("discovers enabled and disabled skills without loading their bodies into the catalog", async () => {
    const workspaceRoot = await createWorkspace();
    await writeSkill(workspaceRoot, "code-review", {
      description: "审查代码质量和潜在问题",
      body: "SECRET FULL INSTRUCTIONS",
    });
    await writeSkill(workspaceRoot, "release", {
      description: "发布工作流",
      enabled: false,
    });

    const catalog = await new WorkspaceSkillManager(workspaceRoot).loadCatalog();

    expect(catalog).toEqual([{
      name: "code-review",
      description: "审查代码质量和潜在问题",
      enabled: true,
      relativePath: "skills/code-review/SKILL.md",
    }, {
      name: "release",
      description: "发布工作流",
      enabled: false,
      relativePath: "skills/release/SKILL.md",
    }]);
    expect(JSON.stringify(catalog)).not.toContain("SECRET FULL INSTRUCTIONS");
  });

  it("loads complete instructions for an enabled skill", async () => {
    const workspaceRoot = await createWorkspace();
    await writeSkill(workspaceRoot, "code-review", {
      body: "# Review\n\n1. Inspect the diff.\n2. Run tests.",
    });

    const output = await new WorkspaceSkillManager(workspaceRoot).readSkill("code-review");

    expect(output).toContain("[Skill] code-review");
    expect(output).toContain("Source: skills/code-review/SKILL.md");
    expect(output).toContain("<skill_instructions>");
    expect(output).toContain("1. Inspect the diff.\n2. Run tests.");
  });

  it("hot-refreshes catalog metadata and instruction bodies", async () => {
    const workspaceRoot = await createWorkspace();
    const manager = new WorkspaceSkillManager(workspaceRoot);
    await writeSkill(workspaceRoot, "review", { description: "old description", body: "old body" });

    expect((await manager.loadCatalog())[0]?.description).toBe("old description");
    expect(await manager.readSkill("review")).toContain("old body");

    await writeSkill(workspaceRoot, "review", { description: "new description", body: "new body" });
    expect((await manager.loadCatalog())[0]?.description).toBe("new description");
    expect(await manager.readSkill("review")).toContain("new body");
  });

  it("does not allow read_skill to load disabled or unknown skills", async () => {
    const workspaceRoot = await createWorkspace();
    const manager = new WorkspaceSkillManager(workspaceRoot);
    await writeSkill(workspaceRoot, "disabled", { enabled: false });

    await expect(manager.readSkill("disabled")).rejects.toThrow("disabled");
    await expect(manager.readSkill("missing")).rejects.toThrow("not found");
    await expect(manager.readSkill("../escape")).rejects.toThrow("invalid skill name");
  });

  it("rejects malformed frontmatter, directory/name mismatches, and empty bodies", async () => {
    const workspaceRoot = await createWorkspace();
    const skillDirectory = path.join(workspaceRoot, "skills", "review");
    await fs.mkdir(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const manager = new WorkspaceSkillManager(workspaceRoot);

    await fs.writeFile(skillPath, "# no frontmatter", "utf8");
    await expect(manager.loadCatalog()).rejects.toThrow("frontmatter");

    await fs.writeFile(skillPath, "---\nname: other\ndescription: test\n---\nbody", "utf8");
    await expect(manager.loadCatalog()).rejects.toThrow("match its directory");

    await fs.writeFile(skillPath, "---\nname: review\ndescription: test\n---\n", "utf8");
    await expect(manager.loadCatalog()).rejects.toThrow("non-empty skill instructions");

    await fs.writeFile(skillPath, "---\nname: review\ndescription: test\nenabled: yes\n---\nbody", "utf8");
    await expect(manager.loadCatalog()).rejects.toThrow("enabled must be true or false");
  });

  it("rejects oversized descriptions and non-directory skill roots", async () => {
    const workspaceRoot = await createWorkspace();
    await fs.writeFile(path.join(workspaceRoot, "skills"), "not a directory", "utf8");
    const manager = new WorkspaceSkillManager(workspaceRoot);

    await expect(manager.loadCatalog()).rejects.toThrow("skills must be a directory");

    await fs.unlink(path.join(workspaceRoot, "skills"));
    await writeSkill(workspaceRoot, "review", { description: "x".repeat(1025) });
    await expect(manager.loadCatalog()).rejects.toThrow("description is too large");
  });

  it("rejects a directory used as SKILL.md and duplicate frontmatter fields", async () => {
    const workspaceRoot = await createWorkspace();
    const skillDirectory = path.join(workspaceRoot, "skills", "review");
    const skillPath = path.join(skillDirectory, "SKILL.md");
    await fs.mkdir(skillPath, { recursive: true });
    const manager = new WorkspaceSkillManager(workspaceRoot);

    await expect(manager.loadCatalog()).rejects.toThrow("regular file");

    await fs.rm(skillPath, { recursive: true });
    await fs.writeFile(
      skillPath,
      "---\nname: review\ndescription: first\ndescription: second\n---\nbody",
      "utf8",
    );
    await expect(manager.loadCatalog()).rejects.toThrow("duplicate frontmatter field");
  });

  it("rejects invalid UTF-8, NUL content, and oversized SKILL.md files", async () => {
    const workspaceRoot = await createWorkspace();
    const skillDirectory = path.join(workspaceRoot, "skills", "review");
    await fs.mkdir(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, "SKILL.md");
    const manager = new WorkspaceSkillManager(workspaceRoot);

    await fs.writeFile(skillPath, Buffer.from([0xc3, 0x28]));
    await expect(manager.loadCatalog()).rejects.toThrow("valid UTF-8 text");

    await fs.writeFile(skillPath, Buffer.from("---\nname: review\ndescription: x\n---\nbody\0"));
    await expect(manager.loadCatalog()).rejects.toThrow("UTF-8 text file");

    await fs.writeFile(skillPath, Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 0x61));
    await expect(manager.loadCatalog()).rejects.toThrow("too large");
  });

  it("rejects more than the configured number of skills", async () => {
    const workspaceRoot = await createWorkspace();
    await Promise.all(Array.from({ length: MAX_SKILLS + 1 }, (_, index) => (
      writeSkill(workspaceRoot, `skill-${String(index).padStart(2, "0")}`)
    )));

    await expect(new WorkspaceSkillManager(workspaceRoot).loadCatalog())
      .rejects.toThrow(`maximum is ${MAX_SKILLS}`);
  });

  it.skipIf(process.platform === "win32")("rejects symbolic links at every skill path level", async () => {
    const workspaceRoot = await createWorkspace();
    const manager = new WorkspaceSkillManager(workspaceRoot);
    const target = path.join(workspaceRoot, "target");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(workspaceRoot, "skills"));
    await expect(manager.loadCatalog()).rejects.toThrow("skills must not be a symbolic link");

    await fs.unlink(path.join(workspaceRoot, "skills"));
    await fs.mkdir(path.join(workspaceRoot, "skills"));
    await fs.symlink(target, path.join(workspaceRoot, "skills", "linked"));
    await expect(manager.loadCatalog()).rejects.toThrow("skills/linked must not be a symbolic link");

    await fs.unlink(path.join(workspaceRoot, "skills", "linked"));
    const skillDirectory = path.join(workspaceRoot, "skills", "review");
    await fs.mkdir(skillDirectory);
    const targetFile = path.join(target, "SKILL.md");
    await fs.writeFile(targetFile, "---\nname: review\ndescription: x\n---\nbody", "utf8");
    await fs.symlink(targetFile, path.join(skillDirectory, "SKILL.md"));
    await expect(manager.loadCatalog()).rejects.toThrow("SKILL.md must not be a symbolic link");
  });
});
