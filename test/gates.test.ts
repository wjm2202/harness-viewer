import { describe, expect, it } from "vitest";
import { asQuestion, classifyGate, detectGate, detectLoop, startCondition } from "../src/scan/gates.js";

describe("detectLoop", () => {
  it.each([
    ["Run the tests; if tests fail, go back to step 2.", "tests fail", 1],
    ["If they fail, return to step 2", "they fail", 1],
    ["Review. When changes are requested, jump to step 3", "changes are requested", 2],
    ["Otherwise, restart from step 1", "", 0],
    ["Until CI is green, loop back to step #4", "", -1],
  ])("%s", (text, condition, target) => {
    const hit = detectLoop(text);
    if (target < 0) return expect(hit).toBeNull();
    expect(hit).not.toBeNull();
    expect(hit!.target).toBe(target);
    if (condition) expect(hit!.condition).toBe(condition);
    else expect(hit!.condition).toBeTruthy();
  });
  it("ignores plain steps", () => {
    expect(detectLoop("Write the plan to docs/PLAN.md.")).toBeNull();
    expect(detectLoop("See step 2 for details")).toBeNull();
  });
});

describe("detectGate", () => {
  it("finds entry gates at the start of a step", () => {
    expect(detectGate("Only once the plan is approved, implement it.")).toEqual({ clause: "Only once the plan is approved", before: true });
    expect(detectGate("Wait for CI to finish, then merge")).toMatchObject({ before: true });
  });
  it("finds exit gates later in a step", () => {
    const hit = detectGate("Write code; CI must pass before moving on.");
    expect(hit).toMatchObject({ before: false });
    expect(hit!.clause).toMatch(/^CI must pass before moving on/);
  });
  it("covers the common phrasings", () => {
    for (const t of ["The PR gets approved by a maintainer.", "Needs sign-off from QA.", "Do not proceed until the reviewer agrees.", "Tests must be green.", "Keep going until done"]) expect(detectGate(t), t).not.toBeNull();
  });
  it("does not fire on ordinary steps", () => {
    for (const t of ["Write the plan.", "Run the linter once.", "After writing, commit."]) expect(detectGate(t), t).toBeNull();
  });
  it("truncates very long clauses", () => {
    expect(detectGate("Only after " + "x ".repeat(100))!.clause.length).toBeLessThanOrEqual(118);
  });
});

describe("classifyGate", () => {
  it.each([
    ["the plan is approved", "human"],
    ["user confirms", "human"],
    ["maintainer sign-off", "human"],
    ["tests fail", "automated"],
    ["Run runTests. If they fail", "automated"],
    ["CI is green", "automated"],
    ["lint clean", "automated"],
    ["the reviewer is satisfied", "agent"],
  ])("%s → %s", (t, type) => expect(classifyGate(t)).toBe(type));
});

describe("startCondition", () => {
  it("reads trigger-like intros", () => {
    expect(startCondition("When a new issue is labelled `agent`, the planner starts.")).toBe("When a new issue is labelled agent");
    expect(startCondition("On every push to main:")).toBe("On every push to main");
    expect(startCondition("Whenever the user asks for a feature")).toBe("Whenever the user asks for a feature");
  });
  it("returns null for non-trigger prose", () => {
    expect(startCondition("This section describes our flow.")).toBeNull();
  });
});

describe("asQuestion", () => {
  it("capitalises and adds a question mark, trimming punctuation", () => {
    expect(asQuestion("tests fail.")).toBe("Tests fail?");
    expect(asQuestion("x".repeat(100)).length).toBeLessThanOrEqual(61);
  });
});
