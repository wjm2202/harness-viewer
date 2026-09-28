# discovery-graph/2 — graph specification

This is the **normative** description of `graph.json`. It is written for humans and for AI agents that enrich a graph. `test/spec-drift.test.ts` fails if a kind, origin, confidence or lint rule exists in code but not here.

## 1. What the graph is

A **state machine of an agentic workflow**, embedded in a knowledge graph of the harness (the instructions, agents, prompts, skills, MCP servers, tools and hooks that make AI agents work in a repository).

Read it top to bottom:

```
● start condition     trigger (or prompt) —transitions_to→ first stage
▭ stage               state, performed_by an agent/actor (its lane); reads inputs, writes outputs
◇ gate                criteria that must hold to progress; pass ↓ / fail ↺
▭ next stage          usually a different agent — the gate is the hand-off
◉ end                 terminal state
```

Everything else (tools, MCP servers, artifacts, rules) hangs off stages and gates as relations.

## 2. Document shape

```json
{
  "schema": "discovery-graph/2",
  "meta": { "name": "acme", "root": ".", "generatedAt": "2026-09-28T00:00:00Z", "generator": "discovery-graph", "scannedFiles": [".github/copilot-instructions.md"] },
  "nodes": [ { "id": "agent:planner", "kind": "agent", "label": "planner", "origin": "scan", "confidence": "declared", "source": { "file": ".github/agents/planner.agent.md", "line": 1 } } ],
  "edges": [ { "from": "agent:planner", "to": "tool:search", "kind": "uses", "origin": "scan", "confidence": "declared" } ]
}
```

- **Node** — `id`, `kind`, `label`, `origin`, `confidence` required; `description`, `source`, `props` optional.
  - `state` only: `initial`, `terminal`, and `parent` (id of the enclosing stage when this state is a step of a sub-flow).
  - `gate` only: `criteria` (array of checkable statements) and `gateType` (see §5).
  - `trigger`: `props.explicit: true` when the repo states the start condition in words.
- `discovery-graph/1` documents are still accepted (read-compatible).
- **Edge** — `from`, `to`, `kind`, `origin`, `confidence` required; `label` (use it for transition conditions and hand-off names) and `source` optional.
- **Ids** are `<kind>:<slug>` with slug characters `a-z 0-9 . _ / * -`. The prefix must equal the node's kind. States use `state:<owner>/<workflow>/<nn>`.
- The JSON Schema is `schema/graph.schema.json` (`npx discovery-graph schema`). Endpoint rules (§4) are enforced by `validate`, not by the JSON Schema.

## 3. Node kinds

| kind | meaning |
|---|---|
| `instruction` | An instruction file: `copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `*.instructions.md`, Cursor rules. |
| `agent` | An agent, chat mode, sub-agent or persona that does work. |
| `prompt` | A reusable prompt or slash command — an entry point into a workflow. |
| `skill` | A packaged skill (`SKILL.md`). |
| `mcp_server` | An MCP server declared in `.vscode/mcp.json`, `.mcp.json` or `.cursor/mcp.json`. |
| `tool` | A callable tool: built-in (`edit`, `Read`, `Bash`) or MCP-provided (`server/tool`, `mcp__server__tool`). |
| `state` | A stage or step of a workflow, in the lane of whoever performs it. |
| `gate` | A guard between states: the criteria that must hold to progress. |
| `artifact` | A file, folder, glob, doc or dataset that is read or written. |
| `trigger` | A start condition: user request, issue opened, CI event, schedule, hook. |
| `actor` | A human role: user, reviewer, maintainer. |
| `rule` | A constraint or guard-rail stated in instructions. |

## 4. Edge kinds

Read every edge as a sentence: `from —kind→ to`.

| kind | sentence | from | to |
|---|---|---|---|
| `defines` | declares / introduces | instruction, agent, prompt, skill | any |
| `transitions_to` | is followed by (`pass` / `fail` / condition in `label`) | trigger, state, gate | state, gate |
| `performed_by` | is carried out / decided by | state, gate | agent, actor |
| `uses` | calls / loads | agent, state, gate, prompt, skill | tool, skill, mcp_server |
| `provides` | exposes the tool | mcp_server, skill | tool |
| `reads` | takes as **input** | agent, state, gate, prompt, skill, tool | artifact |
| `writes` | produces as **output** | agent, state, prompt, skill, tool | artifact |
| `delegates_to` | hands work off to | agent, state, prompt | agent |
| `invokes` | starts | prompt, trigger, actor, agent | agent, state, prompt, skill |
| `triggers` | fires / starts | trigger, actor, state | state, gate, agent, prompt |
| `constrains` | limits / governs | rule, instruction | any |
| `references` | mentions (weakest; prefer a specific kind) | any | any |

An edge whose endpoints break this table is a validation **error**.

## 5. Gates

| gateType | who decides | example |
|---|---|---|
| `human` | a person approves | plan approved, clicking a Copilot hand-off button |
| `automated` | a machine check | tests pass, lint clean, CI green |
| `agent` | an AI agent judges | reviewer agent finds no blocking issues |
| `implicit` | nobody — criteria not written down | agent A just hands over to agent B |

The scanner creates gates from: loop phrases ("if tests fail, go back to step 2" → `Tests fail?` with `yes` ↺ / `no` ↓), gate phrases ("only once the plan is approved", "must pass", "wait for"), Copilot `handoffs` (a `human` gate: the user clicks the hand-off), and every transition between stages of different agents (an `implicit` gate whose criteria are inferred from what the first stage writes and the next reads).

## 6. Origin and confidence

| origin | meaning | on re-scan |
|---|---|---|
| `scan` | found by the deterministic scanner | replaced |
| `agent` | added or overridden by an AI agent | **kept** |
| `human` | added or overridden by a person | **kept** |

A non-`scan` node with the same id as a scan node overrides it. A kept edge whose endpoint disappears is dropped and reported.

| confidence | use when |
|---|---|
| `declared` | the repo states it explicitly (frontmatter, config, an explicit sentence) |
| `inferred` | derived from prose by a heuristic or a reader |
| `speculative` | a hypothesis — say why in `description` |

## 7. What the scanner reads

| file | becomes |
|---|---|
| `.github/copilot-instructions.md`, `*.instructions.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*` | `instruction` (+ `applyTo` globs → `constrains` → `artifact`) |
| `*.agent.md`, `*.chatmode.md`, `.claude/agents/*.md` | `agent` (+ `tools` → `uses`, `handoffs` → `delegates_to`) |
| `*.prompt.md`, `.claude/commands/*.md` | `prompt` (+ `agent`/`mode` → `invokes`, `tools` → `uses`) |
| `SKILL.md` | `skill` (+ `allowed-tools` → `uses`) |
| `.vscode/mcp.json`, `.mcp.json`, `.cursor/mcp.json` | `mcp_server` |
| `.claude/settings.json` hooks | `trigger` |

Folders named `fixtures`, `__fixtures__`, `testdata`, `node_modules`, `dist` … are skipped: example harnesses in tests are not the repo's harness.

Body heuristics (all `inferred`): a heading like *Workflow / Process / Steps / Pipeline* with an ordered list → a `trigger` (start condition from a "When …" sentence), `state`s, `gate`s and `transitions_to`; *Agents / Tools / MCP servers / Skills / Artifacts* sections with `**name**: …` bullets → nodes; *Rules* sections and bullets starting with NEVER / ALWAYS / MUST → `rule`s; `` `path/file.ext` `` → `artifact` with `reads` / `writes` from the nearest verb; `@agent`, `` `tool` ``, `mcp__server__tool`, `#tool:x` → relations; local markdown links → `references`.

## 8. Lint rules

| rule | severity | why |
|---|---|---|
| `schema` | error | The graph must validate first. |
| `orphan` | warn | No edges: noise or a missing relation. |
| `unused-mcp-server` | warn | Configured server nobody uses. |
| `undeclared-mcp-server` | warn | Referenced server missing from MCP config. |
| `unused-tool` | info | Provided but never used. |
| `broad-tool-grant` | info | Agent granted a whole server (`server/*`). |
| `state-dead-end` | warn | Non-terminal state with no way forward. |
| `state-unreachable` | warn | Non-initial state nothing transitions into. |
| `no-start-condition` | warn | No trigger or prompt leads into the workflow. |
| `start-condition-implicit` | info | The workflow's start condition is not written down. |
| `implicit-gate` | warn | Agents hand off without stated exit criteria. |
| `gate-no-criteria` | warn | A gate nobody can check. |
| `gate-dead-end` | warn | A gate with no way out. |
| `gate-no-fail-path` | info | What happens when the check fails? |
| `gate-no-evaluator` | info | Nobody recorded as deciding the gate. |
| `state-no-actor` | info | Nobody performs the state. |
| `artifact-contention` | warn | Written by more than one agent. |
| `artifact-dead-output` | info | Written, never read. |
| `artifact-external-input` | info | Read, never produced in the harness. |
| `agent-no-tools` | info | Agent with no tools. |
| `agent-no-entry` | info | Nothing invokes / delegates to / assigns the agent. |
| `delegation-cycle` | warn | Agents can hand off in a loop. |
| `rule-unanchored` | info | Rule constrains nothing specific. |
| `low-evidence` | info | Node without a `source`. |

## 9. Done checklist (for an enriching agent)

- `validate` passes.
- Every workflow starts from a `trigger` (or prompt) that says when it runs.
- Every hand-off between agents goes through a `gate` with `criteria`, a `gateType`, an evaluator and a `fail` path.
- Every workflow has an `initial` state and every non-looping end is `terminal`.
- Every state has `performed_by`, and its inputs/outputs as `reads` / `writes`.
- Every rule `constrains` something.
- Every added item has `origin: "agent"` and a `source`.
- Remaining lint warnings are explained in `REVIEW.md` as real harness findings.
