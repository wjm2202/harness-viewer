import { describe, expect, it } from "vitest";
import { GraphBuilder } from "../src/builder.js";

describe("GraphBuilder", () => {
  it("upgrades an inferred node when a declared version arrives, merging props", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "agent:a", kind: "agent", label: "a (mention)", confidence: "inferred", description: "from prose", props: { x: 1 } });
    b.addNode({ id: "agent:a", kind: "agent", label: "a", confidence: "declared", source: { file: "a.agent.md", line: 1 }, props: { model: "m" } });
    const n = b.get("agent:a")!;
    expect(n).toMatchObject({ label: "a", confidence: "declared", source: { file: "a.agent.md", line: 1 }, description: "from prose" });
    expect(n.props).toEqual({ x: 1, model: "m" });
  });
  it("keeps the declared version when an inferred one arrives later", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "tool:t", kind: "tool", label: "T", confidence: "declared" });
    b.addNode({ id: "tool:t", kind: "tool", label: "t?", confidence: "inferred" });
    expect(b.get("tool:t")).toMatchObject({ label: "T", confidence: "declared" });
  });
  it("preserves initial/terminal flags across merges", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "state:s", kind: "state", label: "s", initial: true });
    b.addNode({ id: "state:s", kind: "state", label: "s", terminal: true });
    expect(b.get("state:s")).toMatchObject({ initial: true, terminal: true });
  });
  it("dedupes edges (higher confidence wins), drops self-loops and dangling edges", () => {
    const b = new GraphBuilder();
    b.addNode({ id: "agent:a", kind: "agent", label: "a" });
    b.addNode({ id: "tool:t", kind: "tool", label: "t" });
    b.addEdge({ from: "agent:a", to: "tool:t", kind: "uses", confidence: "inferred" });
    b.addEdge({ from: "agent:a", to: "tool:t", kind: "uses", confidence: "declared" });
    b.addEdge({ from: "agent:a", to: "agent:a", kind: "references" });
    b.addEdge({ from: "agent:a", to: "tool:ghost", kind: "uses" });
    const g = b.build("n", "/r", ["b.md", "a.md"]);
    expect(g.edges).toEqual([{ from: "agent:a", to: "tool:t", kind: "uses", origin: "scan", confidence: "declared" }]);
    expect(g.meta.scannedFiles).toEqual(["a.md", "b.md"]);
    expect(g.nodes.map((x) => x.id)).toEqual(["agent:a", "tool:t"]);
  });
  it("uses the default origin and falls back to the id for blank labels", () => {
    const b = new GraphBuilder("agent");
    expect(b.addNode({ id: "rule:r", kind: "rule", label: "  " })).toMatchObject({ origin: "agent", label: "rule:r" });
  });
});
