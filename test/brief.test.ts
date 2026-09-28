import { describe, expect, it } from "vitest";
import { EDGE_MEANING, NODE_MEANING, renderBrief } from "../src/brief.js";
import { lintGraph } from "../src/lint.js";
import { scanRepo } from "../src/scan/index.js";
import { EDGE_KINDS, NODE_KINDS } from "../src/schema.js";
import { FIXTURE, tempDir } from "./helpers.js";

const opts = { graphPath: ".discovery-graph/graph.json", cli: "npx discovery-graph" };

describe("renderBrief", () => {
  const g = scanRepo(FIXTURE);
  const md = renderBrief(g, lintGraph(g), opts);

  it("lists every scanned file for the agent to read", () => {
    for (const f of g.meta.scannedFiles) expect(md).toContain(`\`${f}\``);
  });
  it("explains every node and edge kind with its endpoint rules", () => {
    for (const k of NODE_KINDS) expect(md).toContain(`| \`${k}\` | ${NODE_MEANING[k]}`);
    for (const k of EDGE_KINDS) expect(md).toContain(`| \`${k}\` | ${EDGE_MEANING[k]}`);
    expect(md).toContain("| `transitions_to` | is followed by (put the condition in `label`) | trigger, state, gate | state, gate |");
  });
  it("tells the agent the editing rules and the validate/lint/view loop", () => {
    expect(md).toContain('Never delete or edit items with `"origin": "scan"`');
    expect(md).toContain("npx discovery-graph validate .discovery-graph/graph.json");
    expect(md).toContain("npx discovery-graph lint .discovery-graph/graph.json");
    expect(md).toContain("`.discovery-graph/REVIEW.md`");
    expect(md).toContain("## Eval opportunities");
  });
  it("keeps the agent focused on the workflow, not the application code", () => {
    expect(md).toContain("Scope: the agent workflow, not the application.");
    expect(md).toContain("Do NOT review, summarise or map the application's source code");
    expect(md).toContain("**Start condition.**");
    expect(md).toContain("**Gates.**");
    expect(md).toContain("`gateType`");
  });
  it("includes the gaps the scan already sees", () => {
    expect(md).toMatch(/\[unused-mcp-server\] MCP server "unused"/);
    expect(md).toMatch(/\[state-no-actor\]/);
  });
  it("has example JSON that is valid for the vocabulary", () => {
    const json = md.split("```json\n")[1].split("\n```")[0].split("\n").map((l) => JSON.parse(l));
    expect(NODE_KINDS).toContain(json[0].kind);
    expect(json[1]).toMatchObject({ kind: "gate", gateType: "automated" });
    expect(EDGE_KINDS).toContain(json[2].kind);
  });
  it("adds clone instructions for remote repos and a hint for empty ones", () => {
    const r = scanRepo(tempDir(), { displayRoot: "https://github.com/o/r" });
    const b = renderBrief(r, lintGraph(r), opts);
    expect(b).toContain("git clone --depth 1 https://github.com/o/r");
    expect(b).toContain("_(none — look for README");
  });
});
