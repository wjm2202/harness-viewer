import type { GateType } from "../schema.js";
import { stripInline } from "./markdown.js";

/**
 * Pure text heuristics that turn workflow prose into state-machine structure:
 * loops ("if tests fail, go back to step 2"), gates ("only once the plan is
 * approved"), and start conditions ("When an issue is labelled `agent`…").
 * Everything here is deterministic and unit-tested in isolation.
 */

export interface LoopHit {
  /** The condition, e.g. "tests fail". */
  condition: string;
  /** 0-based index of the step to go back/jump to. */
  target: number;
  /** The whole matched clause, for criteria/provenance. */
  clause: string;
}

const LOOP_RE =
  /\b(?:if|when|while|unless|on failure|otherwise|else)\b\s*([^.;]*?)\s*,?\s*(?:then\s+)?(?:go(?:ing)? back to|return to|repeat(?: from)?|back to|restart (?:at|from)|jump to|continue (?:at|from)|loop back to)\s*(?:step\s*)?#?(\d+)/i;

/** "if tests fail, go back to step 2" → { condition: "tests fail", target: 1 } */
export function detectLoop(text: string): LoopHit | null {
  const m = stripInline(text).match(LOOP_RE);
  if (!m) return null;
  const condition = m[1].replace(/^(they|it)\s+/i, (x) => x).trim() || "condition not met";
  return { condition, target: Number(m[2]) - 1, clause: m[0].trim() };
}

const GATE_RE =
  /\b(only (?:after|when|once|if)|once (?:the|all|it|they|every|tests?|ci|checks?|review|approved)|until|must (?:pass|succeed|be (?:approved|reviewed|green|signed off|merged))|(?:is|are|been|gets?|get) approved|approval|sign[- ]?off|wait (?:for|until)|before (?:moving on|proceeding|continuing|merging|handing off|opening)|do not (?:proceed|continue|merge|move on|open)|gated? (?:by|on))\b/i;

export interface GateHit {
  /** Short clause describing what must hold. */
  clause: string;
  /** true when the gate guards ENTRY to the step ("Once X, do Y"), false when it guards EXIT. */
  before: boolean;
}

/** Find a gate phrase in a step. Returns the clause around it and whether it guards entry or exit. */
export function detectGate(text: string): GateHit | null {
  const t = stripInline(text);
  const m = t.match(GATE_RE);
  if (!m || m.index === undefined) return null;
  // Clause = from the start of the sentence/clause containing the phrase to the next , ; . —
  const startCut = Math.max(t.lastIndexOf(". ", m.index), t.lastIndexOf("; ", m.index));
  const from = startCut >= 0 ? startCut + 2 : 0;
  const rest = t.slice(m.index);
  const endRel = rest.search(/[,;.](\s|$)|\s[—–]\s/);
  const clause = t.slice(from, endRel >= 0 ? m.index + endRel : t.length).trim();
  const before = m.index - from < 12 && from === 0;
  return { clause: clause.length > 120 ? clause.slice(0, 117) + "…" : clause, before };
}

/** Who decides a gate, from its wording. */
export function classifyGate(text: string): GateType {
  if (/\b(approv\w*|sign[- ]?off|human|user|maintainer|owner|manual(ly)?|confirm\w*|clicks?)\b/i.test(text)) return "human";
  if (/\b\w*(tests?|lint\w*)\b|\b(build|ci|checks?|green|compil\w*|type-?check\w*|coverage|pipeline|workflow run)\b/i.test(text)) return "automated";
  return "agent";
}

const WHEN_RE = /^(when|whenever|on|upon|if|given|after|every|each time|triggered|start(?:s|ing)? (?:when|with|from))\b/i;

/**
 * The start condition of a workflow, from the sentence that introduces it:
 * "When a new issue is labelled `agent`, …" → "When a new issue is labelled agent".
 * Returns null if the intro does not read like a trigger.
 */
export function startCondition(intro: string): string | null {
  const t = stripInline(intro);
  if (!WHEN_RE.test(t)) return null;
  const cut = t.search(/[,:.;](\s|$)/);
  const s = (cut > 0 ? t.slice(0, cut) : t).trim();
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
}

/** "tests fail" → "tests fail?" (a gate is drawn as a question). */
export function asQuestion(s: string): string {
  const t = s.replace(/[.?!\s]+$/, "");
  const q = t.charAt(0).toUpperCase() + t.slice(1) + "?";
  return q.length > 60 ? q.slice(0, 58) + "…?" : q;
}
