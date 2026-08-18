import {
  MAX_SUBAGENT_RESULT_BYTES,
  MAX_SUBAGENT_TASK_BYTES,
  formatSubagentResult,
  getSubagentRolePrompt,
  parseSubagentRequest,
} from "../src/subagents.js";

describe("sub-agents", () => {
  it.each(["test", "docs"] as const)("parses a %s request and trims its task", (agent) => {
    expect(parseSubagentRequest({ agent, task: "  inspect src/tools.ts  " })).toEqual({
      agent,
      task: "inspect src/tools.ts",
    });
  });

  it("rejects unsupported roles and empty tasks", () => {
    expect(() => parseSubagentRequest({ agent: "code", task: "inspect" }))
      .toThrow("agent must be one of: test, docs");
    expect(() => parseSubagentRequest({ agent: "test", task: "  \n " }))
      .toThrow("task must not be empty");
    expect(() => parseSubagentRequest({ agent: "test" }))
      .toThrow("requires string agent and task fields");
  });

  it("enforces the task limit in UTF-8 bytes", () => {
    const exactlyAtLimit = "测".repeat(Math.floor(MAX_SUBAGENT_TASK_BYTES / 3))
      + "x".repeat(MAX_SUBAGENT_TASK_BYTES % 3);
    expect(Buffer.byteLength(exactlyAtLimit, "utf8")).toBe(MAX_SUBAGENT_TASK_BYTES);
    expect(parseSubagentRequest({ agent: "test", task: exactlyAtLimit }).task)
      .toBe(exactlyAtLimit);

    expect(() => parseSubagentRequest({ agent: "test", task: `${exactlyAtLimit}试` }))
      .toThrow(`maximum is ${MAX_SUBAGENT_TASK_BYTES} bytes`);
  });

  it("returns bounded JSON without splitting a UTF-8 character", () => {
    const request = { agent: "docs" as const, task: "summarize" };
    const output = formatSubagentResult(request, {
      text: "文".repeat(MAX_SUBAGENT_RESULT_BYTES),
      stopReason: "end_turn",
    });
    const parsed = JSON.parse(output) as {
      agent: string;
      status: string;
      stopReason: string;
      result: string;
      truncated: boolean;
    };

    expect(parsed).toMatchObject({
      agent: "docs",
      status: "completed",
      stopReason: "end_turn",
      truncated: true,
    });
    expect(Buffer.byteLength(parsed.result, "utf8")).toBeLessThanOrEqual(MAX_SUBAGENT_RESULT_BYTES);
    expect(parsed.result).not.toContain("�");
    expect(parsed.result).toContain(`[Sub-agent result truncated at ${MAX_SUBAGENT_RESULT_BYTES} bytes]`);
  });

  it("uses fixed, specialized role prompts", () => {
    const testPrompt = getSubagentRolePrompt("test");
    const docsPrompt = getSubagentRolePrompt("docs");

    expect(testPrompt).toContain("test sub-agent");
    expect(testPrompt).toContain("run tests");
    expect(testPrompt).toContain("Do not modify product code");
    expect(docsPrompt).toContain("documentation sub-agent");
    expect(docsPrompt).toContain("Read the relevant implementation");
    expect(docsPrompt).toContain("Do not change source code");
    expect(testPrompt).toContain("Do not attempt to delegate again");
    expect(docsPrompt).toContain("Do not attempt to delegate again");
  });
});
