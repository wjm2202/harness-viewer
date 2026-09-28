import { describe, expect, it } from "vitest";
import { parseJsonc, parseToolRef } from "../src/scan/tools.js";

describe("parseToolRef", () => {
  it.each([
    ["edit", { tool: "edit" }],
    ["Bash(git:*)", { tool: "Bash" }],
    ["'search'", { tool: "search" }],
    ["github/*", { server: "github", tool: undefined }],
    ["github/create_issue", { server: "github", tool: "create_issue" }],
    ["mcp__github__create_issue", { server: "github", tool: "create_issue" }],
    ["mcp__my_server__do_thing", { server: "my_server", tool: "do_thing" }],
    ["mcp__github__*", { server: "github", tool: undefined }],
    ["memory.search", { server: "memory", tool: "search" }],
  ])("%s", (raw, expected) => {
    expect(parseToolRef(raw)).toMatchObject(expected);
  });
  it("rejects junk", () => {
    for (const raw of ["", "*", "two words", "a/b/c"]) expect(parseToolRef(raw)).toBeNull();
  });
});

describe("parseJsonc", () => {
  it("strips line and block comments and trailing commas", () => {
    expect(parseJsonc('{\n // c\n "a": 1, /* b */ "b": [1,2,],\n}')).toEqual({ a: 1, b: [1, 2] });
  });
  it("does not touch comment-like text inside strings", () => {
    expect(parseJsonc('{"url":"https://x.y/z","s":"a /* b */ \\" c"}')).toEqual({ url: "https://x.y/z", s: 'a /* b */ " c' });
  });
  it("throws on invalid JSON", () => expect(() => parseJsonc("{")).toThrow());
});
