import { edgeKey, type Graph, type GraphEdge, type GraphNode } from "./schema.js";

export interface MergeResult {
  graph: Graph;
  /** Enrichment edges that lost an endpoint because the scan no longer finds it. */
  droppedEdges: GraphEdge[];
  keptNodes: number;
  keptEdges: number;
}

/**
 * Re-scan without losing enrichment: take the fresh scan, then layer every
 * node/edge whose origin is "agent" or "human" from the previous graph on top.
 * A non-scan node with the same id as a scan node wins (it is a deliberate override).
 */
export function mergeGraphs(previous: Graph | null, scanned: Graph): MergeResult {
  if (!previous) return { graph: scanned, droppedEdges: [], keptNodes: 0, keptEdges: 0 };

  const nodes = new Map<string, GraphNode>(scanned.nodes.map((n) => [n.id, n]));
  let keptNodes = 0;
  for (const n of previous.nodes) {
    if (n.origin === "scan") continue;
    nodes.set(n.id, n);
    keptNodes++;
  }

  const edges = new Map<string, GraphEdge>(scanned.edges.map((e) => [edgeKey(e), e]));
  const droppedEdges: GraphEdge[] = [];
  let keptEdges = 0;
  for (const e of previous.edges) {
    if (e.origin === "scan") continue;
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      droppedEdges.push(e);
      continue;
    }
    edges.set(edgeKey(e), e);
    keptEdges++;
  }

  return {
    graph: {
      ...scanned,
      nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...edges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    },
    droppedEdges,
    keptNodes,
    keptEdges,
  };
}
