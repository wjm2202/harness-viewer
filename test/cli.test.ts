import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, parseArgs, VERSION } from "../src/cli.js";
import type { Graph } from "../src/schema.js";
import { FIXTURE, io, tempDir, tempFixture } from "./helpers.js";

describe("parseArgs", () => {
  it("defaults to `all` and parses flags", () => {
    expect(parseArgs([])).toEqual({ cmd: "all", positional: [], flags: {} });
    expect(parseArgs(["./repo", "--out", "x"])).toEqual({ cmd: "all", positional: ["./repo"], flags: { out: "x" } });
    expect(parseArgs(["lint", "g.json", "--strict", "--json"])).toEqual({ cmd: "lint", positional: ["g.json"], flags: { strict: true, json: true } });
    expect(parseArgs(["scan", "--out=o"]).flags).toEqual({ out: "o" });
    expect(parseArgs(["-h"]).flags.help).toBe(true);
  });
});

describe("main", () => {
  it("prints help and version", async () => {
    const t = io(".");
    expect(await main(["--help"], t)).toBe(0);
    expect(t.stdout[0]).toContain("Usage");
    const v = io(".");
    expect(await main(["--version"], v)).toBe(0);
    expect(v.stdout).toEqual([VERSION]);
  });

  it("`all` writes graph, brief, lint and viewer into <repo>/.discovery-graph", async () => {
    const repo = tempFixture();
    const t = io(repo);
    expect(await main([], t)).toBe(0);
    for (const f of ["graph.json", "AGENT_BRIEF.md", "lint.md", "index.html", "statemachine.md"]) expect(existsSync(join(repo, ".discovery-graph", f))).toBe(true);
    const outText = t.stdout.join("\n");
    expect(outText).toContain(`scanning ${repo}`);
    expect(outText).toContain("  · .github/copilot-instructions.md");
    expect(outText).toMatch(/scan: 9 harness files → \d+ nodes/);
    expect(outText).toMatch(/flow: {2}2 workflow\(s\), \d+ gates/);
    expect(readFileSync(join(repo, ".discovery-graph/statemachine.md"), "utf8")).toContain("stateDiagram-v2");
    expect(t.stdout.join("\n")).toContain('next: ask your AI agent → "Follow .discovery-graph/AGENT_BRIEF.md"');
    expect(readFileSync(join(repo, ".discovery-graph/AGENT_BRIEF.md"), "utf8")).toContain("`.discovery-graph/graph.json`");
  });

  it("`scan` only writes the graph; `brief` adds the brief", async () => {
    const repo = tempFixture();
    expect(await main(["scan"], io(repo))).toBe(0);
    expect(existsSync(join(repo, ".discovery-graph/AGENT_BRIEF.md"))).toBe(false);
    expect(await main(["brief", "."], io(repo))).toBe(0);
    expect(existsSync(join(repo, ".discovery-graph/AGENT_BRIEF.md"))).toBe(true);
    expect(existsSync(join(repo, ".discovery-graph/index.html"))).toBe(false);
  });

  it("re-scanning keeps agent enrichment and reports dropped edges", async () => {
    const repo = tempFixture();
    await main(["scan"], io(repo));
    const p = join(repo, ".discovery-graph/graph.json");
    const g = JSON.parse(readFileSync(p, "utf8")) as Graph;
    g.nodes.push({ id: "actor:maintainer", kind: "actor", label: "maintainer", origin: "agent", confidence: "inferred", source: { file: "AGENTS.md", line: 4 } });
    g.edges.push({ from: "actor:maintainer", to: "skill:release", kind: "invokes", origin: "agent", confidence: "inferred" });
    g.edges.push({ from: "actor:maintainer", to: "agent:gone", kind: "delegates_to", origin: "agent", confidence: "inferred" } as never);
    writeFileSync(p, JSON.stringify(g));
    const t = io(repo);
    expect(await main(["scan"], t)).toBe(0);
    const after = JSON.parse(readFileSync(p, "utf8")) as Graph;
    expect(after.nodes.some((x) => x.id === "actor:maintainer")).toBe(true);
    expect(after.edges.some((x) => x.from === "actor:maintainer" && x.to === "skill:release")).toBe(true);
    expect(t.stdout.join("\n")).toContain("kept 1 enriched nodes, 1 enriched edges");
    expect(t.stderr.join("\n")).toContain("dropped enriched edge actor:maintainer —delegates_to→ agent:gone");
  });

  it("validate: 0 on valid, 1 on invalid, 2 when missing", async () => {
    const repo = tempFixture();
    await main(["scan"], io(repo));
    expect(await main(["validate"], io(repo))).toBe(0);
    expect(await main(["validate", ".discovery-graph"], io(repo))).toBe(0);
    const p = join(repo, ".discovery-graph/graph.json");
    const g = JSON.parse(readFileSync(p, "utf8"));
    g.edges.push({ from: "agent:planner", to: "agent:planner2", kind: "uses", origin: "agent", confidence: "inferred" });
    writeFileSync(p, JSON.stringify(g));
    const t = io(repo);
    expect(await main(["validate"], t)).toBe(1);
    expect(t.stderr.join("\n")).toContain('unknown node "agent:planner2"');
    expect(await main(["validate", "nope.json"], io(repo))).toBe(2);
    writeFileSync(p, "{");
    const bad = io(repo);
    expect(await main(["validate"], bad)).toBe(2);
    expect(bad.stderr[0]).toMatch(/not valid JSON/);
  });

  it("lint: writes lint.md, supports --json and --strict", async () => {
    const repo = tempFixture();
    await main(["scan"], io(repo));
    const t = io(repo);
    expect(await main(["lint"], t)).toBe(0);
    expect(existsSync(join(repo, ".discovery-graph/lint.md"))).toBe(true);
    const j = io(repo);
    await main(["lint", "--json"], j);
    expect(JSON.parse(j.stdout[0]).counts.warn).toBeGreaterThan(0);
    expect(await main(["lint", "--strict"], io(repo))).toBe(1);
  });

  it("view refuses an invalid graph", async () => {
    const repo = tempFixture();
    await main(["scan"], io(repo));
    expect(await main(["view"], io(repo))).toBe(0);
    expect(existsSync(join(repo, ".discovery-graph/statemachine.md"))).toBe(true);
    writeFileSync(join(repo, ".discovery-graph/graph.json"), JSON.stringify({ schema: "x" }));
    expect(await main(["view"], io(repo))).toBe(1);
  });

  it("schema prints JSON Schema", async () => {
    const t = io(".");
    expect(await main(["schema"], t)).toBe(0);
    expect(JSON.parse(t.stdout[0]).title).toBe("discovery-graph/2");
  });

  it("reports unknown paths and warns when no harness files are found", async () => {
    const d = tempDir();
    const t = io(d);
    expect(await main(["scan", "missing-dir"], t)).toBe(2);
    const e = io(d);
    expect(await main(["scan"], e)).toBe(0);
    expect(e.stderr.join("\n")).toContain("no harness files found");
    expect(e.stderr.join("\n")).toContain("is this the right folder?");
  });

  it("--out writes elsewhere", async () => {
    const out = tempDir();
    expect(await main(["scan", FIXTURE, "--out", out], io(tempDir()))).toBe(0);
    expect(existsSync(join(out, "graph.json"))).toBe(true);
  });

  it("scans a URL through the (injected) clone and always cleans up", async () => {
    const cwd = tempDir();
    let cleaned = 0;
    const t = { ...io(cwd), clone: (url: string) => (expect(url).toBe("https://github.com/acme/harness"), { dir: FIXTURE, cleanup: () => cleaned++ }) };
    expect(await main(["https://github.com/acme/harness"], t)).toBe(0);
    const g = JSON.parse(readFileSync(join(cwd, ".discovery-graph/harness/graph.json"), "utf8")) as Graph;
    expect(g.meta.root).toBe("https://github.com/acme/harness");
    expect(readFileSync(join(cwd, ".discovery-graph/harness/AGENT_BRIEF.md"), "utf8")).toContain("git clone --depth 1");
    expect(cleaned).toBe(1);

    const failing = { ...io(cwd), clone: () => ({ dir: "/does/not/exist", cleanup: () => cleaned++ }) };
    // a clone dir that vanished still gets cleaned up (scan of a missing dir yields an empty graph)
    expect(await main(["scan", "https://github.com/acme/other"], failing)).toBe(0);
    expect(cleaned).toBe(2);
  });

  it("returns 2 for an unknown flag-less command path", async () => {
    const t = io(".");
    expect(await main(["validate", "/no/such/graph.json"], t)).toBe(2);
    expect(t.stderr[0]).toMatch(/no graph at/);
  });
});
