import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildJsonSchema } from "../src/jsonSchema.js";
import { EDGE_KINDS, EDGE_RULES, NODE_ID_PATTERN, NODE_KINDS, edgeKey, emptyGraph, nodeId, slug } from "../src/schema.js";

describe("slug / nodeId", () => {
  it("lowercases and replaces unsafe characters", () => {
    expect(slug("My Agent (v2)")).toBe("my-agent-v2");
    expect(nodeId("agent", "Code Reviewer")).toBe("agent:code-reviewer");
  });
  it("keeps paths, dots and globs readable", () => {
    expect(slug(".github/copilot-instructions.md")).toBe(".github/copilot-instructions.md");
    expect(slug("**/*.test.ts")).toBe("**/*.test.ts");
    expect(slug("src\\win\\path")).toBe("src/win/path");
  });
  it("trims trailing punctuation and never returns empty", () => {
    expect(slug("Never push to main.")).toBe("never-push-to-main");
    expect(slug("!!!")).toBe("unnamed");
  });
  it("produces ids that match the id pattern", () => {
    for (const s of ["A b", "x/y.z", "**/*.md", "ünïcode name"]) expect(nodeId("artifact", s)).toMatch(new RegExp(NODE_ID_PATTERN));
  });
});

describe("EDGE_RULES", () => {
  it("covers every edge kind with valid node kinds", () => {
    for (const k of EDGE_KINDS) {
      const r = EDGE_RULES[k];
      expect(r).toBeDefined();
      for (const side of [r.from, r.to]) if (side !== "*") for (const nk of side) expect(NODE_KINDS).toContain(nk);
    }
  });
});

describe("helpers", () => {
  it("edgeKey is stable", () => expect(edgeKey({ from: "a:x", to: "b:y", kind: "uses" })).toBe("a:x|uses|b:y"));
  it("emptyGraph has the schema tag", () => {
    const g = emptyGraph("n", "/r");
    expect(g.schema).toBe("discovery-graph/2");
    expect(g.meta.scannedFiles).toEqual([]);
  });
});

describe("JSON Schema", () => {
  it("committed schema/graph.schema.json matches the generator (run `npm run build && node dist/bin.js schema > schema/graph.schema.json`)", () => {
    const committed = JSON.parse(readFileSync(resolve(__dirname, "../schema/graph.schema.json"), "utf8"));
    expect(committed).toEqual(buildJsonSchema());
  });
  it("enumerates every node and edge kind", () => {
    const s = JSON.stringify(buildJsonSchema());
    for (const k of [...NODE_KINDS, ...EDGE_KINDS]) expect(s).toContain(`"${k}"`);
  });
});
