import { describe, expect, it } from "vitest";
import { assertValid, validateGraph } from "../src/validate.js";
import { e, graph, n } from "./helpers.js";

const msgs = (doc: unknown) => validateGraph(doc).errors.map((x) => `${x.path}: ${x.message}`).join("\n");

describe("validateGraph", () => {
  it("accepts a minimal valid graph", () => {
    const g = graph([n("agent:a"), n("tool:t")], [e("agent:a", "uses", "tool:t")]);
    expect(validateGraph(g)).toEqual({ ok: true, errors: [] });
    expect(() => assertValid(g)).not.toThrow();
  });

  it("rejects non-objects and wrong top-level shapes", () => {
    expect(validateGraph(null).ok).toBe(false);
    expect(validateGraph([]).ok).toBe(false);
    expect(msgs({ schema: "x", meta: {}, nodes: {}, edges: [] })).toMatch(/\$\.schema[\s\S]*\$\.meta\.name[\s\S]*\$\.nodes/);
  });

  it("checks ids: pattern, kind prefix, duplicates", () => {
    expect(msgs(graph([n("agent:a", { id: "Agent A" })]))).toMatch(/\.id: must match/);
    expect(msgs(graph([n("agent:a", { kind: "tool" })]))).toMatch(/prefixed with its kind/);
    expect(msgs(graph([n("agent:a"), n("agent:a")]))).toMatch(/duplicate node id/);
  });

  it("checks enums and labels", () => {
    expect(msgs(graph([n("agent:a", { kind: "robot" as never, id: "robot:a" })]))).toMatch(/unknown kind "robot"/);
    expect(msgs(graph([n("agent:a", { origin: "ai" as never })]))).toMatch(/origin/);
    expect(msgs(graph([n("agent:a", { confidence: "sure" as never })]))).toMatch(/confidence/);
    expect(msgs(graph([n("agent:a", { label: " " })]))).toMatch(/label/);
  });

  it("checks source refs and state-only flags", () => {
    expect(msgs(graph([n("agent:a", { source: { file: "x", line: 0 } })]))).toMatch(/line: must be a positive number/);
    expect(msgs(graph([n("agent:a", { source: "x" as never })]))).toMatch(/source: must be/);
    expect(msgs(graph([n("agent:a", { initial: true })]))).toMatch(/only apply to state/);
    expect(validateGraph(graph([n("state:s", { initial: true, terminal: true })])).ok).toBe(true);
  });

  it("checks edges: unknown kind, dangling endpoints, duplicates", () => {
    expect(msgs(graph([n("agent:a")], [e("agent:a", "likes" as never, "agent:a")]))).toMatch(/unknown kind "likes"/);
    expect(msgs(graph([n("agent:a")], [e("agent:a", "uses", "tool:missing")]))).toMatch(/unknown node "tool:missing"/);
    const g = graph([n("agent:a"), n("tool:t")], [e("agent:a", "uses", "tool:t"), e("agent:a", "uses", "tool:t")]);
    expect(msgs(g)).toMatch(/duplicate edge/);
  });

  it("enforces endpoint kinds per edge kind", () => {
    const g = graph([n("agent:a"), n("state:s"), n("artifact:f")], [
      e("agent:a", "transitions_to", "state:s"),
      e("state:s", "reads", "agent:a"),
    ]);
    const m = msgs(g);
    expect(m).toMatch(/"transitions_to" cannot start at a agent/);
    expect(m).toMatch(/"reads" cannot end at a agent/);
  });

  it("accepts v1 documents and rejects unknown versions", () => {
    const g = graph([n("agent:a")]);
    (g as { schema: string }).schema = "discovery-graph/1";
    expect(validateGraph(g).ok).toBe(true);
    (g as { schema: string }).schema = "discovery-graph/9";
    expect(validateGraph(g).ok).toBe(false);
  });

  it("checks gate-only and state-only fields", () => {
    expect(validateGraph(graph([n("gate:g", { criteria: ["x"], gateType: "human" })])).ok).toBe(true);
    expect(msgs(graph([n("state:s", { criteria: ["x"] })]))).toMatch(/criteria\/gateType only apply to gate/);
    expect(msgs(graph([n("gate:g", { criteria: "x" as never })]))).toMatch(/criteria: must be an array of strings/);
    expect(msgs(graph([n("gate:g", { gateType: "robot" as never })]))).toMatch(/gateType: must be one of/);
  });

  it("checks parent: must be a state, no self/loops", () => {
    expect(validateGraph(graph([n("state:p"), n("state:c", { parent: "state:p" })])).ok).toBe(true);
    expect(msgs(graph([n("state:c", { parent: "agent:a" }), n("agent:a")]))).toMatch(/must be the id of a state/);
    expect(msgs(graph([n("gate:g", { parent: "state:p" } as never), n("state:p")]))).toMatch(/parent only applies to state/);
    expect(msgs(graph([n("state:a", { parent: "state:b" }), n("state:b", { parent: "state:a" })]))).toMatch(/loops back/);
  });

  it("allows state → gate → state transitions and triggers as starts", () => {
    const g = graph([n("trigger:t"), n("state:a"), n("gate:g"), n("state:b")], [e("trigger:t", "transitions_to", "state:a"), e("state:a", "transitions_to", "gate:g"), e("gate:g", "transitions_to", "state:b")]);
    expect(validateGraph(g).ok).toBe(true);
  });

  it("allows `references` between anything", () => {
    expect(validateGraph(graph([n("rule:r"), n("tool:t")], [e("tool:t", "references", "rule:r")])).ok).toBe(true);
  });

  it("assertValid throws with every error listed", () => {
    expect(() => assertValid({})).toThrow(/Invalid graph/);
  });
});
