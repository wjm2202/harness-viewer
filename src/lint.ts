import {
  NODE_KINDS,
  EDGE_KINDS,
  type Graph,
  type GraphEdge,
  type GraphNode,
} from "./schema.js";
import { validateGraph } from "./validate.js";
import { buildMachine } from "./machine.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  nodes: string[];
}

export interface Metrics {
  nodes: Record<string, number>;
  edges: Record<string, number>;
  workflows: number;
  inferredShare: number;
  hotspots: Array<{ id: string; degree: number }>;
}

export interface LintReport {
  findings: Finding[];
  metrics: Metrics;
  counts: Record<Severity, number>;
}

export type LintRuleName =
  | "agent-no-entry"
  | "agent-no-tools"
  | "artifact-contention"
  | "artifact-dead-output"
  | "artifact-external-input"
  | "broad-tool-grant"
  | "delegation-cycle"
  | "low-evidence"
  | "orphan"
  | "rule-unanchored"
  | "schema"
  | "state-dead-end"
  | "state-no-actor"
  | "state-unreachable"
  | "undeclared-mcp-server"
  | "unused-mcp-server"
  | "unused-tool"
  | "no-start-condition"
  | "start-condition-implicit"
  | "implicit-gate"
  | "gate-no-criteria"
  | "gate-dead-end"
  | "gate-no-fail-path"
  | "gate-no-evaluator";

/** Every lint rule with a one-line rationale. Documented in docs/GRAPH-SPEC.md. */
export const LINT_RULES: Record<
  LintRuleName,
  { severity: Severity; why: string }
> = {
  schema: {
    severity: "error",
    why: "The graph must validate — nothing else is trustworthy until it does.",
  },
  orphan: {
    severity: "warn",
    why: "A node with no edges is either noise or a missing relation.",
  },
  "unused-mcp-server": {
    severity: "warn",
    why: "A configured MCP server nobody uses costs context and attack surface.",
  },
  "undeclared-mcp-server": {
    severity: "warn",
    why: "A server referenced by an agent but missing from MCP config will fail at runtime.",
  },
  "unused-tool": {
    severity: "info",
    why: "A tool that is provided but never used by any agent/state/prompt.",
  },
  "broad-tool-grant": {
    severity: "info",
    why: "An agent granted a whole server (`server/*`) — consider least privilege.",
  },
  "state-dead-end": {
    severity: "warn",
    why: "A non-terminal state with no way forward: the process can stall here.",
  },
  "state-unreachable": {
    severity: "warn",
    why: "A non-initial state nothing transitions into.",
  },
  "no-start-condition": {
    severity: "warn",
    why: "A workflow nothing starts: no trigger or prompt points at it, so nobody knows when it runs.",
  },
  "start-condition-implicit": {
    severity: "info",
    why: 'The workflow has an entry but its start condition is not written down ("When …").',
  },
  "implicit-gate": {
    severity: "warn",
    why: "Work passes between agents without stated exit criteria — the next agent cannot know the previous one is done.",
  },
  "gate-no-criteria": {
    severity: "warn",
    why: "A gate without criteria cannot be checked, automated or evaluated.",
  },
  "gate-dead-end": {
    severity: "warn",
    why: "A gate with no outgoing transition: passing it leads nowhere.",
  },
  "gate-no-fail-path": {
    severity: "info",
    why: "A gate with a single exit: what happens when the check fails?",
  },
  "gate-no-evaluator": {
    severity: "info",
    why: "Nobody (agent, human, tool) is recorded as deciding this gate — an eval opportunity.",
  },
  "state-no-actor": {
    severity: "info",
    why: "A state with no agent/actor performing it — who does this?",
  },
  "artifact-contention": {
    severity: "warn",
    why: "An artifact written by more than one agent — ownership is ambiguous.",
  },
  "artifact-dead-output": {
    severity: "info",
    why: "An artifact written but never read — wasted work or a missing consumer.",
  },
  "artifact-external-input": {
    severity: "info",
    why: "An artifact read but never written inside the harness — an external dependency.",
  },
  "agent-no-tools": {
    severity: "info",
    why: "An agent with no tools declared or inferred.",
  },
  "agent-no-entry": {
    severity: "info",
    why: "An agent nothing invokes, delegates to, or assigns work to.",
  },
  "delegation-cycle": {
    severity: "warn",
    why: "Agents that can hand off to each other in a loop — check for a termination condition.",
  },
  "rule-unanchored": {
    severity: "info",
    why: "A rule that constrains nothing specific — hard to enforce or evaluate.",
  },
  "low-evidence": {
    severity: "info",
    why: "A node with no source reference — cannot be verified against the repo.",
  },
};
type LintRule = LintRuleName;

export function lintGraph(g: Graph): LintReport {
  const findings: Finding[] = [];
  const add = (rule: LintRule, message: string, nodes: string[] = []) =>
    findings.push({
      rule,
      severity: LINT_RULES[rule].severity,
      message,
      nodes,
    });

  const v = validateGraph(g);
  for (const e of v.errors) add("schema", `${e.path}: ${e.message}`);
  if (!v.ok) return finish(g, findings);

  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, GraphEdge[]>();
  const inc = new Map<string, GraphEdge[]>();
  for (const n of g.nodes) {
    out.set(n.id, []);
    inc.set(n.id, []);
  }
  for (const e of g.edges) {
    out.get(e.from)!.push(e);
    inc.get(e.to)!.push(e);
  }
  const outK = (id: string, ...k: string[]) =>
    out.get(id)!.filter((e) => k.includes(e.kind));
  const incK = (id: string, ...k: string[]) =>
    inc.get(id)!.filter((e) => k.includes(e.kind));
  const of = (kind: GraphNode["kind"]) =>
    g.nodes.filter((n) => n.kind === kind);

  for (const n of g.nodes) {
    if (
      !out.get(n.id)!.length &&
      !inc.get(n.id)!.length &&
      n.kind !== "mcp_server"
    )
      add("orphan", `${n.kind} "${n.label}" has no relations`, [n.id]);
    if (!n.source && n.origin !== "human")
      add("low-evidence", `${n.kind} "${n.label}" has no source reference`, [
        n.id,
      ]);
  }

  // --- MCP / tools
  for (const s of of("mcp_server")) {
    const direct = incK(s.id, "uses").length;
    const viaTools = outK(s.id, "provides").some(
      (p) => incK(p.to, "uses").length > 0,
    );
    if (!direct && !viaTools)
      add(
        "unused-mcp-server",
        `MCP server "${s.label}" is configured but nothing uses it`,
        [s.id],
      );
    if (s.props?.undeclared)
      add(
        "undeclared-mcp-server",
        `MCP server "${s.label}" is referenced but not declared in any MCP config`,
        [s.id],
      );
    for (const e of incK(s.id, "uses")) {
      if (byId.get(e.from)?.kind === "agent")
        add(
          "broad-tool-grant",
          `agent "${byId.get(e.from)!.label}" is granted every tool of "${s.label}"`,
          [e.from, s.id],
        );
    }
  }
  for (const t of of("tool")) {
    if (!incK(t.id, "uses").length && incK(t.id, "provides").length)
      add("unused-tool", `tool "${t.label}" is provided but never used`, [
        t.id,
      ]);
  }

  // --- state machine
  const states = of("state");
  for (const s of states) {
    const next = outK(s.id, "transitions_to");
    const prev = incK(s.id, "transitions_to", "invokes", "triggers");
    if (!next.length && !s.terminal)
      add(
        "state-dead-end",
        `state "${s.label}" has no outgoing transition and is not marked terminal`,
        [s.id],
      );
    if (!prev.length && !s.initial)
      add(
        "state-unreachable",
        `state "${s.label}" is not initial and nothing transitions into it`,
        [s.id],
      );
    if (!outK(s.id, "performed_by").length)
      add(
        "state-no-actor",
        `state "${s.label}" has no performed_by agent/actor`,
        [s.id],
      );
  }
  const machine = buildMachine(g);
  const workflows = machine.workflows.filter((w) => w.scope === null);
  for (const w of workflows) {
    const starts = w.nodes.filter((n) => n.kind === "start");
    const stateIds = w.nodes.filter((n) => n.kind === "state").map((n) => n.id);
    if (!starts.length)
      add(
        "no-start-condition",
        `workflow "${w.title}" has no start condition (no trigger or prompt leads into it)`,
        stateIds,
      );
    else if (
      starts.every(
        (st) =>
          byId.get(st.ref)!.kind === "trigger" &&
          byId.get(st.ref)!.props?.explicit === false,
      )
    )
      add(
        "start-condition-implicit",
        `workflow "${w.title}" starts, but the repo never says when (add a "When …" sentence)`,
        starts.map((x) => x.ref),
      );
  }

  // --- gates
  for (const gt of of("gate")) {
    const exits = outK(gt.id, "transitions_to");
    if (gt.gateType === "implicit")
      add(
        "implicit-gate",
        `"${gt.label}" — ${gt.description ?? "hand-off"}${gt.criteria?.length ? ` (inferred: ${gt.criteria.join("; ")})` : ""}`,
        [gt.id],
      );
    else if (!gt.criteria?.length)
      add("gate-no-criteria", `gate "${gt.label}" has no criteria`, [gt.id]);
    if (!exits.length)
      add("gate-dead-end", `gate "${gt.label}" has no outgoing transition`, [
        gt.id,
      ]);
    else if (exits.length === 1)
      add(
        "gate-no-fail-path",
        `gate "${gt.label}" has only a pass path — what happens on failure?`,
        [gt.id],
      );
    if (
      gt.gateType !== "implicit" &&
      !outK(gt.id, "performed_by", "uses").length
    )
      add(
        "gate-no-evaluator",
        `gate "${gt.label}" has no evaluator (performed_by / uses)`,
        [gt.id],
      );
  }

  // --- artifacts
  const actorOf = (fromId: string): string[] => {
    const n = byId.get(fromId)!;
    if (n.kind === "agent") return [n.id];
    if (n.kind === "state") return outK(n.id, "performed_by").map((e) => e.to);
    return [];
  };
  for (const a of of("artifact")) {
    const writers = incK(a.id, "writes");
    const readers = incK(a.id, "reads");
    const writerAgents = [...new Set(writers.flatMap((w) => actorOf(w.from)))];
    if (writerAgents.length > 1)
      add(
        "artifact-contention",
        `"${a.label}" is written by ${writerAgents.length} agents: ${writerAgents.map((x) => byId.get(x)!.label).join(", ")}`,
        [a.id, ...writerAgents],
      );
    if (writers.length && !readers.length)
      add("artifact-dead-output", `"${a.label}" is written but never read`, [
        a.id,
      ]);
    if (readers.length && !writers.length)
      add(
        "artifact-external-input",
        `"${a.label}" is read but never produced inside the harness`,
        [a.id],
      );
  }

  // --- agents
  for (const ag of of("agent")) {
    if (!outK(ag.id, "uses").length)
      add("agent-no-tools", `agent "${ag.label}" has no tools`, [ag.id]);
    if (
      !incK(ag.id, "invokes", "delegates_to", "performed_by", "triggers").length
    )
      add(
        "agent-no-entry",
        `agent "${ag.label}" is never invoked, delegated to, or assigned a state`,
        [ag.id],
      );
  }
  for (const cyc of cycles(
    of("agent").map((a) => a.id),
    g.edges.filter((e) => e.kind === "delegates_to"),
  )) {
    add(
      "delegation-cycle",
      `delegation loop: ${cyc.map((id) => byId.get(id)!.label).join(" → ")} → ${byId.get(cyc[0])!.label}`,
      cyc,
    );
  }

  // --- rules
  for (const r of of("rule")) {
    if (!outK(r.id, "constrains").length)
      add(
        "rule-unanchored",
        `rule "${r.label}" does not constrain any specific node`,
        [r.id],
      );
  }

  return finish(g, findings, workflows.length);
}

function finish(g: Graph, findings: Finding[], workflows = 0): LintReport {
  const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const order: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      a.message.localeCompare(b.message),
  );
  return { findings, counts, metrics: metrics(g, workflows) };
}

function metrics(g: Graph, workflows: number): Metrics {
  const nodes: Record<string, number> = {};
  const edges: Record<string, number> = {};
  for (const k of NODE_KINDS) nodes[k] = 0;
  for (const k of EDGE_KINDS) edges[k] = 0;
  const degree = new Map<string, number>();
  for (const n of Array.isArray(g.nodes) ? g.nodes : [])
    nodes[n.kind] = (nodes[n.kind] ?? 0) + 1;
  for (const e of Array.isArray(g.edges) ? g.edges : []) {
    edges[e.kind] = (edges[e.kind] ?? 0) + 1;
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const all = [...(g.nodes ?? []), ...(g.edges ?? [])];
  const inferred = all.filter((x) => x.confidence !== "declared").length;
  return {
    nodes,
    edges,
    workflows,
    inferredShare: all.length
      ? Math.round((inferred / all.length) * 100) / 100
      : 0,
    hotspots: [...degree.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([id, d]) => ({ id, degree: d })),
  };
}

/** Weakly-connected components (undirected). */
export function components(ids: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges) {
    if (adj.has(e.from) && adj.has(e.to)) {
      adj.get(e.from)!.push(e.to);
      adj.get(e.to)!.push(e.from);
    }
  }
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur)!) {
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

/** Elementary cycles, reported once each (rotated to start at the smallest id). */
export function cycles(ids: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>(ids.map((i) => [i, []]));
  for (const e of edges)
    if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from)!.push(e.to);
  const found = new Map<string, string[]>();
  const dfs = (
    start: string,
    cur: string,
    path: string[],
    onPath: Set<string>,
  ) => {
    for (const n of adj.get(cur)!) {
      if (n === start) {
        const min = path.reduce((m, x, i) => (x < path[m] ? i : m), 0);
        const rot = [...path.slice(min), ...path.slice(0, min)];
        found.set(rot.join(">"), rot);
      } else if (!onPath.has(n) && n > start && path.length < 12) {
        onPath.add(n);
        dfs(start, n, [...path, n], onPath);
        onPath.delete(n);
      }
    }
  };
  for (const id of [...ids].sort()) dfs(id, id, [id], new Set([id]));
  return [...found.values()];
}

export function renderLintMarkdown(g: Graph, r: LintReport): string {
  const m = r.metrics;
  const lines: string[] = [];
  lines.push(`# Harness lint — ${g.meta?.name ?? "graph"}`, "");
  lines.push(
    `**${r.counts.error} errors · ${r.counts.warn} warnings · ${r.counts.info} notes**`,
    "",
  );
  lines.push("## Shape", "");
  lines.push("| kind | count |", "|---|---|");
  for (const [k, v] of Object.entries(m.nodes))
    if (v) lines.push(`| ${k} | ${v} |`);
  lines.push(
    "",
    `Edges: ${
      Object.entries(m.edges)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ") || "none"
    }`,
  );
  lines.push(
    `Workflows (connected state groups): ${m.workflows} · inferred share: ${Math.round(m.inferredShare * 100)}%`,
  );
  if (m.hotspots.length)
    lines.push(
      `Hotspots (most connected): ${m.hotspots.map((h) => `\`${h.id}\` (${h.degree})`).join(", ")}`,
    );
  lines.push("");
  for (const sev of ["error", "warn", "info"] as const) {
    const fs = r.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    lines.push(
      `## ${sev === "error" ? "Errors" : sev === "warn" ? "Warnings" : "Notes"}`,
      "",
    );
    let last = "";
    for (const f of fs) {
      if (f.rule !== last) {
        lines.push(
          `### \`${f.rule}\``,
          "",
          `_${(LINT_RULES as Record<string, { why: string }>)[f.rule]?.why ?? ""}_`,
          "",
        );
        last = f.rule;
      }
      lines.push(`- ${f.message}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
