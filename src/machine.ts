import type { Graph, GraphNode } from "./schema.js";

/**
 * The STATE-MACHINE projection of a graph, laid out top-to-bottom:
 *
 *   start condition (trigger / prompt)          rank 0
 *        ↓
 *   state (in its agent's lane)                 rank 1
 *        ↓
 *   gate ◇ (criteria to progress)               rank 2
 *     ↓ pass            ↺ fail (back edge)
 *   state …                                     rank 3
 *        ↓
 *   ◉ end
 *
 * Columns are LANES — one per agent/actor performing the states — so a reader
 * sees who holds the work at each stage and which gate hands it on.
 * Pure data: the HTML viewer and the Mermaid export both render from this.
 */

export type MachineNodeKind = "start" | "state" | "gate" | "end" | "ghost";

export interface MachineNode {
  id: string;
  /** Graph node id (for ghosts/ends: the node they stand for). */
  ref: string;
  kind: MachineNodeKind;
  label: string;
  lane: string;
  rank: number;
  /** Column index inside the lane at this rank (0 when alone). */
  sub: number;
  /** state has a nested sub-flow */
  compound?: boolean;
  gateType?: string;
}

export interface MachineEdge {
  from: string;
  to: string;
  label?: string;
  /** true when the edge goes back up (a loop / retry). */
  back: boolean;
}

export interface Lane {
  id: string;
  label: string;
  kind: "agent" | "actor" | "none";
  /** Widest number of nodes side by side at any rank. */
  width: number;
}

export interface Workflow {
  id: string;
  title: string;
  /** null = top level; otherwise the compound state whose sub-flow this is. */
  scope: string | null;
  lanes: Lane[];
  nodes: MachineNode[];
  edges: MachineEdge[];
  ranks: number;
}

export interface Machine {
  workflows: Workflow[];
}

const FLOW_KINDS = new Set(["transitions_to", "triggers", "invokes"]);
export const NO_LANE = "lane:none";

export function buildMachine(g: Graph): Machine {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const flow = g.edges.filter(
    (e) =>
      FLOW_KINDS.has(e.kind) &&
      byId.has(e.from) &&
      byId.has(e.to) &&
      isFlowNode(byId.get(e.to)!) &&
      isFlowNode(byId.get(e.from)!),
  );
  const performer = (id: string): string | undefined =>
    g.edges.find((e) => e.from === id && e.kind === "performed_by")?.to;

  // A node takes part in the machine if it is a state/gate, or a start that points into one.
  const inMachine = new Set<string>();
  for (const n of g.nodes)
    if (n.kind === "state" || n.kind === "gate") inMachine.add(n.id);
  for (const e of flow)
    if (
      !inMachine.has(e.from) &&
      (byId.get(e.from)!.kind === "trigger" ||
        byId.get(e.from)!.kind === "prompt")
    )
      inMachine.add(e.from);

  // --- scopes: top level, or the compound state that encloses a sub-flow
  const scopeOf = new Map<string, string | null>();
  for (const n of g.nodes)
    if (n.kind === "state") scopeOf.set(n.id, n.parent ?? null);
  const neighbours = (id: string, dir: "in" | "out") =>
    flow
      .filter((e) => (dir === "in" ? e.to === id : e.from === id))
      .map((e) => (dir === "in" ? e.from : e.to));
  for (const n of g.nodes.filter((x) => x.kind === "gate")) {
    const src = neighbours(n.id, "in").find(
      (x) => scopeOf.has(x) && byId.get(x)!.kind === "state",
    );
    const dst = neighbours(n.id, "out").find(
      (x) => scopeOf.has(x) && byId.get(x)!.kind === "state",
    );
    scopeOf.set(
      n.id,
      src !== undefined
        ? scopeOf.get(src)!
        : dst !== undefined
          ? scopeOf.get(dst)!
          : null,
    );
  }
  for (const id of inMachine) {
    if (scopeOf.has(id)) continue;
    const dst = neighbours(id, "out").find((x) => scopeOf.has(x));
    scopeOf.set(id, dst !== undefined ? scopeOf.get(dst)! : null);
  }
  const compound = new Set(
    g.nodes.filter((n) => n.parent).map((n) => n.parent!),
  );

  // --- workflows = connected components inside each scope
  const workflows: Workflow[] = [];
  const scopes = [
    ...new Set([...inMachine].map((id) => scopeOf.get(id) ?? null)),
  ];
  scopes.sort((a, b) =>
    a === null ? -1 : b === null ? 1 : a.localeCompare(b),
  );
  for (const scope of scopes) {
    const members = [...inMachine]
      .filter((id) => (scopeOf.get(id) ?? null) === scope)
      .sort();
    const set = new Set(members);
    const local = flow.filter((e) => set.has(e.from) && set.has(e.to));
    for (const comp of components(members, local)) {
      workflows.push(
        layout(comp, scope, local, flow, byId, performer, scopeOf, compound),
      );
    }
  }
  // biggest top-level workflow first, then other top-level, then sub-flows
  workflows.sort(
    (a, b) =>
      (a.scope === null ? 0 : 1) - (b.scope === null ? 0 : 1) ||
      b.nodes.length - a.nodes.length ||
      a.id.localeCompare(b.id),
  );
  return { workflows };
}

function isFlowNode(n: GraphNode): boolean {
  return (
    n.kind === "state" ||
    n.kind === "gate" ||
    n.kind === "trigger" ||
    n.kind === "prompt"
  );
}

function components(
  ids: string[],
  edges: { from: string; to: string }[],
): string[][] {
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      for (const n of adj.get(c)!) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    out.push(comp.sort());
  }
  return out;
}

function layout(
  comp: string[],
  scope: string | null,
  local: Graph["edges"],
  flow: Graph["edges"],
  byId: Map<string, GraphNode>,
  performer: (id: string) => string | undefined,
  scopeOf: Map<string, string | null>,
  compound: Set<string>,
): Workflow {
  const set = new Set(comp);
  const edges = local.filter((e) => set.has(e.from) && set.has(e.to));
  const isStart = (id: string) =>
    ["trigger", "prompt"].includes(byId.get(id)!.kind);
  const outs = new Map<string, string[]>(comp.map((i) => [i, []]));
  const indeg = new Map<string, number>(comp.map((i) => [i, 0]));
  for (const e of edges) outs.get(e.from)!.push(e.to);

  // Roots: starts first, then initial states, then anything with no incoming edge.
  const hasIn = new Set(edges.map((e) => e.to));
  const roots = [
    ...comp.filter(isStart),
    ...comp.filter((id) => byId.get(id)!.initial),
    ...comp.filter((id) => !hasIn.has(id)),
    ...comp,
  ];

  // DFS to find back edges (loops), preferring step order.
  const order = (id: string) =>
    (byId.get(id)!.props?.step as number | undefined) ?? 0;
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of [...outs.get(u)!].sort(
      (a, b) => order(a) - order(b) || a.localeCompare(b),
    )) {
      if (state.get(v) === 1) back.add(`${u}>${v}`);
      else if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const r of roots) if (!state.get(r)) dfs(r);

  // Longest-path ranks on the DAG.
  const fwd = edges.filter((e) => !back.has(`${e.from}>${e.to}`));
  for (const e of fwd) indeg.set(e.to, indeg.get(e.to)! + 1);
  const rank = new Map<string, number>();
  const q = comp.filter((id) => indeg.get(id) === 0);
  q.forEach((id) => rank.set(id, 0));
  const d = new Map(indeg);
  while (q.length) {
    const u = q.shift()!;
    for (const e of fwd.filter((x) => x.from === u)) {
      rank.set(e.to, Math.max(rank.get(e.to) ?? 0, rank.get(u)! + 1));
      d.set(e.to, d.get(e.to)! - 1);
      if (d.get(e.to) === 0) q.push(e.to);
    }
  }
  // Non-start nodes never sit on the start row.
  const anyStart = comp.some(isStart);
  for (const id of comp) {
    let r = rank.get(id) ?? 0;
    if (anyStart && !isStart(id) && r === 0) r = 1;
    rank.set(id, r);
  }

  // Lanes: who performs each state; gates take their source's lane; starts their target's.
  const laneOf = new Map<string, string>();
  for (const id of comp)
    if (byId.get(id)!.kind === "state")
      laneOf.set(id, performer(id) ?? NO_LANE);
  const firstLane = (ids: string[]) =>
    ids.map((x) => laneOf.get(x)).find((x) => x !== undefined);
  for (let pass = 0; pass < 3; pass++) {
    for (const id of comp) {
      if (laneOf.has(id)) continue;
      const ins = edges.filter((e) => e.to === id).map((e) => e.from);
      const outsIds = edges.filter((e) => e.from === id).map((e) => e.to);
      const l = isStart(id)
        ? firstLane(outsIds)
        : (firstLane(ins) ?? firstLane(outsIds));
      if (l) laneOf.set(id, l);
    }
  }
  for (const id of comp) if (!laneOf.has(id)) laneOf.set(id, NO_LANE);

  const nodes: MachineNode[] = comp.map((id) => {
    const n = byId.get(id)!;
    const kind: MachineNodeKind = isStart(id)
      ? "start"
      : n.kind === "gate"
        ? "gate"
        : "state";
    return {
      id,
      ref: id,
      kind,
      label: n.label,
      lane: laneOf.get(id)!,
      rank: rank.get(id)!,
      sub: 0,
      ...(compound.has(id) ? { compound: true } : {}),
      ...(n.gateType ? { gateType: n.gateType } : {}),
    };
  });
  const mEdges: MachineEdge[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    back: back.has(`${e.from}>${e.to}`),
    ...(e.label ? { label: e.label } : {}),
  }));

  // End markers under terminal states.
  for (const n of nodes.filter(
    (x) => x.kind === "state" && byId.get(x.id)!.terminal,
  )) {
    const id = `end:${n.id}`;
    nodes.push({
      id,
      ref: n.id,
      kind: "end",
      label: "end",
      lane: n.lane,
      rank: n.rank + 1,
      sub: 0,
    });
    mEdges.push({ from: n.id, to: id, back: false });
  }
  // Ghosts: flow edges that leave this workflow's scope (e.g. a sub-flow handing back to the parent flow).
  for (const e of flow.filter(
    (x) =>
      set.has(x.from) &&
      !set.has(x.to) &&
      (scopeOf.get(x.to) ?? null) !== scope,
  )) {
    const src = nodes.find((x) => x.id === e.from)!;
    const id = `ghost:${e.to}`;
    if (!nodes.some((x) => x.id === id))
      nodes.push({
        id,
        ref: e.to,
        kind: "ghost",
        label: byId.get(e.to)!.label,
        lane: src.lane,
        rank: src.rank + 1,
        sub: 0,
      });
    mEdges.push({
      from: e.from,
      to: id,
      back: false,
      ...(e.label ? { label: e.label } : {}),
    });
  }

  // Lane order = order of first appearance down the flow; NO_LANE last.
  const firstRank = new Map<string, number>();
  for (const n of nodes)
    firstRank.set(n.lane, Math.min(firstRank.get(n.lane) ?? Infinity, n.rank));
  const laneIds = [...firstRank.keys()].sort(
    (a, b) =>
      (a === NO_LANE ? 1 : 0) - (b === NO_LANE ? 1 : 0) ||
      firstRank.get(a)! - firstRank.get(b)! ||
      a.localeCompare(b),
  );
  // Side-by-side slots inside a lane at the same rank.
  const cell = new Map<string, number>();
  const lanes: Lane[] = laneIds.map((lid) => {
    for (const n of nodes
      .filter((x) => x.lane === lid)
      .sort(
        (a, b) =>
          a.rank - b.rank ||
          kindOrder(a.kind) - kindOrder(b.kind) ||
          a.id.localeCompare(b.id),
      )) {
      const k = `${lid}@${n.rank}`;
      n.sub = cell.get(k) ?? 0;
      cell.set(k, n.sub + 1);
    }
    const width = Math.max(
      1,
      ...nodes.filter((x) => x.lane === lid).map((x) => x.sub + 1),
    );
    const ln = byId.get(lid);
    return {
      id: lid,
      label: ln ? ln.label : "unassigned",
      kind:
        ln?.kind === "agent"
          ? "agent"
          : ln?.kind === "actor"
            ? "actor"
            : "none",
      width,
    };
  });

  const title = workflowTitle(comp, byId, scope);
  return {
    id: `wf:${scope ?? "top"}:${comp[0]}`,
    title,
    scope,
    lanes,
    nodes: nodes.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)),
    edges: mEdges,
    ranks: Math.max(0, ...nodes.map((n) => n.rank)) + 1,
  };
}

function kindOrder(k: MachineNodeKind): number {
  return { start: 0, state: 1, gate: 2, ghost: 3, end: 4 }[k];
}

function workflowTitle(
  comp: string[],
  byId: Map<string, GraphNode>,
  scope: string | null,
): string {
  if (scope) return `Sub-flow of: ${byId.get(scope)?.label ?? scope}`;
  const names = comp
    .map((id) => byId.get(id)!.props?.workflow)
    .filter((x): x is string => typeof x === "string");
  if (names.length) {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const ownerId = comp
      .map((id) => byId.get(id)!)
      .find((n) => n.props?.workflow === top)?.props?.owner as
      string | undefined;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    return owner && owner.kind !== "instruction"
      ? `${owner.label} (${owner.kind}): ${top}`
      : top;
  }
  const first = comp.map((id) => byId.get(id)!).find((n) => n.kind === "state");
  return first ? first.label : comp[0];
}

// ------------------------------------------------------------------ Mermaid

function mid(i: number, prefix: string) {
  return `${prefix}${i}`;
}

function esc(s: string): string {
  return s
    .replace(/"/g, "'")
    .replace(/[\n\r]+/g, " ")
    .slice(0, 80);
}

/** One `stateDiagram-v2` block per workflow — renders on GitHub, VS Code, Notion… */
export function renderMermaid(g: Graph, m: Machine = buildMachine(g)): string {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: string[] = [`# State machine — ${g.meta.name}`, ""];
  if (!m.workflows.length) out.push("_No workflows found._");
  for (const wf of m.workflows) {
    out.push(
      `## ${wf.title}`,
      "",
      "```mermaid",
      "stateDiagram-v2",
      "  direction TB",
    );
    const ids = new Map<string, string>();
    let i = 0;
    for (const n of wf.nodes) {
      if (n.kind === "start" || n.kind === "end") continue;
      const id = mid(++i, n.kind === "gate" ? "g" : "s");
      ids.set(n.id, id);
      const lane = wf.lanes.find((l) => l.id === n.lane);
      const who =
        n.kind === "state" && lane && lane.kind !== "none"
          ? `${lane.label}: `
          : "";
      const text =
        n.kind === "gate"
          ? `◇ ${n.label}`
          : n.kind === "ghost"
            ? `↗ ${n.label}`
            : `${who}${n.label}${n.compound ? " ▸" : ""}`;
      out.push(`  state "${esc(text)}" as ${id}`);
    }
    for (const e of wf.edges) {
      const from = wf.nodes.find((n) => n.id === e.from)!;
      const to = wf.nodes.find((n) => n.id === e.to)!;
      const label =
        from.kind === "start" ? esc(from.label) : e.label ? esc(e.label) : "";
      const a = from.kind === "start" ? "[*]" : ids.get(from.id)!;
      const b = to.kind === "end" ? "[*]" : ids.get(to.id)!;
      out.push(`  ${a} --> ${b}${label ? ` : ${label}` : ""}`);
    }
    for (const n of wf.nodes.filter((x) => x.kind === "gate")) {
      const crit = byId.get(n.ref)?.criteria;
      if (crit?.length)
        out.push(
          `  note right of ${ids.get(n.id)}`,
          ...crit.map((c) => `    ${esc(c)}`),
          "  end note",
        );
    }
    out.push("```", "");
  }
  return out.join("\n");
}
