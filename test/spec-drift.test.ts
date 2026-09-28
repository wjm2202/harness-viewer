import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LINT_RULES } from "../src/lint.js";
import { CONFIDENCES, EDGE_KINDS, EDGE_RULES, GATE_TYPES, NODE_KINDS, ORIGINS } from "../src/schema.js";

const SPEC = readFileSync(resolve(__dirname, "../docs/GRAPH-SPEC.md"), "utf8");
const README = readFileSync(resolve(__dirname, "../README.md"), "utf8");

/** Rows of a markdown table whose first cell is a backticked name. */
function tableRows(md: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of md.split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/);
    if (m) rows.set(m[1], m[2].split("|").map((c) => c.trim()));
  }
  return rows;
}

describe("docs/GRAPH-SPEC.md stays in sync with the code", () => {
  const rows = tableRows(SPEC);

  it("documents every node kind, edge kind, origin and confidence", () => {
    for (const k of [...NODE_KINDS, ...EDGE_KINDS, ...ORIGINS, ...CONFIDENCES, ...GATE_TYPES]) expect(rows.has(k), `missing \`${k}\``).toBe(true);
  });

  it("documents edge endpoint rules exactly as enforced", () => {
    for (const k of EDGE_KINDS) {
      const [, from, to] = rows.get(k)!;
      const fmt = (x: readonly string[] | "*") => (x === "*" ? "any" : x.join(", "));
      expect(from, `${k} from`).toBe(fmt(EDGE_RULES[k].from));
      expect(to, `${k} to`).toBe(fmt(EDGE_RULES[k].to));
    }
  });

  it("documents every lint rule with its real severity", () => {
    for (const [rule, { severity }] of Object.entries(LINT_RULES)) {
      expect(rows.has(rule), `missing lint rule \`${rule}\``).toBe(true);
      expect(rows.get(rule)![0], `${rule} severity`).toBe(severity);
    }
  });
});

describe("README", () => {
  it("mentions every CLI command", () => {
    for (const c of ["scan", "brief", "validate", "lint", "view", "schema"]) expect(README).toContain(`discovery-graph ${c}`);
  });
});
