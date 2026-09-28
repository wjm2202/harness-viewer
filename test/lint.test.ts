import { describe, expect, it } from "vitest";
import { LINT_RULES, components, cycles, lintGraph, renderLintMarkdown, type LintRuleName } from "../src/lint.js";
import { scanRepo } from "../src/scan/index.js";
import type { Graph } from "../src/schema.js";
import { FIXTURE, e, graph, n } from "./helpers.js";

const rules = (g: Graph) => lintGraph(g).findings.map((f) => f.rule);
const fired = (g: Graph, rule: LintRuleName) => lintGraph(g).findings.filter((f) => f.rule === rule);

describe("lintGraph rules", () => {
  it("schema: stops at validation errors", () => {
    const r = lintGraph(graph([n("agent:a")], [e("agent:a", "uses", "tool:x")]));
    expect(r.findings.every((f) => f.rule === "schema")).toBe(true);
    expect(r.counts.error).toBeGreaterThan(0);
  });

  it("orphan (but not for MCP servers, which have their own rule)", () => {
    expect(fired(graph([n("agent:a"), n("mcp_server:s")]), "orphan").map((f) => f.nodes[0])).toEqual(["agent:a"]);
  });

  it("low-evidence for non-human nodes without a source", () => {
    expect(fired(graph([n("agent:a", { source: undefined }), n("actor:u", { source: undefined, origin: "human" })]), "low-evidence")).toHaveLength(1);
  });

  it("unused-mcp-server / undeclared-mcp-server / broad-tool-grant / unused-tool", () => {
    const g = graph(
      [n("mcp_server:s"), n("mcp_server:u", { props: { undeclared: true } }), n("tool:s/t"), n("agent:a")],
      [e("mcp_server:s", "provides", "tool:s/t"), e("agent:a", "uses", "mcp_server:u")],
    );
    expect(fired(g, "unused-mcp-server").map((f) => f.nodes[0])).toEqual(["mcp_server:s"]);
    expect(fired(g, "undeclared-mcp-server").map((f) => f.nodes[0])).toEqual(["mcp_server:u"]);
    expect(fired(g, "broad-tool-grant")).toHaveLength(1);
    expect(fired(g, "unused-tool").map((f) => f.nodes[0])).toEqual(["tool:s/t"]);
  });

  it("a server whose tool is used is not unused", () => {
    const g = graph([n("mcp_server:s"), n("tool:s/t"), n("agent:a")], [e("mcp_server:s", "provides", "tool:s/t"), e("agent:a", "uses", "tool:s/t")]);
    expect(rules(g)).not.toContain("unused-mcp-server");
  });

  it("state-dead-end / state-unreachable / state-no-actor / no-start-condition", () => {
    const g = graph([n("state:a"), n("state:b"), n("state:c", { initial: true, terminal: true })], [e("state:a", "transitions_to", "state:b")]);
    expect(fired(g, "state-dead-end").map((f) => f.nodes[0])).toEqual(["state:b"]);
    expect(fired(g, "state-unreachable").map((f) => f.nodes[0])).toEqual(["state:a"]);
    expect(fired(g, "state-no-actor")).toHaveLength(3);
    expect(fired(g, "no-start-condition").map((f) => f.nodes)).toEqual([["state:a", "state:b"], ["state:c"]]);
  });

  it("an invoked state counts as reachable and as a started workflow", () => {
    const g = graph([n("prompt:p"), n("state:a"), n("state:b", { terminal: true })], [e("prompt:p", "invokes", "state:a"), e("state:a", "transitions_to", "state:b")]);
    expect(rules(g)).not.toContain("state-unreachable");
    expect(rules(g)).not.toContain("no-start-condition");
  });

  it("start-condition-implicit when every start is an unexplained trigger", () => {
    const g = graph([n("trigger:t", { props: { explicit: false } }), n("state:a", { terminal: true })], [e("trigger:t", "transitions_to", "state:a")]);
    expect(fired(g, "start-condition-implicit")).toHaveLength(1);
    g.nodes[0].props = { explicit: true };
    expect(fired(g, "start-condition-implicit")).toHaveLength(0);
  });

  it("gate rules: implicit, no criteria, dead end, no fail path, no evaluator", () => {
    const g = graph(
      [n("state:a", { initial: true }), n("state:b", { terminal: true }), n("gate:imp", { gateType: "implicit" }), n("gate:bare", { gateType: "agent" }), n("gate:ok", { gateType: "automated", criteria: ["tests pass"] }), n("tool:t")],
      [e("state:a", "transitions_to", "gate:imp"), e("gate:imp", "transitions_to", "state:b"), e("state:a", "transitions_to", "gate:bare"), e("state:a", "transitions_to", "gate:ok"),
       e("gate:ok", "transitions_to", "state:b"), e("gate:ok", "transitions_to", "state:a", { label: "fail" }), e("gate:ok", "uses", "tool:t")],
    );
    expect(fired(g, "implicit-gate").map((f) => f.nodes[0])).toEqual(["gate:imp"]);
    expect(fired(g, "gate-no-criteria").map((f) => f.nodes[0])).toEqual(["gate:bare"]);
    expect(fired(g, "gate-dead-end").map((f) => f.nodes[0])).toEqual(["gate:bare"]);
    expect(fired(g, "gate-no-fail-path").map((f) => f.nodes[0])).toEqual(["gate:imp"]);
    expect(fired(g, "gate-no-evaluator").map((f) => f.nodes[0])).toEqual(["gate:bare"]);
  });

  it("artifact-contention / dead-output / external-input (via states' actors too)", () => {
    const g = graph(
      [n("agent:a"), n("agent:b"), n("state:s", { initial: true, terminal: true }), n("artifact:x"), n("artifact:in")],
      [e("agent:a", "writes", "artifact:x"), e("state:s", "performed_by", "agent:b"), e("state:s", "writes", "artifact:x"), e("agent:a", "reads", "artifact:in")],
    );
    expect(fired(g, "artifact-contention")[0].message).toMatch(/written by 2 agents: a, b/);
    expect(fired(g, "artifact-dead-output").map((f) => f.nodes[0])).toEqual(["artifact:x"]);
    expect(fired(g, "artifact-external-input").map((f) => f.nodes[0])).toEqual(["artifact:in"]);
  });

  it("agent-no-tools / agent-no-entry / delegation-cycle", () => {
    const g = graph([n("agent:a"), n("agent:b"), n("agent:c")], [e("agent:a", "delegates_to", "agent:b"), e("agent:b", "delegates_to", "agent:a")]);
    expect(fired(g, "agent-no-tools")).toHaveLength(3);
    expect(fired(g, "agent-no-entry").map((f) => f.nodes[0])).toEqual(["agent:c"]);
    expect(fired(g, "delegation-cycle")[0].message).toBe("delegation loop: a → b → a");
  });

  it("rule-unanchored", () => {
    const g = graph([n("rule:r1"), n("rule:r2"), n("tool:t")], [e("rule:r2", "constrains", "tool:t")]);
    expect(fired(g, "rule-unanchored").map((f) => f.nodes[0])).toEqual(["rule:r1"]);
  });

  it("uses the severity declared in LINT_RULES and sorts errors → warnings → notes", () => {
    const r = lintGraph(scanRepo(FIXTURE));
    for (const f of r.findings) expect(f.severity).toBe(LINT_RULES[f.rule as LintRuleName].severity);
    const order = r.findings.map((f) => ({ error: 0, warn: 1, info: 2 })[f.severity]);
    expect(order).toEqual([...order].sort());
  });
});

describe("metrics and report", () => {
  it("computes counts, workflows, inferred share and hotspots", () => {
    const r = lintGraph(scanRepo(FIXTURE));
    expect(r.metrics.nodes.agent).toBe(3);
    expect(r.metrics.workflows).toBe(2);
    expect(r.metrics.inferredShare).toBeGreaterThan(0);
    expect(r.metrics.hotspots[0].degree).toBeGreaterThanOrEqual(r.metrics.hotspots[1].degree);
  });
  it("renders markdown with sections and rule rationale", () => {
    const g = scanRepo(FIXTURE);
    const md = renderLintMarkdown(g, lintGraph(g));
    expect(md).toMatch(/^# Harness lint — acme-harness/);
    expect(md).toContain("## Warnings");
    expect(md).toContain("### `unused-mcp-server`");
    expect(md).toContain(LINT_RULES["unused-mcp-server"].why);
  });
});

describe("graph helpers", () => {
  it("components are weakly connected", () => {
    expect(components(["a", "b", "c"], [e("a", "transitions_to", "b")])).toEqual([["a", "b"], ["c"]]);
  });
  it("cycles are reported once, rotated to the smallest id", () => {
    const c = cycles(["a", "b", "c"], [e("b", "delegates_to", "c"), e("c", "delegates_to", "b"), e("a", "delegates_to", "b")]);
    expect(c).toEqual([["b", "c"]]);
    expect(cycles(["a", "b"], [e("a", "delegates_to", "b")])).toEqual([]);
  });
});
