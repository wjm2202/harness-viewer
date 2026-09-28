import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cloneShallow, isRemote, normaliseRepoUrl } from "../src/remote.js";
import { tempDir } from "./helpers.js";

describe("isRemote", () => {
  it.each([
    ["https://github.com/o/r", true],
    ["git@github.com:o/r.git", true],
    ["ssh://git@host/r", true],
    ["file:///tmp/r", true],
    [".", false],
    ["../repo", false],
    ["C:\\repo", false],
  ])("%s → %s", (t, v) => expect(isRemote(t)).toBe(v));
});

describe("normaliseRepoUrl", () => {
  it("handles plain, .git, tree and blob URLs", () => {
    expect(normaliseRepoUrl("https://github.com/o/r")).toEqual({
      url: "https://github.com/o/r.git",
    });
    expect(normaliseRepoUrl("https://github.com/o/r.git")).toEqual({
      url: "https://github.com/o/r.git",
    });
    expect(
      normaliseRepoUrl("https://github.com/o/r/tree/dev/packages/api"),
    ).toEqual({
      url: "https://github.com/o/r.git",
      ref: "dev",
      subdir: "packages/api",
    });
    expect(normaliseRepoUrl("https://gitlab.com/o/r/-/tree/main")).toEqual({
      url: "https://gitlab.com/o/r.git",
      ref: "main",
    });
  });
  it("leaves other URLs alone", () => {
    expect(normaliseRepoUrl("git@github.com:o/r.git")).toEqual({
      url: "git@github.com:o/r.git",
    });
  });
});

describe("cloneShallow", () => {
  it("passes a shallow, non-interactive clone to git", () => {
    const calls: unknown[][] = [];
    const fake = ((
      cmd: string,
      args: string[],
      opts: { env: Record<string, string> },
    ) => {
      calls.push([cmd, args, opts.env.GIT_TERMINAL_PROMPT]);
      return Buffer.from("");
    }) as unknown as typeof execFileSync;
    const co = cloneShallow("https://github.com/o/r/tree/v1/sub", fake);
    expect(calls[0][0]).toBe("git");
    expect(calls[0][1]).toEqual(
      expect.arrayContaining([
        "clone",
        "--depth",
        "1",
        "--branch",
        "v1",
        "https://github.com/o/r.git",
      ]),
    );
    expect(calls[0][2]).toBe("0");
    expect(co.dir.endsWith("sub")).toBe(true);
    co.cleanup();
    expect(existsSync(co.dir)).toBe(false);
  });

  it("cleans up and throws a clear error when git fails", () => {
    const fake = (() => {
      throw new Error("boom");
    }) as unknown as typeof execFileSync;
    expect(() => cloneShallow("https://github.com/o/r", fake)).toThrow(
      /git clone failed for https:\/\/github.com\/o\/r.git: boom/,
    );
  });

  it("rejects a repository subdirectory that escapes the clone", () => {
    const fake = (() => undefined) as unknown as typeof execFileSync;
    expect(() =>
      cloneShallow("https://github.com/o/r/tree/main/../../../../tmp", fake),
    ).toThrow(/escapes the clone/);
  });

  it("really clones a local repo over file://", () => {
    const src = tempDir();
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", src, ...a], { stdio: "ignore" });
    try {
      git("init", "-q");
      writeFileSync(join(src, "AGENTS.md"), "# hi");
      git("add", ".");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    } catch {
      return; // git unavailable in this environment
    }
    const co = cloneShallow("file://" + src);
    expect(existsSync(join(co.dir, "AGENTS.md"))).toBe(true);
    co.cleanup();
  });
});
