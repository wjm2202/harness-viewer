import { describe, expect, it } from "vitest";
import { NO_LANE, buildMachine, renderMermaid } from "../src/machine.js";
import { scanRepo } from "../src/scan/index.js";
import { FIXTURE, e, graph, n } from "./helpers.js";

const WF = "state:.github/copilot-instructions.md/feature-workflow";

describe("buildMachine on the sample repo", () => {
  const g = scanRepo(FIXTURE);
  const m = buildMachine(g);
  const main = m.workflows[0];
  const node = (id: string) => main.nodes.find((x) => x.id === id)!;

  it("orders workflows: biggest top-level first, sub-flows last", () => {
    expect(m.workflows.map((w) => [w.title, w.scope])).toEqual([
      ["Feature workflow", null],
      ["release (skill): Process", null],
      [expect.stringMatching(/^Sub-flow of: The @implementer/), `${WF}/02`],
    ]);
  });

  it("puts start conditions on rank 0 and flows downward", () => {
    expect(node("prompt:new-feature")).toMatchObject({ kind: "start", rank: 0 });
    expect(node("trigger:.github/copilot-instructions.md/feature-workflow/start")).toMatchObject({ kind: "start", rank: 0 });
    const r = (id: string) => node(id).rank;
    expect(r(`${WF}/01`)).toBe(1);
    expect(r("gate:handoff/planner-to-implementer")).toBe(2);
    expect(r(`${WF}/02`)).toBe(3);
    expect(r(`${WF}/05`)).toBeGreaterThan(r(`${WF}/04`));
    expect(main.nodes.find((x) => x.kind === "end")!.rank).toBe(r(`${WF}/05`) + 1);
  });

  it("marks the retry loop as a back edge and nothing else", () => {
    expect(main.edges.filter((x) => x.back)).toEqual([{ from: "gate:.github/copilot-instructions.md/feature-workflow/03-check", to: `${WF}/02`, label: "yes", back: true }]);
  });

  it("uses one lane per agent in order of appearance, unassigned last", () => {
    expect(main.lanes.map((l) => [l.label, l.kind])).toEqual([["planner", "agent"], ["implementer", "agent"], ["reviewer", "agent"], ["unassigned", "none"]]);
    expect(node(`${WF}/01`).lane).toBe("agent:planner");
    expect(node("gate:handoff/planner-to-implementer").lane).toBe("agent:planner");
    expect(node("prompt:new-feature").lane).toBe("agent:planner");
    expect(node(`${WF}/03`).lane).toBe(NO_LANE);
  });

  it("places side-by-side nodes in separate slots and widens the lane", () => {
    expect(node("prompt:new-feature").sub).not.toBe(node("trigger:.github/copilot-instructions.md/feature-workflow/start").sub);
    expect(main.lanes[0].width).toBe(2);
  });

  it("flags compound states and draws ghosts for exits out of a sub-flow", () => {
    expect(node(`${WF}/02`).compound).toBe(true);
    const sub = m.workflows[2];
    const ghost = sub.nodes.find((x) => x.kind === "ghost")!;
    expect(ghost).toMatchObject({ ref: `${WF}/04`, lane: "agent:implementer" });
    expect(sub.edges.some((x) => x.to === ghost.id && x.label === "pass")).toBe(true);
  });
});

describe("buildMachine edge cases", () => {
  it("is empty for a graph without states", () => {
    expect(buildMachine(graph([n("agent:a")])).workflows).toEqual([]);
  });
  it("ignores triggers that start nothing (e.g. hooks)", () => {
    const m = buildMachine(graph([n("trigger:hook"), n("state:a", { initial: true, terminal: true })]));
    expect(m.workflows).toHaveLength(1);
    expect(m.workflows[0].nodes.map((x) => x.id)).toEqual(["state:a", "end:state:a"]);
  });
  it("uses the first state's label as the title when no workflow name is known", () => {
    const m = buildMachine(graph([n("state:a", { label: "Do it" }), n("state:b")], [e("state:a", "transitions_to", "state:b")]));
    expect(m.workflows[0].title).toBe("Do it");
  });
});

describe("renderMermaid", () => {
  const md = renderMermaid(scanRepo(FIXTURE));
  it("emits a top-to-bottom stateDiagram per workflow", () => {
    expect(md.match(/```mermaid\nstateDiagram-v2\n {2}direction TB/g)).toHaveLength(3);
  });
  it("draws starts as [*] with their condition, gates as ◇ with criteria notes, ends as [*]", () => {
    expect(md).toContain("[*] --> s1 : /new-feature");
    expect(md).toContain('state "◇ Start implementation?" as g2');
    expect(md).toContain("note right of g2");
    expect(md).toMatch(/s\d+ --> \[\*\]/);
    expect(md).toContain('state "planner: The @planner reads the issue and writes docs/PLAN.md." as s1');
  });
  it("escapes quotes and says so when there is nothing to draw", () => {
    const g = graph([n("state:a", { label: 'Say "hi"', initial: true, terminal: true })]);
    expect(renderMermaid(g)).toContain("Say 'hi'");
    expect(renderMermaid(graph([]))).toContain("_No workflows found._");
  });
});
