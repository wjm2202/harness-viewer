import { describe, expect, it } from "vitest";
import { mergeGraphs } from "../src/merge.js";
import { e, graph, n } from "./helpers.js";

describe("mergeGraphs", () => {
  const scanned = graph([n("agent:a"), n("tool:t")], [e("agent:a", "uses", "tool:t")]);

  it("returns the scan untouched when there is no previous graph", () => {
    expect(mergeGraphs(null, scanned)).toEqual({ graph: scanned, droppedEdges: [], keptNodes: 0, keptEdges: 0 });
  });

  it("replaces old scan items but keeps agent/human enrichment", () => {
    const prev = graph(
      [n("agent:a"), n("agent:old"), n("state:s", { origin: "agent" }), n("actor:user", { origin: "human" })],
      [e("agent:old", "uses", "tool:t"), e("state:s", "performed_by", "agent:a", { origin: "agent" }), e("actor:user", "invokes", "agent:a", { origin: "human" })],
    );
    const r = mergeGraphs(prev, scanned);
    expect(r.graph.nodes.map((x) => x.id)).toEqual(["actor:user", "agent:a", "state:s", "tool:t"]);
    expect(r.graph.edges).toHaveLength(3);
    expect(r).toMatchObject({ keptNodes: 2, keptEdges: 2, droppedEdges: [] });
  });

  it("lets an agent override a scan node with the same id", () => {
    const prev = graph([n("agent:a", { origin: "agent", label: "Architect", description: "better" })]);
    expect(mergeGraphs(prev, scanned).graph.nodes.find((x) => x.id === "agent:a")).toMatchObject({ label: "Architect", origin: "agent" });
  });

  it("drops enrichment edges whose endpoint vanished, and reports them", () => {
    const prev = graph([n("state:s", { origin: "agent" })], [e("state:s", "performed_by", "agent:gone", { origin: "agent" })]);
    const r = mergeGraphs(prev, scanned);
    expect(r.droppedEdges).toHaveLength(1);
    expect(r.graph.edges.some((x) => x.to === "agent:gone")).toBe(false);
  });

  it("uses the new scan's meta", () => {
    const prev = graph([]);
    prev.meta.name = "old";
    expect(mergeGraphs(prev, scanned).graph.meta.name).toBe("t");
  });
});
