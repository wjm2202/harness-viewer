import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyGraph, type EdgeKind, type Graph, type GraphEdge, type GraphNode, type NodeKind } from "../src/schema.js";

export const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/sample-repo");

/** Copy the sample repo to a temp dir so tests can write into it. */
export function tempFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "dg-test-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dg-empty-"));
}

export function n(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  const kind = id.slice(0, id.indexOf(":")) as NodeKind;
  return { id, kind, label: id.slice(id.indexOf(":") + 1), origin: "scan", confidence: "declared", source: { file: "x.md", line: 1 }, ...extra };
}

export function e(from: string, kind: EdgeKind, to: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { from, to, kind, origin: "scan", confidence: "declared", ...extra };
}

export function graph(nodes: GraphNode[], edges: GraphEdge[] = []): Graph {
  const g = emptyGraph("t", ".");
  g.nodes = nodes;
  g.edges = edges;
  return g;
}

/** Minimal in-memory IO for CLI tests. */
export function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return { cwd, out: (s: string) => out.push(s), err: (s: string) => err.push(s), stdout: out, stderr: err };
}
