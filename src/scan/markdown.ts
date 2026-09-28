import { parse as parseYaml } from "yaml";

export interface MdLine {
  text: string;
  /** 1-based line number in the original file. */
  line: number;
}

export interface MdHeading {
  level: number;
  text: string;
  line: number;
}

export interface MdSection {
  heading: MdHeading | null;
  /** Lines under the heading up to the next heading of the same or higher level (code fences removed). */
  lines: MdLine[];
}

export interface ParsedMd {
  frontmatter: Record<string, unknown>;
  /** Body lines (outside frontmatter and code fences). */
  lines: MdLine[];
  headings: MdHeading[];
}

/** Parse markdown into frontmatter + body lines, skipping fenced code. */
export function parseMarkdown(src: string): ParsedMd {
  const raw = src.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  let frontmatter: Record<string, unknown> = {};
  if (raw[0]?.trim() === "---") {
    const end = raw.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) {
      try {
        const fm = parseYaml(raw.slice(1, end).join("\n"));
        if (fm && typeof fm === "object" && !Array.isArray(fm)) frontmatter = fm as Record<string, unknown>;
      } catch {
        // Bad YAML frontmatter is common in hand-written files; treat as absent.
      }
      start = end + 1;
    }
  }
  const lines: MdLine[] = [];
  const headings: MdHeading[] = [];
  let fence: string | null = null;
  for (let i = start; i < raw.length; i++) {
    const text = raw[i];
    const f = text.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const line = i + 1;
    const h = text.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ level: h[1].length, text: stripInline(h[2]), line });
    lines.push({ text, line });
  }
  return { frontmatter, lines, headings };
}

/** Split into sections keyed by heading (a section includes its sub-headings' lines). */
export function sections(md: ParsedMd): MdSection[] {
  const out: MdSection[] = [];
  for (const h of md.headings) {
    const next = md.headings.find((o) => o.line > h.line && o.level <= h.level);
    out.push({
      heading: h,
      lines: md.lines.filter((l) => l.line > h.line && (!next || l.line < next.line)),
    });
  }
  return out;
}

/** Remove markdown emphasis/code/link syntax, collapse whitespace. */
export function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, "$1$2")
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ListItem {
  text: string;
  line: number;
  ordered: boolean;
  indent: number;
}

/**
 * Top-level list items in a block of lines. Nested items and indented
 * continuation lines are folded into their parent's text. Stops at the first
 * heading so a section's own list is not mixed with its sub-sections'.
 */
export function listItems(lines: MdLine[], stopAtHeading = true): ListItem[] {
  const raw: ListItem[] = [];
  for (const l of lines) {
    if (stopAtHeading && /^#{1,6}\s/.test(l.text)) break;
    const m = l.text.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (m) {
      raw.push({ text: m[4], line: l.line, ordered: !m[2], indent: m[1].replace(/\t/g, "    ").length });
    } else if (raw.length && /^\s+\S/.test(l.text)) {
      raw[raw.length - 1].text += " " + l.text.trim();
    }
  }
  if (!raw.length) return [];
  const minIndent = Math.min(...raw.map((r) => r.indent));
  const items: ListItem[] = [];
  for (const r of raw) {
    if (r.indent === minIndent) items.push({ ...r });
    else if (items.length) items[items.length - 1].text += " " + r.text;
  }
  return items;
}

/** Normalise a frontmatter `tools` value (array, comma string, or object) to a string list. */
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? [x] : typeof x === "object" && x && "name" in x ? [String((x as { name: unknown }).name)] : []));
  if (typeof v === "string") return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  if (v && typeof v === "object") return Object.keys(v);
  return [];
}
