---
name: waves-test-audit
description: Audit Waves portal tests for redundant or brittle coverage. Use when assessing test value, consolidating tests, or planning test pruning.
---

# Waves Test Audit

Improve the suite's ability to catch real regressions with less maintenance.
Deletion counts and coverage percentages do not establish that improvement.
Ordinary test authoring uses root `CLAUDE.md` rule 20; loading this
skill does not turn a feature task into a wider cleanup.

All repository paths below are relative to the selected portal checkout.
Read its applicable `AGENTS.md` and `CLAUDE.md`. Follow the user's authorized
scope: a request to audit produces findings; a request to implement an audit
also permits the evidenced edits within that scope. Preserve the repository's
whole-file deletion, external-contract, and shipping rules.

## Investigate before editing

Choose a bounded behavior or subsystem and record the checkout, revision,
dirty state, and included files. Read each candidate test, its production
owner and callers, overlapping tests, relevant history, and CI routing.
Search patterns identify candidates, not deletion decisions.

Look for assertions that cannot detect a production change, expected values
calculated by the code under test, mocks supplying the result being asserted,
literal source checks that break on private renames, and repeated scenarios
that add no distinct failure case. Inspect any production export or injection
hook supported only by tests; useful dependency boundaries are not inherently
test bloat.

Record a short ledger before changing a candidate:

| Field | Evidence required |
| --- | --- |
| Test | Exact file, test name, and assertion or parameter row when relevant |
| Failure | Observable behavior or contract and a credible regression it catches |
| Decision | Keep, improve, consolidate, or remove, with the reason |
| Remaining proof | Exact retained test and assertion that detects the same failure, or why the assertion protects no contract |
| Context | Production owner/callers, relevant history, and any test-only code affected |
| Validation | Baseline result, runner, environment mode, and focused command |

Missing evidence means retain pending investigation. Two tests touching the
same lines may protect different failures; compare assertions and inputs.
For mixed source/behavior tests, classify individual assertion groups: proof
for one assertion does not justify dropping the rest of the test.
When consolidating, carry unique cases into the retained test before removing
their old assertions. Name the test that owns each retained contract.

## Preserve independent protection

Use root `AGENTS.md` P0/P1 invariants and `CLAUDE.md` rule 18 as the current
authorities. In particular, preserve proof of payment retry/idempotency and
amount agreement, authorization and customer/property scoping, token privacy,
booking conflicts and Eastern-time behavior, and communication consent,
deduplication, and delivery. A mocked test can still independently enforce
these contracts; a source check can still be the cheapest effective guard.

Slow, static, small, or implementation-looking is not sufficient evidence for
removal. Keep distinct integration, transaction, lifecycle, concurrency, and
external-consumer checks even when a unit test covers the same happy path.
Retain existing coverage floors, CI test selection, and meaningful negative
controls. A baseline failure is an investigation item, not permission to
delete the test or change its expectation.

## Validate a bounded change

Read [VALIDATION.md](VALIDATION.md) before running tests. Run the selected
baseline and record skipped tests separately from passes. Make one coherent
change, then run the retained tests and affected siblings in the same mode.
For material consolidation of a critical contract, demonstrate that the
retained test fails on the pre-fix behavior or a targeted production mutation.
Make such probes only in an isolated task-owned checkout, restore the source
exactly, and rerun the clean test. A failing probe must fail for the intended
reason; setup errors and unrelated guards prove nothing.

Do not broaden the task to repair unrelated product defects. Record them for
follow-up; repair defects within scope at their production owner with a
regression test. Use `waves-ship` only for the authorized shipping stages.

Report the ledger, changes and retained contracts, exact checks and revision,
skips or unavailable proof, and useful before/after measures such as runtime,
duplicated setup, and test/support lines. State when an audit made no edits.

Inspired by [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).
