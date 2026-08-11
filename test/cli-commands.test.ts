import {
  CLI_HELP_TEXT,
  formatSessionHistory,
  isCliCommandName,
  parseCliCommand,
} from "../src/cli-commands.js";

describe("CLI commands", () => {
  it("distinguishes normal messages from case-insensitive slash commands", () => {
    expect(parseCliCommand("hello")).toBeUndefined();
    expect(parseCliCommand(" /STATUS ")).toEqual({ name: "status", argument: "" });
    expect(parseCliCommand("/compact now")).toEqual({ name: "compact", argument: "now" });
    expect(parseCliCommand("/")).toEqual({ name: "", argument: "" });
  });

  it("recognizes every documented command", () => {
    for (const name of ["help", "status", "history", "compact", "clear", "exit"]) {
      expect(isCliCommandName(name)).toBe(true);
      expect(CLI_HELP_TEXT).toContain(`/${name}`);
    }
    expect(isCliCommandName("unknown")).toBe(false);
  });

  it("formats the safe history view for terminal display", () => {
    const output = formatSessionHistory({
      sessionId: "demo",
      truncated: true,
      entries: [
        { type: "summary", text: "earlier facts" },
        { type: "message", role: "user", text: "question" },
        { type: "message", role: "assistant", text: "answer" },
        { type: "tool", name: "calculator", status: "completed" },
        { type: "tool", name: "run_command", status: "failed" },
      ],
    });

    expect(output).toContain("[提示] 历史较长");
    expect(output).toContain("[摘要] earlier facts");
    expect(output).toContain("[用户] question");
    expect(output).toContain("[助手] answer");
    expect(output).toContain("[工具] calculator 完成");
    expect(output).toContain("[工具] run_command 失败");
  });

  it("reports empty history and truncates oversized individual messages", () => {
    expect(formatSessionHistory({ sessionId: "empty", entries: [], truncated: false }))
      .toBe("[会话] empty 暂无历史");

    const output = formatSessionHistory({
      sessionId: "large",
      truncated: false,
      entries: [{ type: "message", role: "assistant", text: "x".repeat(2_100) }],
    });
    expect(output).toContain("...（单条历史已截断）");
    expect(output.length).toBeLessThan(2_100);
  });
});
