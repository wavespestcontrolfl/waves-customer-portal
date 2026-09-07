---
description: Read recent Codex review findings and propose at most five focused instruction or regression-check diffs in the response; create a rules PR only when authorized
argument-hint: optional --days N (default 14), --repo owner/name
---

Skills improve when someone reads what the reviewer keeps saying. This is the
proposing half of the loop; `ops/agents/skill-doctor.js` is the evidence half.

Arguments: $ARGUMENTS

## 1. Evidence (READ-ONLY, no LLM, only `gh` as the operator)

```sh
node ops/agents/skill-doctor.js --days 14
```

The report has three sections, in priority order:

1. **Cited rules that keep being broken** — findings that cite an AGENTS.md
   rule, grouped by the rule's title AT THE COMMIT EACH FINDING REVIEWED
   (AGENTS.md is restructured often, even between rounds of one PR; local
   line numbers lie). The label is the rule as it read THEN — find its
   current wording in AGENTS.md before sharpening anything. A rule that exists and is
   broken across many PRs wants a sharper wording, a `file:line` it
   protects, or a scanner in `check:domain-rules` — never a duplicate.
2. **Recurring finding classes with no cited rule** — the same finding
   phrase across two or more PRs. This is a rule the repo is missing.
3. **Files that keep drawing findings** — a module that wants a contract
   test more than it wants prose.

Each cluster carries a candidate home chosen by `lesson.md`'s placement
rules (check → AGENTS.md → public-route-contracts → matching skill →
CLAUDE.md) and whether the home already carries the cluster's key terms.

## 2. Propose (at most five diffs per run)

Work the top clusters in order. For each one, before writing anything:

- Read the candidate home end to end and find the rule that already covers
  the class. If it exists, SHARPEN it in place — add the failure it
  prevents, the `file:line` it protects, or the check that enforces it. If
  the class can be a test / scanner / contract rule, write THAT and leave a
  one-line pointer (lesson.md option 1 beats prose).
- Write the rule the way lesson.md says: one behavior to follow, the
  failure it prevents, concrete enough to act on, no round narration, no
  dates, no counts. Match the file's tone and severity scheme.
- AGENTS.md has a 30 KB budget — run `npm run check:domain-rules` after
  every AGENTS.md edit and cut narration from the class you are extending
  rather than dropping a rule.
- Never edit application code or CLAUDE.md rules in this lane. What this
  lane MAY ship: skill files, AGENTS.md, docs/public-route-contracts.md,
  scanner rules (`check:domain-rules`, the route-surface allowlist), and a
  NEW contract test that pins a recurring class (a test that only reads —
  never one that changes application behaviour or edits an existing
  behavioural test).

The default result is a proposal in the response, with at most five exact
diffs and their evidence. Section 3 applies only when creating a rules PR
is authorized. Invocation for an audit or proposal does not authorize
files, commits, PRs, review tags, or scheduling.

## 3. Ship as a rules-only PR when authorized — never merge

Follow waves-ship §1–§4: worktree off `origin/main`, branch
`docs/skill-doctor-<YYYY-MM-DD>`, commit from a message file, title
`docs(skills): skill-doctor <YYYY-MM-DD>` — or `test(contracts): skill-doctor
<YYYY-MM-DD>` when the PR carries a contract test, so the title says what
CI now enforces. The PR body lists every proposed
rule with the cluster it came from (PR numbers + finding links from the
report) so the reviewer sees the evidence, not the argument. Tag `@codex`,
run `scripts/verify-pr-checks.sh`, work the rounds under the severity gate.
Stop at MERGE-READY — merging a rule change is Adam's call, every time.

## Invocation

Run manually after a relevant repeated failure or when instruction
maintenance is requested. The existing skill-doctor.js is the evidence
collector. This command does not create a schedule. Any future scheduled
run needs a separately reviewed owner, scope, permissions, timeout,
duplicate-run guard, failure notification, and disable mechanism.
