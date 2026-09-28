import {
  ACCEPTED_SCHEMAS,
  CONFIDENCES,
  GATE_TYPES,
  EDGE_KINDS,
  EDGE_RULES,
  NODE_ID_PATTERN,
  NODE_KINDS,
  ORIGINS,
  SCHEMA_VERSION,
  edgeKey,
  type Graph,
  type NodeKind,
} from "./schema.js";

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
}

const ID_RE = new RegExp(NODE_ID_PATTERN);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate an unknown value as a discovery-graph/1 document.
 * Zero dependencies on purpose — agents run this in a loop while enriching.
 */
export function validateGraph(doc: unknown): ValidationResult {
  const errors: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (!isObj(doc)) {
    return { ok: false, errors: [{ path: "$", message: "graph must be a JSON object" }] };
  }
  if (!ACCEPTED_SCHEMAS.includes(doc.schema as never)) err("$.schema", `must be "${SCHEMA_VERSION}"`);
  if (!isObj(doc.meta)) err("$.meta", "must be an object");
  else {
    for (const k of ["name", "root", "generatedAt", "generator"]) {
      if (typeof doc.meta[k] !== "string") err(`$.meta.${k}`, "must be a string");
    }
    if (!Array.isArray(doc.meta.scannedFiles)) err("$.meta.scannedFiles", "must be an array of strings");
  }
  if (!Array.isArray(doc.nodes)) err("$.nodes", "must be an array");
  if (!Array.isArray(doc.edges)) err("$.edges", "must be an array");
  if (errors.length) return { ok: false, errors };

  const kinds = new Map<string, NodeKind>();
  (doc.nodes as unknown[]).forEach((n, i) => {
    const p = `$.nodes[${i}]`;
    if (!isObj(n)) return err(p, "must be an object");
    if (typeof n.id !== "string" || !ID_RE.test(n.id)) err(`${p}.id`, `must match ${ID_RE} (e.g. "agent:reviewer")`);
    else if (kinds.has(n.id)) err(`${p}.id`, `duplicate node id "${n.id}"`);
    if (!NODE_KINDS.includes(n.kind as NodeKind)) err(`${p}.kind`, `unknown kind "${String(n.kind)}"; one of ${NODE_KINDS.join(", ")}`);
    else if (typeof n.id === "string" && !n.id.startsWith(`${n.kind}:`)) err(`${p}.id`, `id must be prefixed with its kind ("${n.kind}:")`);
    if (typeof n.label !== "string" || !n.label.trim()) err(`${p}.label`, "must be a non-empty string");
    if (!ORIGINS.includes(n.origin as never)) err(`${p}.origin`, `must be one of ${ORIGINS.join(", ")}`);
    if (!CONFIDENCES.includes(n.confidence as never)) err(`${p}.confidence`, `must be one of ${CONFIDENCES.join(", ")}`);
    if (n.source !== undefined) checkSource(n.source, `${p}.source`, err);
    if ((n.initial !== undefined || n.terminal !== undefined) && n.kind !== "state") err(p, "initial/terminal only apply to state nodes");
    if ((n.criteria !== undefined || n.gateType !== undefined) && n.kind !== "gate") err(p, "criteria/gateType only apply to gate nodes");
    if (n.criteria !== undefined && (!Array.isArray(n.criteria) || n.criteria.some((c) => typeof c !== "string"))) err(`${p}.criteria`, "must be an array of strings");
    if (n.gateType !== undefined && !GATE_TYPES.includes(n.gateType as never)) err(`${p}.gateType`, `must be one of ${GATE_TYPES.join(", ")}`);
    if (typeof n.id === "string" && NODE_KINDS.includes(n.kind as NodeKind) && !kinds.has(n.id)) kinds.set(n.id, n.kind as NodeKind);
  });

  (doc.nodes as Record<string, unknown>[]).forEach((n, i) => {
    if (!isObj(n) || n.parent === undefined) return;
    const p = `$.nodes[${i}].parent`;
    if (n.kind !== "state") return err(p, "parent only applies to state nodes");
    if (kinds.get(n.parent as string) !== "state") return err(p, `must be the id of a state (got "${String(n.parent)}")`);
    // no cycles
    const byId = new Map((doc.nodes as Record<string, unknown>[]).filter(isObj).map((x) => [x.id as string, x]));
    let cur: unknown = n.parent;
    for (let hops = 0; typeof cur === "string" && hops < 64; hops++) {
      if (cur === n.id) return err(p, "parent chain loops back to this state");
      cur = byId.get(cur)?.parent;
    }
  });

  const seen = new Set<string>();
  (doc.edges as unknown[]).forEach((e, i) => {
    const p = `$.edges[${i}]`;
    if (!isObj(e)) return err(p, "must be an object");
    if (!EDGE_KINDS.includes(e.kind as never)) return err(`${p}.kind`, `unknown kind "${String(e.kind)}"; one of ${EDGE_KINDS.join(", ")}`);
    const kind = e.kind as (typeof EDGE_KINDS)[number];
    const fromK = kinds.get(e.from as string);
    const toK = kinds.get(e.to as string);
    if (!fromK) err(`${p}.from`, `unknown node "${String(e.from)}"`);
    if (!toK) err(`${p}.to`, `unknown node "${String(e.to)}"`);
    if (!ORIGINS.includes(e.origin as never)) err(`${p}.origin`, `must be one of ${ORIGINS.join(", ")}`);
    if (!CONFIDENCES.includes(e.confidence as never)) err(`${p}.confidence`, `must be one of ${CONFIDENCES.join(", ")}`);
    if (e.source !== undefined) checkSource(e.source, `${p}.source`, err);
    const rule = EDGE_RULES[kind];
    if (fromK && rule.from !== "*" && !rule.from.includes(fromK)) err(p, `"${kind}" cannot start at a ${fromK} (allowed: ${rule.from.join(", ")})`);
    if (toK && rule.to !== "*" && !rule.to.includes(toK)) err(p, `"${kind}" cannot end at a ${toK} (allowed: ${rule.to.join(", ")})`);
    const key = edgeKey({ from: String(e.from), to: String(e.to), kind });
    if (seen.has(key)) err(p, `duplicate edge ${key}`);
    seen.add(key);
  });

  return { ok: errors.length === 0, errors };
}

function checkSource(s: unknown, p: string, err: (p: string, m: string) => void) {
  if (!isObj(s) || typeof s.file !== "string") return err(p, "must be { file: string, line?: number }");
  if (s.line !== undefined && (typeof s.line !== "number" || s.line < 1)) err(`${p}.line`, "must be a positive number");
}

export function assertValid(doc: unknown): asserts doc is Graph {
  const r = validateGraph(doc);
  if (!r.ok) {
    throw new Error("Invalid graph:\n" + r.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n"));
  }
}
