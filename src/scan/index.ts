import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, posix } from "node:path";
import { GraphBuilder } from "../builder.js";
import { EDGE_RULES, nodeId, slug, type EdgeKind, type GateType, type Graph, type NodeKind, type SourceRef } from "../schema.js";
import { findHarnessFiles, type HarnessFile } from "./files.js";
import { listItems, parseMarkdown, sections, stripInline, toList, type MdLine, type ParsedMd } from "./markdown.js";
import { parseJsonc, parseToolRef } from "./tools.js";
import { asQuestion, classifyGate, detectGate, detectLoop, startCondition } from "./gates.js";
import { buildFlow, HUMAN_ACTOR } from "./flow.js";

export const WORKFLOW_HEADING = /\b(workflow|process|procedure|steps?|lifecycle|pipeline|phases?|stages?|flow|loop|playbook|runbook|how to)\b/i;
export const RULE_HEADING = /\b(rules?|constraints?|guard-?rails?|conventions?|polic(y|ies)|requirements|do'?s|don'?ts|must)\b/i;
const INVENTORY: Array<{ re: RegExp; kind: NodeKind }> = [
  { re: /\bmcp\s+servers?\b/i, kind: "mcp_server" },
  { re: /\b(sub-?agents?|agents?|roles|personas|chat ?modes)\b/i, kind: "agent" },
  { re: /\bskills?\b/i, kind: "skill" },
  { re: /\b(tools?|mcp)\b/i, kind: "tool" },
  { re: /\b(artifacts?|outputs?|inputs?|deliverables|key files|files|directories|folders)\b/i, kind: "artifact" },
];
const RULE_LINE = /^(never|always|must|do not|don't|avoid|only)\b/i;
const RULE_SHOUT = /\b(MUST|NEVER|ALWAYS|MUST NOT|DO NOT)\b/;
const WRITES_VERB = /\b(writes?|creates?|generates?|produces?|updates?|saves?|emits?|appends?|outputs?|commits?|records?|edits?|drafts?|publish(es)?)\b/gi;
const READS_VERB = /\b(reads?|loads?|reviews?|checks?|consults?|opens?|parses?|inspects?|scans?|follows?|see|using|based on|input|from)\b/gi;
const HANDOFF = /\b(hand(s|ed)?[ -]?off|delegat\w*|pass(es)? (it |this |work )?(on )?to|escalat\w*|dispatch\w*|spawn\w*)\b/i;
const BUILTIN_MODES =new Set(["agent", "ask", "edit", "plan"]);

interface Ctx {
  b: GraphBuilder;
  root: string;
  /** file rel → owning node id */
  owners: Map<string, string>;
  /** lowercase name → node id, for mention resolution */
  names: Map<string, string>;
  /** mcp servers declared in config */
  servers: Set<string>;
}

export interface ScanOptions {
  name?: string;
  /** What to record as meta.root (e.g. the URL a clone came from). */
  displayRoot?: string;
}

/** Deterministically scan a repo directory into a graph. No network, no LLM. */
export function scanRepo(root: string, opts: ScanOptions = {}): Graph {
  const files = findHarnessFiles(root);
  const ctx: Ctx = { b: new GraphBuilder("scan"), root, owners: new Map(), names: new Map(), servers: new Set() };
  const parsed = new Map<string, ParsedMd>();

  // Pass 0: MCP servers (so tool refs can be matched to declared servers).
  for (const f of files.filter((f) => f.role === "mcp_config")) scanMcpConfig(f, ctx);

  // Pass 1: one node per markdown harness file, plus frontmatter-declared relations.
  for (const f of files) {
    if (f.role === "mcp_config" || f.role === "hooks_config") continue;
    const md = parseMarkdown(readFileSync(f.abs, "utf8"));
    parsed.set(f.rel, md);
    declareFileNode(f, md, ctx);
  }
  for (const f of files.filter((f) => f.role === "hooks_config")) scanHooks(f, ctx);

  indexNames(ctx);

  // Pass 2a: inventory sections ("## Agents", "## Tools"…) first, so every
  // file's mentions can resolve names declared in any other file.
  const consumed = new Map<string, Set<number>>();
  for (const [rel, md] of parsed) consumed.set(rel, scanInventory(rel, md, ctx));
  indexNames(ctx);
  // Pass 2b: workflows, rules, mentions, links (inferred).
  for (const [rel, md] of parsed) scanBody(rel, md, consumed.get(rel)!, ctx);
  // Pass 3: stitch agents into one state machine (stages, hand-off gates, implicit gates).
  buildFlow(ctx.b);

  const name = opts.name ?? readPackageName(root) ?? basename(root);
  return ctx.b.build(name, opts.displayRoot ?? root, files.map((f) => f.rel));
}

/** Name index for mention resolution: lowercase name → node id. */
function indexNames(ctx: Ctx) {
  for (const n of ctx.b.allNodes()) {
    if (["agent", "skill", "prompt", "mcp_server"].includes(n.kind)) {
      const bare = n.id.slice(n.kind.length + 1);
      ctx.names.set(bare, n.id);
      ctx.names.set(n.label.toLowerCase().replace(/^\//, ""), n.id);
      if (n.kind === "prompt") ctx.names.set("/" + bare, n.id);
    }
    if (n.kind === "tool") {
      ctx.names.set(n.label.toLowerCase(), n.id);
      ctx.names.set(n.id.slice(5), n.id);
    }
  }
}

function readPackageName(root: string): string | undefined {
  const p = posix.join(root.replace(/\\/g, "/"), "package.json");
  if (!existsSync(p)) return undefined;
  try {
    const n = JSON.parse(readFileSync(p, "utf8")).name;
    return typeof n === "string" ? n : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- pass 0/1

function scanMcpConfig(f: HarnessFile, ctx: Ctx) {
  let doc: unknown;
  try {
    doc = parseJsonc(readFileSync(f.abs, "utf8"));
  } catch {
    return;
  }
  const d = doc as Record<string, unknown>;
  const servers = (d.servers ?? d.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") continue;
    ctx.servers.add(name.toLowerCase());
    const transport = (cfg.type as string) ?? (cfg.url ? "http" : "stdio");
    ctx.b.addNode({
      id: nodeId("mcp_server", name),
      kind: "mcp_server",
      label: name,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      source: { file: f.rel, line: lineOf(f.abs, `"${name}"`) },
      props: {
        transport,
        ...(cfg.command ? { command: [cfg.command, ...toList(cfg.args)].join(" ") } : {}),
        ...(cfg.url ? { url: cfg.url } : {}),
        config: f.rel,
      },
    });
  }
}

function lineOf(abs: string, needle: string): number | undefined {
  const i = readFileSync(abs, "utf8").split("\n").findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : undefined;
}

function fileBaseName(rel: string): string {
  return basename(rel)
    .replace(/\.(instructions|agent|chatmode|prompt)\.md$/i, "")
    .replace(/\.mdc?$/i, "");
}

function declareFileNode(f: HarnessFile, md: ParsedMd, ctx: Ctx) {
  const fm = md.frontmatter;
  const src: SourceRef = { file: f.rel, line: 1 };
  const desc = typeof fm.description === "string" ? fm.description : firstParagraph(md);
  let id: string;

  switch (f.role) {
    case "instruction": {
      id = nodeId("instruction", f.rel);
      ctx.b.addNode({
        id, kind: "instruction", label: basename(f.rel), description: desc, source: src,
        props: { flavor: f.flavor, ...(fm.applyTo ? { applyTo: fm.applyTo } : {}), ...(fm.globs ? { applyTo: fm.globs } : {}) },
      });
      const applyTo = (fm.applyTo ?? fm.globs) as unknown;
      for (const glob of toList(applyTo)) {
        if (glob === "**" || glob === "**/*") continue;
        const a = nodeId("artifact", glob);
        ctx.b.addNode({ id: a, kind: "artifact", label: glob, source: src, props: { glob: true } });
        ctx.b.addEdge({ from: id, to: a, kind: "constrains", label: "applyTo", source: src });
      }
      break;
    }
    case "agent": {
      const name = typeof fm.name === "string" ? fm.name : fileBaseName(f.rel);
      id = nodeId("agent", name);
      ctx.b.addNode({
        id, kind: "agent", label: name, description: desc, source: src,
        props: { flavor: f.flavor, ...(fm.model ? { model: fm.model } : {}), ...(f.rel.endsWith(".chatmode.md") ? { chatmode: true } : {}) },
      });
      for (const h of Array.isArray(fm.handoffs) ? fm.handoffs : []) {
        const target = (h as Record<string, unknown>)?.agent;
        if (typeof target !== "string") continue;
        const t = nodeId("agent", target);
        ctx.b.addNode({ id: t, kind: "agent", label: target, confidence: "inferred", source: src });
        const label = (h as Record<string, unknown>).label;
        ctx.b.addEdge({ from: id, to: t, kind: "delegates_to", label: typeof label === "string" ? label : "handoff", source: src });
      }
      break;
    }
    case "prompt": {
      const name = typeof fm.name === "string" ? fm.name : fileBaseName(f.rel);
      id = nodeId("prompt", name);
      const mode = (fm.agent ?? fm.mode) as unknown;
      ctx.b.addNode({
        id, kind: "prompt", label: "/" + name, description: desc, source: src,
        props: { flavor: f.flavor, ...(typeof mode === "string" ? { mode } : {}), ...(fm.model ? { model: fm.model } : {}), ...(fm["argument-hint"] ? { argumentHint: fm["argument-hint"] } : {}) },
      });
      if (typeof mode === "string" && !BUILTIN_MODES.has(mode.toLowerCase())) {
        const t = nodeId("agent", mode);
        ctx.b.addNode({ id: t, kind: "agent", label: mode, confidence: "inferred", source: src });
        ctx.b.addEdge({ from: id, to: t, kind: "invokes", source: src });
      }
      break;
    }
    case "skill": {
      const name = typeof fm.name === "string" ? fm.name : basename(dirname(f.rel));
      id = nodeId("skill", name);
      ctx.b.addNode({ id, kind: "skill", label: name, description: desc, source: src, props: { flavor: f.flavor } });
      break;
    }
    default:
      return;
  }

  ctx.owners.set(f.rel, id);
  const tools = [...toList(fm.tools), ...toList(fm["allowed-tools"]), ...toList(fm.allowedTools)];
  for (const t of tools) linkTool(id, t, src, "declared", ctx);
}

/** Create tool / server nodes for a tool reference and connect `from` to it. */
function linkTool(from: string, raw: string, src: SourceRef, confidence: "declared" | "inferred", ctx: Ctx): string | null {
  const ref = parseToolRef(raw);
  if (!ref) return null;
  const fromKind = ctx.b.get(from)?.kind;
  const kind: EdgeKind = fromKind && allowed("uses", fromKind) ? "uses" : "references";
  if (ref.server) {
    const sid = nodeId("mcp_server", ref.server);
    const known = ctx.servers.has(ref.server.toLowerCase());
    ctx.b.addNode({ id: sid, kind: "mcp_server", label: ref.server, confidence: known ? "declared" : "inferred", source: known ? undefined : src, props: known ? undefined : { undeclared: true } });
    if (!ref.tool) {
      ctx.b.addEdge({ from, to: sid, kind, label: "all tools", source: src, confidence });
      return sid;
    }
    const tid = nodeId("tool", `${ref.server}/${ref.tool}`);
    ctx.b.addNode({ id: tid, kind: "tool", label: ref.tool, confidence, source: src, props: { server: ref.server } });
    ctx.b.addEdge({ from: sid, to: tid, kind: "provides", source: src, confidence });
    ctx.b.addEdge({ from, to: tid, kind, source: src, confidence });
    return tid;
  }
  const tid = nodeId("tool", ref.tool!);
  ctx.b.addNode({ id: tid, kind: "tool", label: ref.tool!, confidence, source: src, props: { builtin: true } });
  ctx.b.addEdge({ from, to: tid, kind, source: src, confidence });
  return tid;
}

function scanHooks(f: HarnessFile, ctx: Ctx) {
  let doc: Record<string, unknown>;
  try {
    doc = parseJsonc(readFileSync(f.abs, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      const matcher = typeof g?.matcher === "string" && g.matcher ? g.matcher : "*";
      const commands = (Array.isArray(g?.hooks) ? g.hooks : []).map((h: Record<string, unknown>) => h?.command).filter(Boolean);
      const id = nodeId("trigger", `hook/${event}/${matcher === "*" ? "all" : matcher}`);
      const src = { file: f.rel, line: lineOf(f.abs, `"${event}"`) };
      ctx.b.addNode({ id, kind: "trigger", label: `${event} ${matcher}`, source: src, description: `Hook on ${event} (matcher: ${matcher})`, props: { event, matcher, commands } });
      if (matcher !== "*") {
        for (const t of matcher.split("|")) {
          if (!/^[\w-]+(__[\w-]+)*$/.test(t)) continue;
          const tid = linkTool(id, t, src, "declared", ctx);
          if (tid) ctx.b.addEdge({ from: id, to: tid, kind: "references", label: "guards", source: src });
        }
      }
    }
  }
}

function firstParagraph(md: ParsedMd): string | undefined {
  const para: string[] = [];
  for (const l of md.lines) {
    const t = l.text.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^(#|[-*+]\s|\d+[.)]\s|>|\||<)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const s = stripInline(para.join(" "));
  return s ? (s.length > 280 ? s.slice(0, 277) + "…" : s) : undefined;
}

// ---------------------------------------------------------------- pass 2

function allowed(kind: EdgeKind, fromKind: NodeKind, toKind?: NodeKind): boolean {
  const r = EDGE_RULES[kind];
  const okFrom = r.from === "*" || r.from.includes(fromKind);
  const okTo = !toKind || r.to === "*" || r.to.includes(toKind);
  return okFrom && okTo;
}

/** Add `preferred` if the endpoint kinds allow it, otherwise `references`. */
function relate(ctx: Ctx, from: string, to: string, preferred: EdgeKind, src: SourceRef, label?: string) {
  const fk = ctx.b.get(from)?.kind;
  const tk = ctx.b.get(to)?.kind;
  if (!fk || !tk || from === to) return;
  const kind = allowed(preferred, fk, tk) ? preferred : "references";
  ctx.b.addEdge({ from, to, kind, source: src, confidence: "inferred", ...(label ? { label } : {}) });
}

/** Section heading → what the section holds. Workflow beats rules beats inventory. */
export function classifyHeading(text: string): "workflow" | "rules" | NodeKind | null {
  if (WORKFLOW_HEADING.test(text)) return "workflow";
  if (RULE_HEADING.test(text)) return "rules";
  return INVENTORY.find((i) => i.re.test(text))?.kind ?? null;
}

function scanInventory(rel: string, md: ParsedMd, ctx: Ctx): Set<number> {
  const consumed = new Set<number>();
  const owner = ctx.owners.get(rel);
  if (!owner) return consumed;
  for (const sec of sections(md)) {
    const c = classifyHeading(sec.heading!.text);
    if (c && c !== "workflow" && c !== "rules") extractInventory(rel, owner, c, sec.lines, consumed, ctx);
  }
  return consumed;
}

function scanBody(rel: string, md: ParsedMd, consumed: Set<number>, ctx: Ctx) {
  const owner = ctx.owners.get(rel);
  if (!owner) return;
  const ownerSlug = owner.slice(owner.indexOf(":") + 1);

  for (const sec of sections(md)) {
    const c = classifyHeading(sec.heading!.text);
    if (c === "workflow") extractWorkflow(rel, owner, ownerSlug, sec.heading!.text, sec.lines, consumed, ctx);
    else if (c === "rules") extractRules(rel, owner, ownerSlug, sec.lines, consumed, ctx, true);
  }
  // Rules can appear anywhere as shouted bullets.
  extractRules(rel, owner, ownerSlug, md.lines, consumed, ctx, false);

  // Remaining body lines: mentions attributed to the file's own node.
  for (const l of md.lines) {
    if (consumed.has(l.line)) continue;
    mentions(l.text, { file: rel, line: l.line }, owner, "normal", ctx);
    localLinks(rel, l, owner, ctx);
  }
}

function extractWorkflow(rel: string, owner: string, ownerSlug: string, heading: string, lines: MdLine[], consumed: Set<number>, ctx: Ctx) {
  let steps = listItems(lines).filter((i) => i.ordered && !consumed.has(i.line));
  let fromHeadings = false;
  if (steps.length < 2) {
    // Fallback: "### Step 1 — Plan" style sub-headings.
    const subs = lines.filter((l) => /^#{2,6}\s+((step|phase|stage)\s*\d+|\d+[.)])/i.test(l.text) && !consumed.has(l.line));
    steps = subs.map((l) => ({ text: l.text.replace(/^#+\s+/, ""), line: l.line, ordered: true, indent: 0 }));
    fromHeadings = true;
  }
  if (steps.length < 2) return;

  const wf = slug(heading).slice(0, 40);
  const base = `${ownerSlug}/${wf}`;
  const ownerKind = ctx.b.get(owner)!.kind;
  const ids: string[] = [];
  const last = steps.length - 1;

  steps.forEach((s, i) => {
    const text = stripInline(s.text);
    const id = `state:${base}/${String(i + 1).padStart(2, "0")}`;
    ids.push(id);
    const src = { file: rel, line: s.line };
    ctx.b.addNode({
      id, kind: "state", label: shortLabel(text), description: text, source: src, confidence: "inferred",
      initial: i === 0, terminal: i === last,
      props: { workflow: heading, step: i + 1, owner },
    });
    consumed.add(s.line);
    if (!fromHeadings) for (const l of lines) if (l.line > s.line && (i + 1 >= steps.length || l.line < steps[i + 1].line)) consumed.add(l.line);
    if (ownerKind === "agent") relate(ctx, id, owner, "performed_by", src);
    mentions(s.text, src, id, "normal", ctx);
  });

  // Gates: a guard BEFORE step i (pre) or AFTER step i (post).
  const pre: Array<string | null> = steps.map(() => null);
  const post: Array<{ id: string; loopTo?: number } | null> = steps.map(() => null);
  steps.forEach((s, i) => {
    const src = { file: rel, line: s.line };
    const nn = String(i + 1).padStart(2, "0");
    const loop = detectLoop(s.text);
    if (loop && loop.target >= 0 && loop.target < steps.length && loop.target !== i) {
      const gid = `gate:${base}/${nn}-check`;
      addGate(ctx, gid, asQuestion(loop.condition), [loop.clause], classifyGate(s.text), src, ids[i]);
      post[i] = { id: gid, loopTo: loop.target };
      return;
    }
    const hit = detectGate(s.text);
    if (!hit) return;
    const before = (hit.before || i === last) && i > 0;
    const gid = `gate:${base}/${nn}-${before ? "entry" : "exit"}`;
    addGate(ctx, gid, asQuestion(hit.clause), [hit.clause], classifyGate(hit.clause), src, ids[i]);
    if (before) pre[i] = gid;
    else post[i] = { id: gid };
  });

  const entryOf = (i: number) => pre[i] ?? ids[i];
  const t = (from: string, to: string, line: number, label?: string) =>
    ctx.b.addEdge({ from, to, kind: "transitions_to", confidence: "inferred", source: { file: rel, line }, ...(label ? { label } : {}) });
  steps.forEach((s, i) => {
    if (pre[i]) t(pre[i]!, ids[i], s.line, "pass");
    const g = post[i];
    if (g) {
      t(ids[i], g.id, s.line);
      if (g.loopTo !== undefined) {
        t(g.id, ids[g.loopTo], s.line, "yes");
        if (i < last) t(g.id, entryOf(i + 1), steps[i + 1].line, "no");
        if (g.loopTo < i) delete ctx.b.get(ids[i])!.terminal;
      } else if (i < last) t(g.id, entryOf(i + 1), steps[i + 1].line, "pass");
    } else if (i < last) t(ids[i], entryOf(i + 1), steps[i + 1].line);
  });

  // Start condition / entry point.
  const src = { file: rel, line: steps[0].line };
  if (ownerKind === "prompt") relate(ctx, owner, entryOf(0), "invokes", src);
  else relate(ctx, owner, ids[0], "defines", src, heading);
  if (ownerKind === "instruction" || ownerKind === "skill") {
    const intro = lines.find((l) => l.line < steps[0].line && l.text.trim() && !/^\s*(#|[-*+]\s|\d+[.)]\s|>)/.test(l.text));
    const cond = intro ? startCondition(intro.text) : null;
    const tid = `trigger:${base}/start`;
    ctx.b.addNode({
      id: tid, kind: "trigger", label: cond ?? (ownerKind === "skill" ? `Skill "${ctx.b.get(owner)!.label}" is used` : `Start: ${heading}`), confidence: "inferred",
      description: cond ? stripInline(intro!.text) : `Entry into the "${heading}" workflow (no explicit start condition found)`,
      source: intro ? { file: rel, line: intro.line } : src,
      props: { workflow: heading, start: true, explicit: !!cond },
    });
    relate(ctx, owner, tid, "defines", src);
    t(tid, entryOf(0), steps[0].line);
  }
}

/** A gate node plus its evaluator: tools the guarded state uses (automated), the user (human), or mentioned agents. */
function addGate(ctx: Ctx, id: string, label: string, criteria: string[], gateType: GateType, src: SourceRef, stateId: string) {
  ctx.b.addNode({ id, kind: "gate", label, criteria, gateType, source: src, confidence: "inferred", description: criteria.join("; ") });
  for (const c of criteria) mentions(c, src, id, "normal", ctx);
  if (gateType === "automated") {
    for (const e of ctx.b.allEdges()) if (e.from === stateId && e.kind === "uses") ctx.b.addEdge({ from: id, to: e.to, kind: "uses", confidence: "inferred", source: src });
  }
  if (gateType === "human") {
    ctx.b.addNode({ id: HUMAN_ACTOR, kind: "actor", label: "user (human approver)", confidence: "inferred", source: src });
    ctx.b.addEdge({ from: id, to: HUMAN_ACTOR, kind: "performed_by", confidence: "inferred", source: src });
  }
}

function shortLabel(text: string): string {
  const first = text.split(/(?<=[.!?:])\s|\s[—–-]\s/)[0];
  const s = first.length >= 8 ? first : text;
  return s.length > 64 ? s.slice(0, 61).trimEnd() + "…" : s;
}

function extractRules(rel: string, owner: string, ownerSlug: string, lines: MdLine[], consumed: Set<number>, ctx: Ctx, wholeSection: boolean) {
  for (const item of listItems(lines, wholeSection)) {
    if (consumed.has(item.line)) continue;
    const text = stripInline(item.text);
    if (!wholeSection && !(RULE_LINE.test(text) || RULE_SHOUT.test(item.text))) continue;
    if (text.length < 6) continue;
    const id = nodeId("rule", `${ownerSlug}/${slug(text.split(" ").slice(0, 7).join(" "))}`);
    const src = { file: rel, line: item.line };
    ctx.b.addNode({ id, kind: "rule", label: shortLabel(text), description: text, source: src, confidence: "inferred" });
    relate(ctx, owner, id, "defines", src);
    consumed.add(item.line);
    mentions(item.text, src, id, "constrain", ctx);
  }
}

function extractInventory(rel: string, owner: string, kind: NodeKind, lines: MdLine[], consumed: Set<number>, ctx: Ctx) {
  for (const item of listItems(lines)) {
    if (consumed.has(item.line)) continue;
    const m =
      item.text.match(/^\*\*([^*]{1,60})\*\*\s*[:—–-]?\s*(.*)$/) ??
      item.text.match(/^`([^`]{1,60})`\s*[:—–-]?\s*(.*)$/) ??
      item.text.match(/^([A-Za-z0-9@/_.-]+(?:\s[A-Za-z0-9@/_.-]+){0,3})\s*(?::|\s[—–-]\s)\s*(.*)$/);
    if (!m) continue;
    const name = m[1].trim().replace(/^@/, "").replace(/:$/, "");
    const desc = stripInline(m[2] ?? "");
    const src = { file: rel, line: item.line };
    let id: string | null;
    if (kind === "tool") {
      id = linkTool(owner, name, src, "inferred", ctx);
      if (id && desc) {
        const n = ctx.b.get(id)!;
        if (!n.description) n.description = desc;
      }
    } else {
      id = nodeId(kind, name);
      ctx.b.addNode({ id, kind, label: name, description: desc || undefined, source: src, confidence: "inferred" });
      relate(ctx, owner, id, "defines", src);
      if (kind === "agent" || kind === "skill" || kind === "mcp_server") ctx.names.set(name.toLowerCase(), id);
    }
    if (!id) continue;
    consumed.add(item.line);
    if (desc) mentions(m[2], src, id, "normal", ctx);
  }
}

const PATH_RE = /`((?:\.{1,2}\/)?[\w@*.-]*[A-Za-z][\w@*.-]*(?:\/[\w@*.-]+)*(?:\.[A-Za-z][\w]{0,5}|\/)|\.[A-Za-z][\w.-]*)`/g;

/** Resolve mentions of known entities, tool refs and file paths in one line of text. */
function mentions(text: string, src: SourceRef, from: string, mode: "normal" | "constrain", ctx: Ctx) {
  const pref = (k: EdgeKind): EdgeKind => (mode === "constrain" ? "constrains" : k);
  const fromIsState = ["state", "gate"].includes(ctx.b.get(from)?.kind ?? "");
  const agentEdge: EdgeKind = fromIsState && !HANDOFF.test(text) ? "performed_by" : "delegates_to";

  // mcp__server__tool anywhere
  for (const m of text.matchAll(/\bmcp__[\w-]+?__[\w*-]+/g)) {
    if (mode === "constrain") {
      const ref = parseToolRef(m[0]);
      const tid = ref?.tool ? nodeId("tool", `${ref.server}/${ref.tool}`) : null;
      if (tid && ctx.b.has(tid)) relate(ctx, from, tid, "constrains", src);
    } else linkTool(from, m[0], src, "inferred", ctx);
  }
  // #tool:name (Copilot)
  for (const m of text.matchAll(/#tool:([\w./-]+)/g)) linkTool(from, m[1], src, "inferred", ctx);

  // @agent
  for (const m of text.matchAll(/(?:^|[\s(])@([\w-]+)/g)) {
    const id = ctx.names.get(m[1].toLowerCase());
    if (id?.startsWith("agent:")) relate(ctx, from, id, pref(agentEdge), src);
  }
  // "the reviewer agent", "`reviewer`", "**reviewer**", "/command"
  const candidates = [
    ...[...text.matchAll(/`([^`]{2,60})`/g)].map((m) => m[1]),
    ...[...text.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b([\w-]{3,40})\s+(?:sub-?)?agent\b/gi)].map((m) => m[1]),
    ...[...text.matchAll(/(?:^|\s)(\/[\w-]{2,40})\b/g)].map((m) => m[1]),
    ...[...text.matchAll(/\b([\w-]{3,40})\s+skill\b/gi)].map((m) => m[1]),
  ];
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/^@/, "");
    const id = ctx.names.get(key);
    if (!id || id === from) continue;
    const kind = id.slice(0, id.indexOf(":"));
    const fromKind = ctx.b.get(from)?.kind;
    let edge: EdgeKind = "references";
    if (kind === "tool" || kind === "skill" || kind === "mcp_server") edge = "uses";
    else if (kind === "agent") edge = agentEdge;
    else if (kind === "instruction" || fromKind === undefined) edge = "references";
    else if (kind === "prompt") edge = "invokes";
    relate(ctx, from, id, pref(edge), src);
  }

  // `path/to/file.ext` → artifact
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, "");
    if (/^\d/.test(p) || ctx.names.has(p.toLowerCase()) || /^mcp__/.test(p)) continue;
    if (!p.includes("/") && !/\.[A-Za-z]/.test(p)) continue;
    const aid = nodeId("artifact", p);
    ctx.b.addNode({ id: aid, kind: "artifact", label: p, source: src, confidence: "inferred" });
    const verb = mode === "constrain" ? "constrains" : verbBefore(text, m.index ?? 0);
    relate(ctx, from, aid, verb, src);
  }
}

/** The nearest reads/writes verb before `idx` decides whether a path is an input or output. */
export function verbBefore(text: string, idx: number): EdgeKind {
  const before = text.slice(0, idx);
  let best: { at: number; kind: EdgeKind } | null = null;
  for (const [re, kind] of [[WRITES_VERB, "writes"], [READS_VERB, "reads"]] as const) {
    re.lastIndex = 0;
    for (const m of before.matchAll(re)) if (!best || (m.index ?? 0) > best.at) best = { at: m.index ?? 0, kind };
  }
  if (best) return best.kind;
  const after = text.slice(idx);
  if (/^\S+`?\s+(is|are)\s+(written|created|generated|updated|produced)/i.test(after)) return "writes";
  return "references";
}

/** Markdown links to local files → references to that file's node or an artifact. */
function localLinks(rel: string, l: MdLine, owner: string, ctx: Ctx) {
  for (const m of l.text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(rel), target)).replace(/^\.\//, "");
    const src = { file: rel, line: l.line };
    const node = ctx.owners.get(resolved);
    if (node) {
      relate(ctx, owner, node, "references", src);
    } else {
      const aid = nodeId("artifact", resolved);
      ctx.b.addNode({ id: aid, kind: "artifact", label: resolved, source: src, confidence: "inferred" });
      relate(ctx, owner, aid, verbBefore(l.text, m.index ?? 0), src);
    }
  }
}
