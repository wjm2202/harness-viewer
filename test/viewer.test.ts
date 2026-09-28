import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { lintGraph } from "../src/lint.js";
import { buildMachine } from "../src/machine.js";
import { scanRepo } from "../src/scan/index.js";
import { embedJson, renderViewer } from "../src/viewer.js";
import { FIXTURE, graph, n } from "./helpers.js";

type Api = { select: (id: string) => void; gotoNode: (id: string) => void; openSub: (id: string) => boolean; setView: (v: string) => void; state: () => { view: string; wf: number; sel: string | null } };

function load(html: string) {
  const errors: string[] = [];
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  dom.window.addEventListener("error", (e) => errors.push(String(e.message)));
  const w = dom.window as unknown as Window & { __harnessGraph: Api };
  return { w, doc: w.document, api: w.__harnessGraph, errors };
}

const WF = "state:.github/copilot-instructions.md/feature-workflow";

describe("embedJson", () => {
  it("cannot break out of a script tag and round-trips", () => {
    const v = { s: "</script><script>alert(1)</script> &  " };
    const out = embedJson(v);
    expect(out).not.toContain("</script>");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out)).toEqual(v);
  });
});

describe("renderViewer", () => {
  const g = scanRepo(FIXTURE);
  const html = renderViewer(g, lintGraph(g));
  const machine = buildMachine(g);

  it("is a single self-contained file (no external resources)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/\b(src|href)="https?:/);
  });

  it("escapes the title", () => {
    const g2 = graph([n("agent:a")]);
    g2.meta.name = "<b>x</b>";
    expect(renderViewer(g2, lintGraph(g2))).toContain("<title>&lt;b&gt;x&lt;/b&gt; · harness state machine</title>");
  });

  it("opens on the state machine: start at the top, agent lanes, gates as diamonds, an end marker", () => {
    const { doc, errors } = load(html);
    expect(errors).toEqual([]);
    expect(doc.getElementById("title")!.textContent).toBe("acme-harness");
    const wf = machine.workflows[0];
    expect(doc.querySelectorAll("#nodes .n")).toHaveLength(wf.nodes.length);
    expect(doc.querySelectorAll('#nodes .n[data-kind="start"]').length).toBe(2);
    expect(doc.querySelectorAll('#nodes .n[data-kind="gate"] polygon').length).toBe(2);
    expect(doc.querySelectorAll('#nodes .n[data-kind="end"]').length).toBe(1);
    const lanes = [...doc.querySelectorAll("#lanes .lane-h")].map((t) => t.textContent);
    expect(lanes).toEqual(["planner", "implementer", "reviewer", "unassigned"]);
    expect(doc.querySelectorAll("#edges .e.back").length).toBe(1);
    // start is drawn above the first stage (top → bottom)
    const y = (id: string) => Number(doc.querySelector(`#nodes .n[data-id="${id}"]`)!.getAttribute("transform")!.match(/,([\d.-]+)\)/)![1]);
    expect(y("prompt:new-feature")).toBeLessThan(y(`${WF}/01`));
    expect(y(`${WF}/01`)).toBeLessThan(y("gate:handoff/planner-to-implementer"));
    expect(y("gate:handoff/planner-to-implementer")).toBeLessThan(y(`${WF}/02`));
  });

  it("lists every workflow and sub-flow in the picker", () => {
    const { doc } = load(html);
    const opts = [...doc.querySelectorAll("#wf option")].map((o) => o.textContent!);
    expect(opts).toHaveLength(machine.workflows.length);
    expect(opts[0]).toMatch(/^Feature workflow/);
    expect(opts.some((o) => o.includes("↳ Sub-flow of"))).toBe(true);
  });

  it("selecting a gate shows its criteria and evaluator", () => {
    const { doc, api } = load(html);
    api.select("gate:handoff/planner-to-implementer");
    const detail = doc.getElementById("detail")!.textContent!;
    expect(detail).toContain("Criteria to pass");
    expect(detail).toContain('User starts the "Start implementation" hand-off from planner');
    expect(detail).toContain("Who");
    expect(detail).toContain("user (human approver)");
    expect(doc.querySelectorAll("#nodes .n.sel")).toHaveLength(1);
    expect(doc.querySelectorAll("#nodes .n.dim").length).toBeGreaterThan(0);
  });

  it("selecting a stage shows who, inputs, outputs, and opens its sub-flow", () => {
    const { doc, api } = load(html);
    api.select(`${WF}/02`);
    const detail = doc.getElementById("detail")!.textContent!;
    expect(detail).toContain("Needs (inputs)");
    expect(detail).toContain("docs/PLAN.md");
    expect(detail).toContain("Produces (outputs)");
    expect(detail).toContain("Open sub-flow");
    expect(api.openSub(`${WF}/02`)).toBe(true);
    expect(doc.getElementById("crumb")!.style.display).toBe("block");
    expect(doc.querySelectorAll('#nodes .n[data-kind="ghost"]').length).toBe(1);
  });

  it("gotoNode jumps to the right workflow, or to the knowledge graph for non-flow nodes", () => {
    const { api } = load(html);
    api.gotoNode("state:release/process/02");
    expect(api.state().view).toBe("sm");
    expect(machine.workflows[api.state().wf].title).toMatch(/release/);
    api.gotoNode("tool:bash");
    expect(api.state().view).toBe("kg");
    expect(api.state().sel).toBe("tool:bash");
  });

  it("the knowledge graph view renders every visible node; rules reveal on select", () => {
    const { doc, api } = load(html);
    api.setView("kg");
    const visible = g.nodes.filter((x) => x.kind !== "rule").length;
    expect(doc.querySelectorAll("#nodes .node")).toHaveLength(visible);
    api.select(g.nodes.find((x) => x.kind === "rule")!.id);
    expect(doc.querySelectorAll("#nodes .node").length).toBeGreaterThan(visible);
  });

  it("search dims non-matching nodes", () => {
    const { w, doc } = load(html);
    const q = doc.getElementById("q") as HTMLInputElement;
    q.value = "planner";
    q.dispatchEvent(new (w as unknown as { Event: typeof Event }).Event("input"));
    expect(doc.querySelectorAll("#nodes .n.dim").length).toBeGreaterThan(0);
    expect(doc.querySelectorAll("#nodes .n:not(.dim)").length).toBeGreaterThan(0);
  });

  it("findings list is clickable", () => {
    const { doc } = load(html);
    expect(doc.querySelectorAll("#findings .f")).toHaveLength(lintGraph(g).findings.length);
  });

  it("renders an empty graph with a helpful message", () => {
    const e = graph([]);
    const { doc, errors } = load(renderViewer(e, lintGraph(e)));
    expect(errors).toEqual([]);
    expect(doc.getElementById("nodes")!.textContent).toContain("No workflows found");
  });
});
