import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify, findHarnessFiles } from "../src/scan/files.js";
import { FIXTURE, tempDir } from "./helpers.js";

describe("classify", () => {
  it.each([
    [".github/copilot-instructions.md", "instruction", "copilot"],
    [".github/instructions/ts.instructions.md", "instruction", "copilot"],
    [".github/agents/x.agent.md", "agent", "copilot"],
    [".github/chatmodes/x.chatmode.md", "agent", "copilot"],
    [".github/prompts/x.prompt.md", "prompt", "copilot"],
    [".claude/agents/reviewer.md", "agent", "claude"],
    [".claude/commands/ship.md", "prompt", "claude"],
    [".claude/skills/rel/SKILL.md", "skill", "claude"],
    ["skills/rel/SKILL.md", "skill", "generic"],
    ["AGENTS.md", "instruction", "generic"],
    ["packages/api/AGENTS.md", "instruction", "generic"],
    ["CLAUDE.md", "instruction", "claude"],
    ["GEMINI.md", "instruction", "generic"],
    [".cursorrules", "instruction", "cursor"],
    [".cursor/rules/ts.mdc", "instruction", "cursor"],
    [".vscode/mcp.json", "mcp_config", "copilot"],
    [".mcp.json", "mcp_config", "claude"],
    [".cursor/mcp.json", "mcp_config", "cursor"],
    [".claude/settings.json", "hooks_config", "claude"],
    [".claude/settings.local.json", "hooks_config", "claude"],
  ])("%s → %s", (rel, role, flavor) => {
    expect(classify(rel)).toEqual({ role, flavor });
  });
  it("ignores unrelated files", () => {
    for (const rel of ["README.md", "src/index.ts", "docs/agents.txt", "package.json"]) expect(classify(rel)).toBeNull();
  });
});

describe("findHarnessFiles", () => {
  it("finds every harness file in the fixture, sorted", () => {
    const files = findHarnessFiles(FIXTURE).map((f) => f.rel);
    expect(files).toEqual([
      ".claude/settings.json",
      ".claude/skills/release/SKILL.md",
      ".github/agents/implementer.agent.md",
      ".github/agents/planner.agent.md",
      ".github/copilot-instructions.md",
      ".github/instructions/tests.instructions.md",
      ".github/prompts/new-feature.prompt.md",
      ".vscode/mcp.json",
      "AGENTS.md",
    ]);
  });
  it("skips node_modules and respects maxDepth", () => {
    const d = tempDir();
    mkdirSync(join(d, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(d, "node_modules/pkg/AGENTS.md"), "x");
    mkdirSync(join(d, "a/b/c"), { recursive: true });
    writeFileSync(join(d, "a/b/c/AGENTS.md"), "x");
    expect(findHarnessFiles(d).map((f) => f.rel)).toEqual(["a/b/c/AGENTS.md"]);
    expect(findHarnessFiles(d, 1)).toEqual([]);
  });
  it("returns [] for a missing directory", () => expect(findHarnessFiles("/definitely/not/here")).toEqual([]));
});
