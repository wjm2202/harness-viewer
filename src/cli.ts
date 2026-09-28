import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { renderBrief } from "./brief.js";
import { buildJsonSchema } from "./jsonSchema.js";
import { lintGraph, renderLintMarkdown } from "./lint.js";
import { mergeGraphs } from "./merge.js";
import { cloneShallow, isRemote, normaliseRepoUrl } from "./remote.js";
import { scanRepo } from "./scan/index.js";
import type { Graph } from "./schema.js";
import { validateGraph } from "./validate.js";
import { renderViewer } from "./viewer.js";
import { buildMachine, renderMermaid } from "./machine.js";

export const VERSION = "0.1.0";
export const DEFAULT_DIR = ".discovery-graph";
const CLI = "npx discovery-graph";

export interface Io {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Injectable for tests; defaults to a real shallow git clone. */
  clone?: typeof cloneShallow;
}

const HELP = `discovery-graph ${VERSION} — map an agentic harness into a process graph

Usage
  discovery-graph [all] [path|git-url] [--out DIR]   scan + lint + brief + viewer (default)
  discovery-graph scan  [path|git-url] [--out DIR]   deterministic scan → graph.json (keeps agent/human edits)
  discovery-graph brief [path|git-url] [--out DIR]   write AGENT_BRIEF.md for an AI agent to enrich the graph
  discovery-graph validate [graph.json]              check the graph against the schema (exit 1 on errors)
  discovery-graph lint  [graph.json] [--strict] [--json]  analyse the harness (exit 1 on errors; --strict: on warnings too)
  discovery-graph view  [graph.json]                 write index.html (viewer) + statemachine.md (Mermaid) next to the graph
  discovery-graph schema                             print the JSON Schema

Outputs go to <repo>/${DEFAULT_DIR}/ (or ./${DEFAULT_DIR}/<repo-name>/ for a URL).
Nothing is sent anywhere; a URL is shallow-cloned read-only into a temp dir and deleted afterwards.`;

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const cmds = new Set(["all", "scan", "brief", "validate", "lint", "view", "schema", "help"]);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (k === "out" && argv[i + 1] && !argv[i + 1].startsWith("-")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  const cmd = positional.length && cmds.has(positional[0]) ? positional.shift()! : "all";
  return { cmd, positional, flags };
}

export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (args.flags.help || args.cmd === "help") return io.out(HELP), 0;
  if (args.flags.version) return io.out(VERSION), 0;
  try {
    switch (args.cmd) {
      case "schema":
        io.out(JSON.stringify(buildJsonSchema(), null, 2));
        return 0;
      case "validate":
        return cmdValidate(args, io);
      case "lint":
        return cmdLint(args, io);
      case "view":
        return cmdView(args, io);
      case "scan":
      case "brief":
      case "all":
        return cmdScanFamily(args, io);
    }
    io.err(`unknown command: ${args.cmd}\n\n${HELP}`);
    return 2;
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 2;
  }
}

function graphPathArg(args: Args, io: Io): string {
  const p = args.positional[0] ?? join(DEFAULT_DIR, "graph.json");
  const abs = resolve(io.cwd, p);
  return existsSync(abs) && !abs.endsWith(".json") ? join(abs, "graph.json") : abs;
}

/** Path for humans: relative to cwd when inside it, absolute otherwise. */
function show(cwd: string, p: string): string {
  const r = relative(cwd, p);
  return !r || r.startsWith("..") ? p : r;
}

function loadGraph(path: string): unknown {
  if (!existsSync(path)) throw new Error(`no graph at ${path} — run \`${CLI} scan\` first`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

function cmdValidate(args: Args, io: Io): number {
  const path = graphPathArg(args, io);
  const r = validateGraph(loadGraph(path));
  if (r.ok) {
    io.out(`✓ ${show(io.cwd, path)} is valid`);
    return 0;
  }
  io.err(`✗ ${r.errors.length} error(s) in ${show(io.cwd, path)}`);
  for (const e of r.errors) io.err(`  ${e.path}: ${e.message}`);
  return 1;
}

function cmdLint(args: Args, io: Io): number {
  const path = graphPathArg(args, io);
  const g = loadGraph(path) as Graph;
  const report = lintGraph(g);
  const md = renderLintMarkdown(g, report);
  writeFileSync(join(dirname(path), "lint.md"), md);
  io.out(args.flags.json ? JSON.stringify(report, null, 2) : md);
  if (report.counts.error) return 1;
  if (args.flags.strict && report.counts.warn) return 1;
  return 0;
}

function cmdView(args: Args, io: Io): number {
  const path = graphPathArg(args, io);
  const g = loadGraph(path) as Graph;
  const r = validateGraph(g);
  if (!r.ok) {
    io.err(`graph is invalid — fix it first (\`${CLI} validate\`):`);
    for (const e of r.errors.slice(0, 10)) io.err(`  ${e.path}: ${e.message}`);
    return 1;
  }
  const html = join(dirname(path), "index.html");
  const machine = buildMachine(g);
  writeFileSync(html, renderViewer(g, lintGraph(g), machine));
  writeFileSync(join(dirname(path), "statemachine.md"), renderMermaid(g, machine));
  io.out(`viewer → ${show(io.cwd, html)}  (open it in a browser)`);
  io.out(`mermaid → ${show(io.cwd, join(dirname(path), "statemachine.md"))}`);
  return 0;
}

function cmdScanFamily(args: Args, io: Io): number {
  const target = args.positional[0] ?? ".";
  let root: string;
  let displayRoot: string | undefined;
  let outDir: string;
  let cleanup = () => {};

  if (isRemote(target)) {
    io.err(`cloning ${target} (shallow, read-only)…`);
    const co = (io.clone ?? cloneShallow)(target);
    root = co.dir;
    cleanup = co.cleanup;
    displayRoot = target;
    const repoName = basename(normaliseRepoUrl(target).url).replace(/\.git$/, "") || "repo";
    outDir = resolve(io.cwd, typeof args.flags.out === "string" ? args.flags.out : join(DEFAULT_DIR, repoName));
  } else {
    root = resolve(io.cwd, target);
    if (!existsSync(root)) throw new Error(`path not found: ${root}`);
    outDir = resolve(typeof args.flags.out === "string" ? resolve(io.cwd, args.flags.out) : join(root, DEFAULT_DIR));
  }

  try {
    mkdirSync(outDir, { recursive: true });
    const graphPath = join(outDir, "graph.json");
    const previous = existsSync(graphPath) ? (JSON.parse(readFileSync(graphPath, "utf8")) as Graph) : null;
    const scanned = scanRepo(root, { displayRoot });
    io.out(`scanning ${displayRoot ?? root}`);
    const files = scanned.meta.scannedFiles;
    for (const f of files.slice(0, 20)) io.out(`  · ${f}`);
    if (files.length > 20) io.out(`  · … and ${files.length - 20} more`);
    const { graph, droppedEdges, keptNodes, keptEdges } = mergeGraphs(previous, scanned);
    writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n");
    const rel = (p: string) => show(io.cwd, p);
    io.out(`scan: ${scanned.meta.scannedFiles.length} harness files → ${graph.nodes.length} nodes, ${graph.edges.length} edges → ${rel(graphPath)}`);
    if (keptNodes || keptEdges) io.out(`      kept ${keptNodes} enriched nodes, ${keptEdges} enriched edges from the previous graph`);
    for (const e of droppedEdges) io.err(`      dropped enriched edge ${e.from} —${e.kind}→ ${e.to} (endpoint no longer exists)`);
    if (!scanned.meta.scannedFiles.length) {
      io.err(`      no harness files found in ${displayRoot ?? root}`);
      io.err("      looked for: .github/copilot-instructions.md, *.instructions.md, AGENTS.md, CLAUDE.md, *.agent.md, *.chatmode.md, *.prompt.md, SKILL.md, .claude/agents, .claude/commands, mcp.json");
      io.err(`      is this the right folder? pass the repo path: ${CLI} /path/to/repo`);
    }
    if (args.cmd === "scan") return 0;

    const report = lintGraph(graph);
    const graphRel = displayRoot ? rel(graphPath) : relative(root, graphPath);
    writeFileSync(join(outDir, "AGENT_BRIEF.md"), renderBrief(graph, report, { graphPath: graphRel, cli: CLI }));
    io.out(`brief: ${rel(join(outDir, "AGENT_BRIEF.md"))}`);
    if (args.cmd === "brief") return 0;

    const machine = buildMachine(graph);
    writeFileSync(join(outDir, "lint.md"), renderLintMarkdown(graph, report));
    writeFileSync(join(outDir, "index.html"), renderViewer(graph, report, machine));
    writeFileSync(join(outDir, "statemachine.md"), renderMermaid(graph, machine));
    const top = machine.workflows.filter((w) => w.scope === null);
    io.out(`flow:  ${top.length} workflow(s), ${graph.nodes.filter((n) => n.kind === "gate").length} gates → ${rel(join(outDir, "statemachine.md"))}`);
    io.out(`lint:  ${report.counts.error} errors, ${report.counts.warn} warnings, ${report.counts.info} notes → ${rel(join(outDir, "lint.md"))}`);
    io.out(`view:  ${rel(join(outDir, "index.html"))}`);
    io.out("");
    io.out(`next: ask your AI agent → "Follow ${rel(join(outDir, "AGENT_BRIEF.md"))}"`);
    return 0;
  } finally {
    cleanup();
  }
}
