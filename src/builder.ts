import {
  edgeKey,
  emptyGraph,
  type Confidence,
  type EdgeKind,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
  type Origin,
  type SourceRef,
} from "./schema.js";

const RANK: Record<Confidence, number> = { speculative: 0, inferred: 1, declared: 2 };

export interface NodeInput {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  source?: SourceRef;
  confidence?: Confidence;
  origin?: Origin;
  initial?: boolean;
  terminal?: boolean;
  criteria?: string[];
  gateType?: GraphNode["gateType"];
  parent?: string;
  props?: Record<string, unknown>;
}

export interface EdgeInput {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  source?: SourceRef;
  confidence?: Confidence;
  origin?: Origin;
}

/**
 * Accumulates nodes/edges with de-duplication. When the same id is added
 * twice, the higher-confidence version wins its label/source, descriptions
 * and props are merged, so a declared agent file beats a bullet mention.
 */
export class GraphBuilder {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  constructor(private defaultOrigin: Origin = "scan") {}

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  addNode(input: NodeInput): GraphNode {
    const incoming: GraphNode = {
      id: input.id,
      kind: input.kind,
      label: input.label.trim() || input.id,
      origin: input.origin ?? this.defaultOrigin,
      confidence: input.confidence ?? "declared",
      ...(input.description ? { description: input.description.trim() } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.initial ? { initial: true } : {}),
      ...(input.terminal ? { terminal: true } : {}),
      ...(input.criteria?.length ? { criteria: input.criteria } : {}),
      ...(input.gateType ? { gateType: input.gateType } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.props && Object.keys(input.props).length ? { props: input.props } : {}),
    };
    const prev = this.nodes.get(input.id);
    if (!prev) {
      this.nodes.set(input.id, incoming);
      return incoming;
    }
    const winner = RANK[incoming.confidence] > RANK[prev.confidence] ? incoming : prev;
    const merged: GraphNode = {
      ...prev,
      ...incoming,
      label: winner.label,
      confidence: winner.confidence,
      source: winner.source ?? prev.source ?? incoming.source,
      description: winner.description ?? prev.description ?? incoming.description,
      props: { ...(incoming.props ?? {}), ...(prev.props ?? {}), ...(winner.props ?? {}) },
    };
    if (!merged.description) delete merged.description;
    if (!merged.source) delete merged.source;
    if (!Object.keys(merged.props ?? {}).length) delete merged.props;
    if (prev.criteria || incoming.criteria) merged.criteria = [...new Set([...(prev.criteria ?? []), ...(incoming.criteria ?? [])])];
    if (prev.initial || incoming.initial) merged.initial = true;
    if (prev.terminal || incoming.terminal) merged.terminal = true;
    this.nodes.set(input.id, merged);
    return merged;
  }

  addEdge(input: EdgeInput): void {
    if (input.from === input.to) return;
    const e: GraphEdge = {
      from: input.from,
      to: input.to,
      kind: input.kind,
      origin: input.origin ?? this.defaultOrigin,
      confidence: input.confidence ?? "declared",
      ...(input.label ? { label: input.label } : {}),
      ...(input.source ? { source: input.source } : {}),
    };
    const key = edgeKey(e);
    const prev = this.edges.get(key);
    if (!prev || RANK[e.confidence] > RANK[prev.confidence]) this.edges.set(key, e);
  }

  allEdges(): GraphEdge[] {
    return [...this.edges.values()];
  }

  removeEdge(e: Pick<GraphEdge, "from" | "to" | "kind">): void {
    this.edges.delete(edgeKey(e));
  }

  /** Drop edges whose endpoints were never created. */
  build(name: string, root: string, scannedFiles: string[]): Graph {
    const g = emptyGraph(name, root);
    g.meta.scannedFiles = [...scannedFiles].sort();
    g.nodes = [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    g.edges = [...this.edges.values()]
      .filter((e) => this.nodes.has(e.from) && this.nodes.has(e.to))
      .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
    return g;
  }
}
