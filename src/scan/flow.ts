import type { GraphBuilder } from "../builder.js";
import { slug, type GraphEdge, type GraphNode } from "../schema.js";

export const HUMAN_ACTOR = "actor:user";

/**
 * Pass 3 — stitch the harness into ONE state machine.
 *
 * 1. Every agent that owns no state gets a stage state, so every agent appears in the flow.
 * 2. Agent hand-offs (frontmatter `handoffs`, "hand off to X") become gates between
 *    the exit of one agent and the entry of the next.
 * 3. Prompts that invoke an agent point at that agent's entry state (a start condition).
 * 4. A direct transition between states owned by different agents gets an IMPLICIT
 *    gate — the hand-off exists but nobody wrote down what must be true to pass it.
 *    Its criteria are inferred from what the first stage writes and the next reads.
 */
export function buildFlow(b: GraphBuilder): void {
  const nodes = () => b.allNodes();
  const edges = () => b.allEdges();
  const out = (id: string, kind: GraphEdge["kind"]) => edges().filter((e) => e.from === id && e.kind === kind);
  const inc = (id: string, kind: GraphEdge["kind"]) => edges().filter((e) => e.to === id && e.kind === kind);
  const performers = (sid: string) => out(sid, "performed_by").map((e) => e.to);
  const statesOf = (aid: string) => inc(aid, "performed_by").map((e) => b.get(e.from)!).filter((n) => n.kind === "state");

  const agents = nodes().filter((n) => n.kind === "agent");

  // 1. stages
  for (const a of agents) {
    if (statesOf(a.id).length) continue;
    const sid = `state:agent/${a.id.slice(6)}`;
    b.addNode({
      id: sid, kind: "state", label: a.label, description: a.description ?? `Work done by the ${a.label} agent`,
      source: a.source, confidence: "inferred", props: { stage: true, agent: a.id },
    });
    b.addEdge({ from: sid, to: a.id, kind: "performed_by", confidence: a.confidence === "declared" ? "declared" : "inferred", source: a.source });
    for (const kind of ["reads", "writes", "uses"] as const) {
      for (const e of out(a.id, kind)) b.addEdge({ from: sid, to: e.to, kind, confidence: "inferred", source: e.source });
    }
  }

  const ownPrefix = (a: GraphNode) => `state:${a.id.slice(6)}/`;

  // 1b. sub-flows: an agent whose own file describes steps, AND which performs a
  // stage in a wider workflow, gets its own steps nested under that stage.
  for (const a of agents) {
    const mine = statesOf(a.id).sort((x, y) => x.id.localeCompare(y.id));
    const own = mine.filter((s) => s.id.startsWith(ownPrefix(a)));
    const outer = mine.filter((s) => !s.id.startsWith(ownPrefix(a)) && !s.parent);
    if (!own.length || !outer.length) continue;
    for (const s of own) b.addNode({ ...s, parent: outer[0].id });
    b.get(outer[0].id)!.props = { ...(b.get(outer[0].id)!.props ?? {}), subflow: a.id };
  }

  /** Top-level states an agent performs (sub-flow steps only when it has nothing else). */
  const stagesOf = (aid: string) => {
    const mine = statesOf(aid).sort((x, y) => x.id.localeCompare(y.id));
    const top = mine.filter((s) => !s.parent);
    return top.length ? top : mine;
  };
  const entry = (aid: string): string | null => {
    const a = b.get(aid)!;
    const mine = stagesOf(aid);
    if (!mine.length) return null;
    return (
      mine.find((s) => s.id.startsWith(ownPrefix(a)) && s.initial) ??
      mine.find((s) => s.initial) ??
      mine.find((s) => s.props?.stage) ??
      mine[0]
    ).id;
  };
  const exits = (aid: string): string[] => {
    const a = b.get(aid)!;
    const mine = stagesOf(aid);
    const own = mine.filter((s) => s.id.startsWith(ownPrefix(a)));
    const pool = own.length ? own : mine;
    const term = pool.filter((s) => s.terminal);
    if (term.length) return term.map((s) => s.id);
    const ends = pool.filter((s) => !out(s.id, "transitions_to").length);
    if (ends.length) return ends.map((s) => s.id);
    const e = entry(aid);
    return e ? [e] : [];
  };
  const writesOf = (id: string) => out(id, "writes").map((e) => b.get(e.to)!.label);
  const readsOf = (id: string) => out(id, "reads").map((e) => b.get(e.to)!.label);
  const handoffCriteria = (fromState: string, toState: string | null): string[] => {
    const w = writesOf(fromState);
    const r = toState ? new Set(readsOf(toState)) : new Set<string>();
    const shared = w.filter((x) => r.has(x));
    return (shared.length ? shared : w).map((x) => `${x} is produced`);
  };
  const human = (src: GraphEdge["source"]) => b.addNode({ id: HUMAN_ACTOR, kind: "actor", label: "user (human approver)", confidence: "inferred", source: src });

  // 2a. agent → agent hand-offs
  for (const d of edges().filter((e) => e.kind === "delegates_to" && b.get(e.from)?.kind === "agent")) {
    const to = entry(d.to);
    const froms = exits(d.from);
    if (!to || !froms.length) continue;
    const A = b.get(d.from)!;
    const B = b.get(d.to)!;
    const declared = d.confidence === "declared";
    const label = d.label && d.label !== "handoff" ? d.label : `Hand-off to ${B.label}`;
    const gid = `gate:handoff/${slug(A.label)}-to-${slug(B.label)}`;
    b.addNode({
      id: gid, kind: "gate", label: label.endsWith("?") ? label : `${label}?`, source: d.source, confidence: d.confidence,
      gateType: declared ? "human" : "implicit",
      criteria: declared ? [`User starts the "${label}" hand-off from ${A.label}`] : handoffCriteria(froms[0], to),
      description: `Hand-off from ${A.label} to ${B.label}`,
      props: { handoff: true, from: A.id, to: B.id },
    });
    if (declared) {
      human(d.source);
      b.addEdge({ from: gid, to: HUMAN_ACTOR, kind: "performed_by", confidence: "inferred", source: d.source });
    }
    for (const f of froms) b.addEdge({ from: f, to: gid, kind: "transitions_to", confidence: "inferred", source: d.source });
    b.addEdge({ from: gid, to, kind: "transitions_to", label: "pass", confidence: "inferred", source: d.source });
  }

  // 2b. state → agent hand-offs ("4. Hand off to the reviewer agent")
  for (const d of edges().filter((e) => e.kind === "delegates_to" && b.get(e.from)?.kind === "state")) {
    const to = entry(d.to);
    if (!to || to === d.from) continue;
    const B = b.get(d.to)!;
    const gid = `gate:${d.from.slice(6)}-handoff`;
    b.addNode({
      id: gid, kind: "gate", label: `Hand-off to ${B.label}?`, source: d.source, confidence: "inferred", gateType: "implicit",
      criteria: handoffCriteria(d.from, to), description: `Hand-off to ${B.label} (criteria not stated)`, props: { handoff: true, to: B.id },
    });
    b.addEdge({ from: d.from, to: gid, kind: "transitions_to", confidence: "inferred", source: d.source });
    b.addEdge({ from: gid, to, kind: "transitions_to", label: "pass", confidence: "inferred", source: d.source });
    const s = b.get(d.from)!;
    if (s.terminal) delete s.terminal;
  }

  // 3. prompts are start conditions: point them at the agent's entry state
  for (const p of nodes().filter((n) => n.kind === "prompt")) {
    for (const e of out(p.id, "invokes")) {
      if (b.get(e.to)?.kind !== "agent") continue;
      const to = entry(e.to);
      if (to) b.addEdge({ from: p.id, to, kind: "invokes", label: "start", confidence: "inferred", source: e.source });
    }
  }

  // 4. implicit gates on cross-agent transitions
  for (const t of edges().filter((e) => e.kind === "transitions_to")) {
    const A = b.get(t.from)!;
    const B = b.get(t.to)!;
    if (A.kind !== "state" || B.kind !== "state") continue;
    const pa = performers(A.id);
    const pb = performers(B.id);
    if (!pa.length || !pb.length || pa.some((x) => pb.includes(x))) continue;
    // Already gated by a declared hand-off between the same agents? Route through it.
    const existing = edges().find((g) => g.from === A.id && g.kind === "transitions_to" && b.get(g.to)?.kind === "gate" && edges().some((h) => h.from === g.to && h.to === B.id && h.kind === "transitions_to"));
    if (existing) {
      b.removeEdge(t);
      continue;
    }
    const gid = `gate:${A.id.slice(6)}-handoff`;
    const names = (ids: string[]) => ids.map((i) => b.get(i)!.label).join("/");
    b.removeEdge(t);
    b.addNode({
      id: gid, kind: "gate", label: `${names(pa)} → ${names(pb)} hand-off?`, source: t.source, confidence: "inferred", gateType: "implicit",
      criteria: handoffCriteria(A.id, B.id), description: `Implicit hand-off from ${names(pa)} to ${names(pb)}: no exit criteria are written down`,
      props: { handoff: true },
    });
    b.addEdge({ from: A.id, to: gid, kind: "transitions_to", confidence: "inferred", source: t.source });
    b.addEdge({ from: gid, to: B.id, kind: "transitions_to", label: t.label ?? "pass", confidence: "inferred", source: t.source });
  }
}
