import { describe, expect, it } from "vitest";
import { listItems, parseMarkdown, sections, stripInline, toList } from "../src/scan/markdown.js";

describe("parseMarkdown", () => {
  it("parses YAML frontmatter and keeps original line numbers", () => {
    const md = parseMarkdown("---\ntools: [a, b]\n---\n# Title\ntext");
    expect(md.frontmatter).toEqual({ tools: ["a", "b"] });
    expect(md.headings).toEqual([{ level: 1, text: "Title", line: 4 }]);
    expect(md.lines.map((l) => l.line)).toEqual([4, 5]);
  });
  it("tolerates broken frontmatter", () => {
    const md = parseMarkdown("---\ntools: [a\n---\nbody");
    expect(md.frontmatter).toEqual({});
    expect(md.lines[0].text).toBe("body");
  });
  it("treats an unclosed frontmatter fence as body", () => {
    expect(parseMarkdown("---\nno end").lines).toHaveLength(2);
  });
  it("skips fenced code blocks (``` and ~~~)", () => {
    const md = parseMarkdown("a\n```md\n# not a heading\n```\nb\n~~~\n- x\n~~~\nc");
    expect(md.headings).toEqual([]);
    expect(md.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });
  it("handles CRLF", () => {
    expect(parseMarkdown("# A\r\nb").headings[0].text).toBe("A");
  });
});

describe("sections", () => {
  it("includes sub-sections and stops at a same-level heading", () => {
    const md = parseMarkdown("# A\n1\n## B\n2\n# C\n3");
    const s = sections(md);
    expect(s.map((x) => x.heading!.text)).toEqual(["A", "B", "C"]);
    expect(s[0].lines.map((l) => l.text)).toEqual(["1", "## B", "2"]);
    expect(s[1].lines.map((l) => l.text)).toEqual(["2"]);
  });
});

describe("listItems", () => {
  it("returns top-level items and folds nested items / continuations into the parent", () => {
    const md = parseMarkdown("1. one\n   more\n   - nested `x.md`\n2) two\n");
    const items = listItems(md.lines);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ ordered: true, line: 1 });
    expect(items[0].text).toBe("one more nested `x.md`");
    expect(items[1].text).toBe("two");
  });
  it("stops at a heading unless told otherwise", () => {
    const md = parseMarkdown("- a\n## H\n- b");
    expect(listItems(md.lines)).toHaveLength(1);
    expect(listItems(md.lines, false)).toHaveLength(2);
  });
  it("marks bullets as unordered", () => {
    expect(listItems(parseMarkdown("* x\n+ y").lines).every((i) => !i.ordered)).toBe(true);
  });
  it("returns [] for no lists", () => expect(listItems(parseMarkdown("plain").lines)).toEqual([]));
});

describe("stripInline", () => {
  it("removes emphasis, code and links but keeps identifiers with underscores", () => {
    expect(stripInline("**Bold** and `github/create_pull_request` via [docs](x.md)")).toBe("Bold and github/create_pull_request via docs");
    expect(stripInline("_em_ and *em* and __strong__")).toBe("em and em and strong");
    expect(stripInline("snake_case_name stays")).toBe("snake_case_name stays");
    expect(stripInline("![img](a.png) x")).toBe("x");
  });
});

describe("toList", () => {
  it("normalises arrays, comma strings, objects", () => {
    expect(toList(["a", 1, { name: "b" }])).toEqual(["a", "b"]);
    expect(toList("Read, Bash(git:*)\nEdit")).toEqual(["Read", "Bash(git:*)", "Edit"]);
    expect(toList({ x: true, y: false })).toEqual(["x", "y"]);
    expect(toList(undefined)).toEqual([]);
  });
});
