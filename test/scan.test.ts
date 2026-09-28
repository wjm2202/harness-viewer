import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { classifyHeading, scanRepo, verbBefore } from "../src/scan/index.js";
import type { Graph } from "../src/schema.js";
import { validateGraph } from "../src/validate.js";
import { FIXTURE, tempDir } from "./helpers.js";

let g: Graph;
const node = (id: string) => g.nodes.find((n) => n.id === id);
const edge = (from: string, kind: string, to: string) => g.edges.find((e) => e.from === from && e.kind === kind && e.to === to);
const CI = "instruction:.github/copilot-instructions.md";
const WF = "state:.github/copilot-instructions.md/feature-workflow";

beforeAll(() => {
  g = scanRepo(FIXTURE);
});

describe("scanRepo on the sample repo", () => {
  it("produces a valid graph with meta", () => {
    expect(validateGraph(g)).toEqual({ ok: true, errors: [] });
    expect(g.meta.name).toBe("acme-harness");
    expect(g.meta.scannedFiles).toHaveLength(9);
    expect(g.nodes.every((n) => n.origin === "scan")).toBe(true);
  });

  it("is deterministic apart from the timestamp", () => {
    const again = scanRepo(FIXTURE);
    expect({ ...again, meta: { ...again.meta, generatedAt: "" } }).toEqual({ ...g, meta: { ...g.meta, generatedAt: "" } });
  });

  it("declares instruction, agent, prompt and skill nodes from their files", () => {
    expect(node(CI)).toMatchObject({ kind: "instruction", confidence: "declared", source: { file: ".github/copilot-instructions.md" } });
    expect(node("agent:planner")).toMatchObject({ confidence: "declared", description: "Turns an issue into an implementation plan.", props: { model: "GPT-5" } });
    expect(node("prompt:new-feature")).toMatchObject({ label: "/new-feature", props: { mode: "planner" } });
    expect(node("skill:release")).toMatchObject({ kind: "skill", description: "Cut a release." });
    expect(node("instruction:agents.md")).toBeDefined();
  });

  it("reads MCP servers from JSONC config, including unused ones", () => {
    expect(node("mcp_server:github")).toMatchObject({ confidence: "declared", props: { transport: "http", url: "https://api.githubcopilot.com/mcp/" } });
    expect(node("mcp_server:memory")?.props).toMatchObject({ transport: "stdio", command: "npx -y memory-mcp" });
    expect(node("mcp_server:unused")).toBeDefined();
  });

  it("maps frontmatter tools to uses/provides", () => {
    expect(edge("agent:planner", "uses", "mcp_server:github")).toMatchObject({ label: "all tools", confidence: "declared" });
    expect(edge("agent:planner", "uses", "tool:memory/memory_search")).toBeDefined();
    expect(edge("mcp_server:memory", "provides", "tool:memory/memory_search")).toBeDefined();
    expect(edge("agent:implementer", "uses", "tool:runtests")).toBeDefined();
    expect(edge("skill:release", "uses", "tool:bash")).toBeDefined();
    expect(node("tool:bash")?.props).toEqual({ builtin: true });
  });

  it("maps handoffs and prompt agents", () => {
    expect(edge("agent:planner", "delegates_to", "agent:implementer")).toMatchObject({ label: "Start implementation" });
    expect(edge("prompt:new-feature", "invokes", "agent:planner")).toBeDefined();
  });

  it("maps applyTo globs to constrained artifacts", () => {
    expect(edge("instruction:.github/instructions/tests.instructions.md", "constrains", "artifact:**/*.test.ts")).toMatchObject({ label: "applyTo" });
  });

  it("maps hooks to triggers guarding tools", () => {
    expect(node("trigger:hook/pretooluse/bash")).toMatchObject({ props: { event: "PreToolUse", matcher: "Bash", commands: ["./scripts/guard.sh"] } });
    expect(edge("trigger:hook/pretooluse/bash", "references", "tool:bash")).toBeDefined();
  });

  it("extracts inventory sections (agents, MCP tools) as inferred nodes", () => {
    expect(node("agent:reviewer")).toMatchObject({ confidence: "inferred", description: "reviews the diff against docs/STYLE.md" });
    expect(edge(CI, "defines", "agent:reviewer")).toBeDefined();
    expect(edge("agent:reviewer", "reads", "artifact:docs/style.md")).toBeDefined();
    expect(edge("agent:planner", "writes", "artifact:docs/plan.md")).toBeDefined();
    expect(node("tool:github/create_pull_request")?.description).toBe("opens the PR");
  });

  it("extracts an ordered workflow as a state machine with a start condition", () => {
    const states = g.nodes.filter((n) => n.kind === "state" && n.id.startsWith(WF));
    expect(states).toHaveLength(5);
    expect(node(`${WF}/01`)).toMatchObject({ initial: true, props: { workflow: "Feature workflow", step: 1 } });
    expect(node(`${WF}/05`)?.terminal).toBe(true);
    expect(edge(CI, "defines", `${WF}/01`)).toBeDefined();
    const start = `trigger:.github/copilot-instructions.md/feature-workflow/start`;
    expect(node(start)).toMatchObject({ kind: "trigger", label: "Start: Feature workflow", props: { start: true, explicit: false } });
    expect(edge(start, "transitions_to", `${WF}/01`)).toBeDefined();
    expect(edge(`${WF}/02`, "transitions_to", `${WF}/03`)).toBeDefined();
    expect(edge(`${WF}/04`, "transitions_to", `${WF}/05`)).toBeDefined();
  });

  it("turns 'if tests fail, go back to step 2' into a gate with yes/no exits", () => {
    const gate = `gate:.github/copilot-instructions.md/feature-workflow/03-check`;
    expect(node(gate)).toMatchObject({ kind: "gate", label: "Tests fail?", gateType: "automated", criteria: ["if tests fail, go back to step 2"] });
    expect(edge(`${WF}/03`, "transitions_to", gate)).toBeDefined();
    expect(edge(gate, "transitions_to", `${WF}/02`)?.label).toBe("yes");
    expect(edge(gate, "transitions_to", `${WF}/04`)?.label).toBe("no");
    expect(edge(`${WF}/03`, "transitions_to", `${WF}/04`)).toBeUndefined();
    expect(edge(gate, "uses", "tool:runtests")).toBeDefined();
  });

  it("gates the planner → implementer hand-off with the declared Copilot handoff (human)", () => {
    const gate = "gate:handoff/planner-to-implementer";
    expect(node(gate)).toMatchObject({ label: "Start implementation?", gateType: "human", confidence: "declared" });
    expect(edge(`${WF}/01`, "transitions_to", gate)).toBeDefined();
    expect(edge(gate, "transitions_to", `${WF}/02`)?.label).toBe("pass");
    expect(edge(gate, "performed_by", "actor:user")).toBeDefined();
    // no duplicate implicit gate, and no direct cross-agent transition
    expect(node(`gate:.github/copilot-instructions.md/feature-workflow/01-handoff`)).toBeUndefined();
    expect(edge(`${WF}/01`, "transitions_to", `${WF}/02`)).toBeUndefined();
  });

  it("nests an agent's own steps as a sub-flow of the stage it performs", () => {
    for (let i = 1; i <= 4; i++) expect(node(`state:implementer/steps/0${i}`)?.parent).toBe(`${WF}/02`);
    expect(node(`${WF}/02`)?.props).toMatchObject({ subflow: "agent:implementer" });
  });

  it("attaches actors, tools, inputs and outputs to states", () => {
    expect(edge(`${WF}/01`, "performed_by", "agent:planner")).toBeDefined();
    expect(edge(`${WF}/01`, "writes", "artifact:docs/plan.md")).toBeDefined();
    expect(edge(`${WF}/02`, "reads", "artifact:docs/plan.md")).toBeDefined();
    expect(edge(`${WF}/02`, "writes", "artifact:src")).toBeUndefined();
    expect(edge(`${WF}/02`, "writes", "artifact:src/")).toBeDefined();
    expect(edge(`${WF}/02`, "uses", "tool:edit")).toBeDefined();
    expect(edge(`${WF}/03`, "uses", "tool:runtests")).toBeDefined();
    expect(edge(`${WF}/05`, "uses", "tool:github/create_pull_request")).toBeDefined();
    expect(edge(`${WF}/04`, "writes", "artifact:docs/review.md")).toBeDefined();
  });

  it("makes agent-owned workflows performed_by that agent, and hand-offs gated delegations", () => {
    expect(edge("state:implementer/steps/01", "performed_by", "agent:implementer")).toBeDefined();
    expect(edge("gate:implementer/steps/03-check", "transitions_to", "state:implementer/steps/02")?.label).toBe("yes");
    expect(node("gate:implementer/steps/03-check")?.gateType).toBe("automated");
    expect(edge("state:implementer/steps/04", "delegates_to", "agent:reviewer")).toBeDefined();
    expect(edge("state:implementer/steps/04", "performed_by", "agent:reviewer")).toBeUndefined();
    const hand = "gate:implementer/steps/04-handoff";
    expect(node(hand)).toMatchObject({ gateType: "implicit", label: "Hand-off to reviewer?" });
    expect(edge("state:implementer/steps/04", "transitions_to", hand)).toBeDefined();
    expect(edge(hand, "transitions_to", `${WF}/04`)).toBeDefined();
  });

  it("gives skills a start condition", () => {
    expect(node("trigger:release/process/start")).toMatchObject({ label: 'Skill "release" is used' });
    expect(edge("trigger:release/process/start", "transitions_to", "state:release/process/01")).toBeDefined();
  });

  it("points prompts at the entry state of the agent they invoke", () => {
    expect(edge("prompt:new-feature", "invokes", `${WF}/01`)?.label).toBe("start");
  });

  it("extracts rules and anchors them when they mention something", () => {
    const rules = g.nodes.filter((n) => n.kind === "rule").map((n) => n.label);
    expect(rules).toEqual(expect.arrayContaining(["Never push directly to main.", "Always update CHANGELOG.md when behaviour changes.", "MUST use vitest.", "NEVER commit secrets to .env."]));
    expect(edge("rule:.github/copilot-instructions.md/always-update-changelog.md-when-behaviour-changes", "constrains", "artifact:changelog.md")).toBeDefined();
    expect(edge("rule:agents.md/never-commit-secrets-to-.env", "constrains", "artifact:.env")).toBeDefined();
    expect(edge("rule:agents.md/the-release-skill-is-only-run-by", "constrains", "skill:release")).toBeDefined();
    // "Keep tests next to…" is a plain bullet outside a Rules section: not a rule.
    expect(rules.some((r) => r.startsWith("Keep tests"))).toBe(false);
  });

  it("follows local markdown links", () => {
    expect(edge(CI, "references", "instruction:agents.md")).toBeDefined();
    expect(edge(CI, "references", "artifact:docs/style.md")).toBeDefined();
  });

  it("ignores content inside code fences", () => {
    expect(node("agent:ghost")).toBeUndefined();
  });
});

describe("scanRepo gates and stages", () => {
  function scanText(md: string, extra: Record<string, string> = {}) {
    const d = tempDir();
    mkdirSync(join(d, ".github/agents"), { recursive: true });
    writeFileSync(join(d, "AGENTS.md"), md);
    for (const [f, c] of Object.entries(extra)) writeFileSync(join(d, f), c);
    const r = scanRepo(d);
    expect(validateGraph(r).ok).toBe(true);
    return r;
  }

  it("uses a 'When …' sentence as the explicit start condition", () => {
    const r = scanText("# X\n\n## Workflow\n\nWhen an issue is labelled `agent`, the team runs:\n\n1. Plan it.\n2. Build it.\n");
    expect(r.nodes.find((n) => n.kind === "trigger")).toMatchObject({ label: "When an issue is labelled agent", props: { explicit: true } });
  });

  it("puts an approval gate before a step that starts with 'Only once …'", () => {
    const r = scanText("## Process\n\n1. Draft `PLAN.md`.\n2. Only once the plan is approved by a maintainer, implement it.\n3. Ship.\n");
    const gate = r.nodes.find((n) => n.kind === "gate")!;
    expect(gate).toMatchObject({ gateType: "human", id: "gate:agents.md/process/02-entry" });
    expect(gate.criteria![0]).toMatch(/Only once the plan is approved by a maintainer/);
    expect(r.edges.find((e) => e.from === "state:agents.md/process/01" && e.to === gate.id)).toBeDefined();
    expect(r.edges.find((e) => e.from === gate.id && e.to === "state:agents.md/process/02")?.label).toBe("pass");
    expect(r.edges.find((e) => e.from === gate.id && e.kind === "performed_by")?.to).toBe("actor:user");
  });

  it("puts an exit gate after a step that must pass", () => {
    const r = scanText("## Steps\n\n1. Write code; CI must pass before moving on.\n2. Merge.\n");
    const gate = r.nodes.find((n) => n.kind === "gate")!;
    expect(gate).toMatchObject({ id: "gate:agents.md/steps/01-exit", gateType: "automated" });
    expect(r.edges.find((e) => e.from === gate.id)?.to).toBe("state:agents.md/steps/02");
  });

  it("gives every agent without states a stage, and gates cross-agent transitions implicitly", () => {
    const r = scanText(
      "## Agents\n\n- **writer**: writes `draft.md`\n- **editor**: reads `draft.md`\n\n## Workflow\n\n1. @writer drafts and writes `draft.md`.\n2. @editor reads `draft.md` and edits it.\n",
      { ".github/agents/lonely.agent.md": "---\ndescription: Nobody calls me.\n---\nHi" },
    );
    const gate = r.nodes.find((n) => n.kind === "gate")!;
    expect(gate).toMatchObject({ gateType: "implicit", label: "writer → editor hand-off?", criteria: ["draft.md is produced"] });
    expect(r.nodes.find((n) => n.id === "state:agent/lonely")).toMatchObject({ label: "lonely", props: { stage: true } });
    expect(r.edges.find((e) => e.from === "state:agent/lonely" && e.kind === "performed_by")?.to).toBe("agent:lonely");
  });
});

describe("scanRepo edge cases", () => {
  it("returns an empty but valid graph for a repo with no harness", () => {
    const d = tempDir();
    const e = scanRepo(d, { name: "empty" });
    expect(e.nodes).toEqual([]);
    expect(validateGraph(e).ok).toBe(true);
    expect(e.meta.name).toBe("empty");
  });

  it("records displayRoot for remote scans", () => {
    expect(scanRepo(tempDir(), { displayRoot: "https://github.com/o/r" }).meta.root).toBe("https://github.com/o/r");
  });

  it("flags servers referenced but not configured, and supports Claude-style agents and step headings", () => {
    const d = tempDir();
    mkdirSync(join(d, ".claude/agents"), { recursive: true });
    writeFileSync(join(d, ".claude/agents/reviewer.md"), "---\nname: reviewer\ntools: Read, mcp__jira__get_issue\n---\n## Review process\n### Step 1: Read\nread `a.md`\n### Step 2: Report\nwrite `b.md`\n");
    writeFileSync(join(d, ".mcp.json"), '{"mcpServers":{}}');
    const r = scanRepo(d);
    expect(validateGraph(r).ok).toBe(true);
    expect(r.nodes.find((n) => n.id === "mcp_server:jira")).toMatchObject({ confidence: "inferred", props: { undeclared: true } });
    expect(r.edges.find((e) => e.from === "agent:reviewer" && e.to === "tool:jira/get_issue")).toBeDefined();
    expect(r.nodes.filter((n) => n.kind === "state").map((n) => n.label)).toEqual(["Step 1: Read", "Step 2: Report"]);
  });

  it("skips test fixtures so a tool's own examples are not mistaken for its harness", () => {
    const d = tempDir();
    mkdirSync(join(d, "test/fixtures/repo/.github"), { recursive: true });
    writeFileSync(join(d, "test/fixtures/repo/.github/copilot-instructions.md"), "# x");
    expect(scanRepo(d).meta.scannedFiles).toEqual([]);
  });

  it("survives malformed JSON config and frontmatter", () => {
    const d = tempDir();
    mkdirSync(join(d, ".vscode"));
    writeFileSync(join(d, ".vscode/mcp.json"), "{ not json");
    writeFileSync(join(d, "AGENTS.md"), "---\n: : :\n---\n# Hi");
    expect(validateGraph(scanRepo(d)).ok).toBe(true);
  });
});

describe("heuristic helpers", () => {
  it("classifyHeading", () => {
    expect(classifyHeading("Feature workflow")).toBe("workflow");
    expect(classifyHeading("Release process")).toBe("workflow");
    expect(classifyHeading("Rules")).toBe("rules");
    expect(classifyHeading("Agents")).toBe("agent");
    expect(classifyHeading("MCP servers")).toBe("mcp_server");
    expect(classifyHeading("MCP tools")).toBe("tool");
    expect(classifyHeading("Key files")).toBe("artifact");
    expect(classifyHeading("Background")).toBeNull();
  });
  it("verbBefore picks the nearest verb", () => {
    const t = "reads `a.md` and writes `b.md`";
    expect(verbBefore(t, t.indexOf("`a"))).toBe("reads");
    expect(verbBefore(t, t.indexOf("`b"))).toBe("writes");
    expect(verbBefore("see `x.md`", 4)).toBe("reads");
    expect(verbBefore("`out.json` is generated by CI", 0)).toBe("writes");
    expect(verbBefore("the `x.md` file", 4)).toBe("references");
  });
});
