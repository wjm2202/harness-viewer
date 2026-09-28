/** Parsed reference to a tool, as written in frontmatter or text. */
export interface ToolRef {
  /** MCP server name, if the reference names one. */
  server?: string;
  /** Tool name; undefined means "all tools of the server" (`server/*`). */
  tool?: string;
  /** Original text. */
  raw: string;
}

/**
 * Understands the common spellings:
 *   `edit`, `Read`, `Bash(git:*)`           → built-in tool
 *   `github/*`, `github/create_issue`       → Copilot MCP style
 *   `mcp__github__create_issue`             → Claude MCP style
 *   `github.create_issue`                   → dotted style
 */
export function parseToolRef(raw: string): ToolRef | null {
  const s = raw.trim().replace(/^['"`]|['"`]$/g, "").replace(/\(.*\)$/, "").trim();
  if (!s || s === "*") return null;
  let m = s.match(/^mcp__([^_](?:[^_]|_(?!_))*)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] === "*" ? undefined : m[2], raw };
  m = s.match(/^([\w.-]+)\/([\w.*-]+)$/);
  if (m) return { server: m[1], tool: m[2] === "*" ? undefined : m[2], raw };
  m = s.match(/^([a-z][\w-]*)\.([\w-]+)$/);
  if (m) return { server: m[1], tool: m[2], raw };
  if (/^[\w-]+$/.test(s)) return { tool: s, raw };
  return null;
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
export function parseJsonc(src: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
