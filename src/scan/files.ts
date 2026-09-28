import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

export type FileRole =
  | "instruction"
  | "agent"
  | "prompt"
  | "skill"
  | "mcp_config"
  | "hooks_config";

export interface HarnessFile {
  /** Repo-relative, forward slashes. */
  rel: string;
  abs: string;
  role: FileRole;
  /** Which ecosystem the convention comes from. */
  flavor: "copilot" | "claude" | "cursor" | "generic";
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".venv", "venv",
  "__pycache__", ".next", ".nuxt", "target", ".turbo", ".cache", ".discovery-graph",
  // test data: example harnesses inside a repo's tests are not the repo's harness
  "fixtures", "__fixtures__", "testdata", "__snapshots__",
]);

/** Map a repo-relative path to its harness role, or null if it is not a harness file. */
export function classify(rel: string): Omit<HarnessFile, "abs" | "rel"> | null {
  const p = rel.replace(/\\/g, "/");
  const lower = p.toLowerCase();
  const base = basename(lower);

  if (base === "copilot-instructions.md") return { role: "instruction", flavor: "copilot" };
  if (base.endsWith(".instructions.md")) return { role: "instruction", flavor: "copilot" };
  if (base.endsWith(".agent.md") || base.endsWith(".chatmode.md")) return { role: "agent", flavor: "copilot" };
  if (base.endsWith(".prompt.md")) return { role: "prompt", flavor: "copilot" };
  if (/(^|\/)\.claude\/agents\/.+\.md$/.test(lower)) return { role: "agent", flavor: "claude" };
  if (/(^|\/)\.claude\/commands\/.+\.md$/.test(lower)) return { role: "prompt", flavor: "claude" };
  if (base === "skill.md") return { role: "skill", flavor: lower.includes(".claude/") ? "claude" : "generic" };
  if (base === "agents.md") return { role: "instruction", flavor: "generic" };
  if (base === "claude.md") return { role: "instruction", flavor: "claude" };
  if (base === "gemini.md") return { role: "instruction", flavor: "generic" };
  if (base === ".cursorrules" || base === ".windsurfrules") return { role: "instruction", flavor: "cursor" };
  if (/(^|\/)\.cursor\/rules\/.+\.mdc?$/.test(lower)) return { role: "instruction", flavor: "cursor" };
  if (lower === ".vscode/mcp.json") return { role: "mcp_config", flavor: "copilot" };
  if (lower === ".mcp.json" || lower === "mcp.json") return { role: "mcp_config", flavor: "claude" };
  if (lower === ".cursor/mcp.json") return { role: "mcp_config", flavor: "cursor" };
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(lower)) return { role: "hooks_config", flavor: "claude" };
  return null;
}

/** Walk the repo (bounded) and return every harness file, sorted by path. */
export function findHarnessFiles(root: string, maxDepth = 8, maxEntries = 20_000): HarnessFile[] {
  const out: HarnessFile[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (++seen > maxEntries) return;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(abs, depth + 1);
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      const c = classify(rel);
      if (c) out.push({ rel, abs, ...c });
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}
