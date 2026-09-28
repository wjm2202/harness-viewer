import { EDGE_KINDS, EDGE_RULES, NODE_KINDS, type Graph } from "./schema.js";
import type { LintReport } from "./lint.js";

export const NODE_MEANING: Record<(typeof NODE_KINDS)[number], string> = {
  instruction: "An instruction file (copilot-instructions.md, AGENTS.md, CLAUDE.md, *.instructions.md).",
  agent: "An agent, chat mode, sub-agent or persona that does work.",
  prompt: "A reusable prompt / slash command — an entry point into a workflow.",
  skill: "A packaged skill (SKILL.md) an agent can load.",
  mcp_server: "An MCP server declared in config (.vscode/mcp.json, .mcp.json…).",
  tool: "A callable tool, built-in (edit, search, Bash) or MCP-provided (server/tool).",
  state: "A stage or step of the workflow. Owned by the agent/actor that performs it.",
  gate: "A guard between states: the criteria that must hold to progress (drawn as a diamond).",
  artifact: "A file, folder, doc or dataset that is read (input) or written (output).",
  trigger: "A START CONDITION: user request, issue opened, CI event, schedule, hook.",
  actor: "A human role: user, reviewer, maintainer, approver.",
  rule: "A constraint or guard-rail stated in the instructions.",
};

export const EDGE_MEANING: Record<(typeof EDGE_KINDS)[number], string> = {
  defines: "declares / introduces",
  transitions_to: "is followed by (put the condition in `label`)",
  performed_by: "is carried out by",
  uses: "calls / loads",
  provides: "exposes the tool",
  reads: "takes as INPUT",
  writes: "produces as OUTPUT",
  delegates_to: "hands work off to",
  invokes: "starts",
  triggers: "fires / starts",
  constrains: "limits / governs",
  references: "mentions (weakest — prefer a specific kind)",
};

export interface BriefOptions {
  /** Path of graph.json relative to the repo root, as the agent should write it. */
  graphPath: string;
  /** Command prefix the agent should run, e.g. "npx discovery-graph". */
  cli: string;
}

/**
 * The prompt handed to an AI agent (Copilot, Claude, …) to ENRICH the scanned
 * graph: turn prose into states, transitions, inputs and outputs, then review
 * the harness. The scan is the skeleton; the brief is how the agent adds meaning.
 */
export function renderBrief(g: Graph, lint: LintReport, opts: BriefOptions): string {
  const o = opts;
  const counts = Object.entries(lint.metrics.nodes).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing";
  const gaps = lint.findings.filter((f) => f.severity !== "info" || ["state-no-actor", "agent-no-entry", "gate-no-fail-path", "gate-no-evaluator", "start-condition-implicit"].includes(f.rule)).slice(0, 30);
  const L: string[] = [];

  L.push(`# Agent brief — map the harness of \`${g.meta.name}\``, "");
  L.push(
    "You are reviewing an **agentic harness**: the instructions, agents, prompts, skills, MCP tools and hooks that make AI agents work in this repository.",
    "Your job is to turn it into an accurate **state machine of the agent workflow**, read top to bottom:",
    "",
    "```",
    "● start condition        (trigger: \"When an issue is labelled agent\", or a /prompt)",
    "▭ stage — agent A        (state, performed_by agent A; reads inputs, writes outputs)",
    "◇ gate                   (criteria that must hold to move on; pass ↓  fail ↺)",
    "▭ stage — agent B",
    "◉ end                    (terminal state)",
    "```",
    "",
    "> **Scope: the agent workflow, not the application.** Do NOT review, summarise or map the application's source code, architecture or business logic. Read source files only when a harness file points at them as part of the workflow (e.g. a script a gate runs). Every node you add must describe how the AGENTS work.",
    "",
  );
  L.push("## 1. Where things are", "");
  L.push(`- Repository: \`${g.meta.root}\``);
  if (/^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(g.meta.root)) {
    L.push(`- The repository is **remote**. Clone it first (\`git clone --depth 1 ${g.meta.root}\`) and read the files below relative to the clone root. The graph lives outside the clone.`);
  }
  L.push(`- Graph file: \`${o.graphPath}\` (already created by a deterministic scan: ${counts})`);
  L.push("- Harness files found by the scan (read ALL of them):", "");
  for (const f of g.meta.scannedFiles) L.push(`  - \`${f}\``);
  if (!g.meta.scannedFiles.length) L.push("  - _(none — look for README/CONTRIBUTING/docs describing agent workflows, CI workflows that call agents, and any `*.md` that instructs an AI)_");
  L.push("");

  L.push("## 2. What to do", "");
  L.push(
    "1. Read every harness file above, plus any file they link to that describes the agents' process (workflow docs, runbooks, CI workflows that run agents).",
    `2. Open \`${o.graphPath}\`. Items with \`"origin": "scan"\` were found mechanically: keep them. Many \`inferred\` ones are guesses — confirm or override them (see rules).`,
    "3. **Start condition.** For each workflow add (or correct) a `trigger` node saying exactly when it starts (\"When a new issue is labelled `agent`\", \"When the user runs /new-feature\"), with `transitions_to` → the first stage. Set `props.explicit: true` when the repo states it.",
    "4. **Stages.** One `state` per stage of work, each with `performed_by` → the agent (or `actor` for humans), `reads` (inputs), `writes` (outputs) and `uses` (tools/skills). Mark the first `\"initial\": true` and real end states `\"terminal\": true`. An agent's own detailed steps can be a sub-flow: give those states `\"parent\": \"<stage id>\"`.",
    "5. **Gates.** Between stages — above all wherever work passes from one agent to another — add a `gate` node: `state → gate → next state`. Give it `criteria` (one checkable statement each: \"all tests pass\", \"PLAN.md lists acceptance criteria\", \"a maintainer approved\"), a `gateType` (`human`, `automated`, `agent`) and an evaluator (`performed_by` the agent/actor that decides, or `uses` the tool that checks). Label the exits: `pass` down to the next stage, `fail` back to where the work is redone.",
    "6. **Implicit gates.** The scan inserted `gateType: \"implicit\"` gates where agents hand off without stated criteria. If the repo does state criteria, override the gate with real ones; if not, leave it implicit — that is a finding.",
    "7. Anchor each `rule` with `constrains` edges to the stages, gates, tools or artifacts it limits.",
    `8. Run \`${o.cli} validate ${o.graphPath}\` and fix every error. Repeat until it passes.`,
    `9. Run \`${o.cli} lint ${o.graphPath}\` and resolve each warning — either by fixing the graph (it was incomplete) or by recording it as a real finding in the review (the harness really has that gap).`,
    `10. Write the review to \`${o.graphPath.replace(/graph\.json$/, "REVIEW.md")}\` using the template in section 5.`,
    `11. Run \`${o.cli} view ${o.graphPath}\` to regenerate the viewer (index.html) and the Mermaid state diagram (statemachine.md).`,
    "",
  );

  L.push("## 3. Rules for editing the graph", "");
  L.push(
    "- **Never delete or edit items with `\"origin\": \"scan\"`** — they are regenerated on every scan. To correct one, add a node with the **same id** and `\"origin\": \"agent\"`; it overrides the scan version and survives re-scans.",
    "- Everything you add gets `\"origin\": \"agent\"`.",
    "- Everything you add gets a `source`: `{ \"file\": \"repo/relative/path\", \"line\": N }` pointing at the text that justifies it. No source = you are guessing.",
    "- `confidence`: `declared` only when the repo states it explicitly (frontmatter, config, an explicit sentence); `inferred` when you derived it from prose; `speculative` when it is your hypothesis — explain why in `description`.",
    "- Ids are `<kind>:<slug>` — lowercase `a-z 0-9 . _ / * -`. States: `state:<workflow>/<nn>-<short-name>`; gates: `gate:<workflow>/<nn>-<short-name>`.",
    "- Do not invent agents, tools or files that the repo does not mention. If the process has an obvious hole, record it in the review, not as a fake node.",
    "- Prefer a specific edge kind over `references`.",
    "",
  );

  L.push("## 4. Vocabulary", "");
  L.push("### Node kinds", "", "| kind | meaning |", "|---|---|");
  for (const k of NODE_KINDS) L.push(`| \`${k}\` | ${NODE_MEANING[k]} |`);
  L.push("", "### Edge kinds (read `from —kind→ to` as a sentence)", "", "| kind | meaning | from | to |", "|---|---|---|---|");
  for (const k of EDGE_KINDS) {
    const r = EDGE_RULES[k];
    const fmt = (x: readonly string[] | "*") => (x === "*" ? "any" : x.join(", "));
    L.push(`| \`${k}\` | ${EDGE_MEANING[k]} | ${fmt(r.from)} | ${fmt(r.to)} |`);
  }
  L.push("", "### Shapes", "", "```json");
  L.push(JSON.stringify({ id: "state:feature/02-implement", kind: "state", label: "Implement the plan", origin: "agent", confidence: "inferred", source: { file: ".github/copilot-instructions.md", line: 21 } }));
  L.push(JSON.stringify({ id: "gate:feature/03-tests-green", kind: "gate", label: "Tests green?", gateType: "automated", criteria: ["npm test exits 0", "no skipped tests added"], origin: "agent", confidence: "inferred", source: { file: ".github/copilot-instructions.md", line: 23 } }));
  L.push(JSON.stringify({ from: "gate:feature/03-tests-green", to: "state:feature/02-implement", kind: "transitions_to", label: "fail", origin: "agent", confidence: "inferred", source: { file: ".github/copilot-instructions.md", line: 23 } }));
  L.push("```", "");

  L.push("## 5. Review template", "");
  L.push(
    "```markdown",
    `# Harness review — ${g.meta.name}`,
    "",
    "## How it works (≤ 10 lines)",
    "Start conditions → stages (who does what) → gates (what must be true to move on) → what gets produced.",
    "",
    "## Gates",
    "| gate | between | type | criteria | evaluator | missing? |",
    "",
    "## Findings",
    "| # | finding | evidence (node ids / file:line) | impact | fix |",
    "",
    "## Eval opportunities",
    "For each gate and important stage: the observable output, a pass/fail check, and how to test it automatically.",
    "",
    "## Evolution proposals",
    "Smallest changes that would remove a finding or make a state measurable. One line each, ranked.",
    "```",
    "",
  );

  L.push("## 6. Gaps the scan already sees", "");
  if (!gaps.length) L.push("_None flagged — still verify the workflows are complete._");
  for (const f of gaps) L.push(`- [${f.rule}] ${f.message}`);
  L.push("");
  return L.join("\n");
}
