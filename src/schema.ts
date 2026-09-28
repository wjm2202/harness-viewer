/**
 * discovery-graph/2 — the canonical graph shape.
 *
 * The graph is a STATE MACHINE (trigger → state → gate → state …, read top to
 * bottom) embedded in a knowledge graph (who performs each state, which tools
 * it uses, which artifacts it reads and writes, which rules constrain it).
 *
 * Normative prose lives in docs/GRAPH-SPEC.md; test/spec-drift.test.ts keeps
 * the two in sync. If you add a kind here, document it there.
 */

export const SCHEMA_VERSION = "discovery-graph/2" as const;
/** Older versions the validator still accepts (read-compatible). */
export const ACCEPTED_SCHEMAS = ["discovery-graph/1", SCHEMA_VERSION] as const;

/** What a node IS. */
export const NODE_KINDS = [
  "instruction", // an instruction file or section (copilot-instructions.md, AGENTS.md, *.instructions.md)
  "agent", // an agent / chat mode / sub-agent / persona
  "prompt", // a reusable prompt or slash command (an entry point into a workflow)
  "skill", // a packaged skill (SKILL.md)
  "mcp_server", // an MCP server declared in config
  "tool", // a tool an agent can call (built-in or MCP-provided)
  "state", // a stage/step of a workflow — the state-machine part
  "gate", // a guard between states: criteria that must hold to progress
  "artifact", // a file, doc, dataset or other thing that is read or written
  "trigger", // a START CONDITION: user request, issue opened, hook, schedule, CI event
  "actor", // a human role (reviewer, user, maintainer)
  "rule", // a constraint / guard-rail stated in instructions
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** How two nodes relate. Direction is always from → to, read as a sentence. */
export const EDGE_KINDS = [
  "defines", // instruction/file → thing it declares
  "transitions_to", // state → next state (label = condition/event)
  "performed_by", // state → agent/actor who does it
  "uses", // agent/state/prompt → tool/skill/mcp_server
  "provides", // mcp_server → tool
  "reads", // agent/state/prompt → artifact (an INPUT)
  "writes", // agent/state/prompt → artifact (an OUTPUT)
  "delegates_to", // agent → agent (hand-off / sub-agent)
  "invokes", // prompt/trigger → agent or state (entry point)
  "triggers", // trigger → state/agent
  "constrains", // rule → anything it limits
  "references", // weak mention, no stronger relation known
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * Which node kinds each edge kind may connect. `*` = any kind.
 * A violation is a validation ERROR — it almost always means the edge kind
 * was misunderstood, and a wrong edge poisons every analysis built on it.
 */
export const EDGE_RULES: Record<EdgeKind, { from: readonly NodeKind[] | "*"; to: readonly NodeKind[] | "*" }> = {
  defines: { from: ["instruction", "agent", "prompt", "skill"], to: "*" },
  transitions_to: { from: ["trigger", "state", "gate"], to: ["state", "gate"] },
  performed_by: { from: ["state", "gate"], to: ["agent", "actor"] },
  uses: { from: ["agent", "state", "gate", "prompt", "skill"], to: ["tool", "skill", "mcp_server"] },
  provides: { from: ["mcp_server", "skill"], to: ["tool"] },
  reads: { from: ["agent", "state", "gate", "prompt", "skill", "tool"], to: ["artifact"] },
  writes: { from: ["agent", "state", "prompt", "skill", "tool"], to: ["artifact"] },
  delegates_to: { from: ["agent", "state", "prompt"], to: ["agent"] },
  invokes: { from: ["prompt", "trigger", "actor", "agent"], to: ["agent", "state", "prompt", "skill"] },
  triggers: { from: ["trigger", "actor", "state"], to: ["state", "gate", "agent", "prompt"] },
  constrains: { from: ["rule", "instruction"], to: "*" },
  references: { from: "*", to: "*" },
};

/** Where a node/edge came from. Re-scans only replace `scan` items. */
export const ORIGINS = ["scan", "agent", "human"] as const;
export type Origin = (typeof ORIGINS)[number];

/**
 * Who or what decides a gate.
 *  human     — a person approves (review, sign-off, clicking a hand-off button)
 *  automated — a machine check (tests, lint, build, CI)
 *  agent     — an AI agent judges (review agent, self-check)
 *  implicit  — inferred from a hand-off; nobody states the criteria (a smell)
 */
export const GATE_TYPES = ["human", "automated", "agent", "implicit"] as const;
export type GateType = (typeof GATE_TYPES)[number];

/** How sure we are. `declared` = stated explicitly in config/frontmatter. */
export const CONFIDENCES = ["declared", "inferred", "speculative"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export interface SourceRef {
  /** Repo-relative path, forward slashes. */
  file: string;
  /** 1-based line number, if known. */
  line?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  source?: SourceRef;
  origin: Origin;
  confidence: Confidence;
  /** state only: an entry state of a workflow. */
  initial?: boolean;
  /** state only: a legitimate end state (no outgoing transition expected). */
  terminal?: boolean;
  /** state only: id of the enclosing (compound) state — this state is part of its sub-flow. */
  parent?: string;
  /** gate only: what must be true to pass, one check per entry. */
  criteria?: string[];
  /** gate only: who/what decides. */
  gateType?: GateType;
  /** Free-form extra data (frontmatter, model, applyTo, command…). */
  props?: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  source?: SourceRef;
  origin: Origin;
  confidence: Confidence;
}

export interface GraphMeta {
  name: string;
  /** Path or URL that was scanned. */
  root: string;
  generatedAt: string;
  generator: string;
  /** Files the scanner read — the agent brief tells the AI to read these. */
  scannedFiles: string[];
}

export interface Graph {
  schema: typeof SCHEMA_VERSION;
  meta: GraphMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Allowed node id shape: `<kind>:<slug>`. `*` is allowed so globs stay readable. */
export const NODE_ID_PATTERN = "^[a-z_]+:[a-z0-9._/*-]+$";

/** Stable id helper: `<kind>:<slug>` — lowercase, [a-z0-9._/*-]. */
export function nodeId(kind: NodeKind, name: string): string {
  return `${kind}:${slug(name)}`;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/[^a-z0-9._/*-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|[-.]+$/g, "") || "unnamed"
  );
}

export function edgeKey(e: Pick<GraphEdge, "from" | "to" | "kind">): string {
  return `${e.from}|${e.kind}|${e.to}`;
}

export function emptyGraph(name: string, root: string): Graph {
  return {
    schema: SCHEMA_VERSION,
    meta: {
      name,
      root,
      generatedAt: new Date().toISOString(),
      generator: "discovery-graph",
      scannedFiles: [],
    },
    nodes: [],
    edges: [],
  };
}
