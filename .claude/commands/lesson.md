---
description: Record a correction as a permanent rule so the same mistake never happens again
argument-hint: what went wrong, and (optionally) what the rule should be
---

A mistake was just caught. Turn it into a permanent rule so no future session
— Claude or Codex — repeats it.

What happened: $ARGUMENTS

(If the arguments are thin, reconstruct the mistake from the recent
conversation: what was done wrong, what the correction was.)

## Where the rule lives — pick exactly one

1. **`AGENTS.md`** — if the lesson is a *code-review rule*: something a
   reviewer should flag when it appears in a diff (a dangerous pattern, a
   file that must not change a certain way, a security invariant). Add it
   under the correct severity (P0 / P1 / out-of-scope) and cite the
   `file:line` it protects, matching the existing entries. Rules here are
   enforced by both Codex (pre-push hook + @codex bot) and Claude reviews.
2. **The matching skill in `.claude/skills/*/SKILL.md`** — if the lesson is
   *procedural* and belongs to a domain a skill already covers (billing,
   DB/SQL, LLM call sites, shipping/PRs, content, pricing, UI verification,
   IB write tools). Add it to the relevant section (usually Procedure or
   Failure Modes) in that file's style.
3. **`CLAUDE.md`** — last resort, only for a rule that is global, small, and
   relevant to nearly every session. CLAUDE.md loads into every session's
   context; keep it lean. Prefer options 1–2.

## How to write it

- One rule, stated as the behavior to follow — not a story about the mistake.
- Concrete enough to act on: name the file, command, or pattern involved.
- Match the destination file's existing tone, format, and severity scheme.
- Check the destination first — if an existing rule already covers this,
  sharpen that rule instead of adding a duplicate.

## Ship it with the fix

Commit the rule on the SAME branch/PR as the fix for the mistake, so the
correction and the lesson land together. If there is no associated fix,
commit it on its own with a message explaining what incident it encodes.
