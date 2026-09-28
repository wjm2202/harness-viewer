import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

/** True for things `git clone` understands: https://…, git@host:…, ssh://…, file://… */
export function isRemote(target: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(target);
}

/**
 * Turn a GitHub "browse" URL into a clonable one:
 *   https://github.com/o/r/tree/main/sub → { url: https://github.com/o/r.git, ref: main, subdir: sub }
 */
export function normaliseRepoUrl(url: string): {
  url: string;
  ref?: string;
  subdir?: string;
} {
  const m = url.match(
    /^(https?:\/\/(?:github\.com|gitlab\.com)\/[^/]+\/[^/#?]+?)(?:\.git)?(?:\/(?:-\/)?(?:tree|blob)\/([^/]+)(?:\/(.+))?)?\/?$/,
  );
  if (!m) return { url };
  return {
    url: m[1] + ".git",
    ...(m[2] ? { ref: m[2] } : {}),
    ...(m[3] ? { subdir: m[3] } : {}),
  };
}

export interface Checkout {
  dir: string;
  cleanup: () => void;
}

/**
 * Shallow-clone a repo into a temp dir. Read-only: nothing in the clone is
 * executed — we only read markdown/JSON. Requires `git` on PATH.
 */
export function cloneShallow(
  target: string,
  run: typeof execFileSync = execFileSync,
): Checkout {
  const { url, ref, subdir } = normaliseRepoUrl(target);
  const base = mkdtempSync(join(tmpdir(), "discovery-graph-"));
  const args = [
    "clone",
    "--depth",
    "1",
    "--quiet",
    ...(ref ? ["--branch", ref] : []),
    url,
    base,
  ];
  try {
    run("git", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw new Error(`git clone failed for ${url}: ${(e as Error).message}`);
  }
  const dir = subdir ? join(base, subdir) : base;
  if (subdir) {
    const rel = relative(base, dir);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      rmSync(base, { recursive: true, force: true });
      throw new Error(`repository subdirectory escapes the clone: ${subdir}`);
    }
  }
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
