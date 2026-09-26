---
name: test-audit
description: Use when writing, changing, reviewing, or auditing tests in Waves Customer Portal. Identify meaningful regression coverage, redundant or implementation-coupled tests, and obsolete production code kept alive only by tests. Running tests alone does not require a suite-wide audit.
---

# Test audit

Adapted from [OpenClaw's test-audit skill](https://github.com/openclaw/openclaw/blob/a58c09b1211edfbe952f5fafeb6364d830f2fc8b/.agents/skills/test-audit/SKILL.md).
Upstream attribution and MIT terms are in [UPSTREAM-LICENSE.txt](UPSTREAM-LICENSE.txt).

Use the authoring checks for tests touched by the task. Use the audit workflow
for requested cleanup; a subsystem-wide sweep needs that scope in the task.
The objective is useful regression protection with less maintenance, not a
test-count, coverage-percentage, or deletion target.

## Before adding or changing a test

Establish four things:

1. The observable outcome, invariant, or independent contract being protected.
2. A concrete regression that would fail the assertion for the intended reason.
3. The gap in existing coverage. Prefer extending the test that already owns
   the behavior. A second layer needs a distinct risk, such as route auth,
   transport serialization, persistence, or lifecycle ordering.
4. A real production entry point. Avoid adding exports, globals, wrappers, or
   injection hooks solely to let tests reach private implementation details.

Expected results must come from an independent contract or known input/output,
not the same helper under test. Mock external effects while exercising the
code responsible for the claimed behavior. Check that a negative case reaches
the intended guard rather than passing because an earlier guard rejects it.

For a bug regression, demonstrate the intended assertion failing before the
fix and passing afterward. Use an isolated checkout when needed. If baseline
execution is unavailable, report that limit instead of claiming a verified
regression. Do not manufacture additional tests for a low-impact change that
existing coverage already protects.

## Find candidates and preserve valuable coverage

Read applicable repository instructions, the complete test, its production
implementation and entry points, overlapping tests, CI selection, and relevant
history. Use `rg` for references and `git log -- <path>` for why a guard exists.
Inspect dependency source or types when the assertion depends on that contract.

Candidate signals include:

- Tests without meaningful assertions; assertions comparing a value to itself
  or deriving the expected result from the implementation being tested.
- Mocks or fixtures that supply the very behavior the production path should
  provide, including writes or ordering that the tested path never performs.
- Source-string, import, export-list, or copied-manifest checks that only freeze
  the current implementation and do not enforce an independent contract.
- Repeated scenarios or private-helper call-shape tests already covered at the
  responsible public boundary, with no additional failure mode.
- Tests and support wrappers whose only purpose is preserving retired code.

These are investigation signals, not automatic deletion rules. Keep independent
checks of authentication, payment math and idempotency, migrations and storage,
time-zone behavior, public/native/webhook contracts, and shared package APIs.
Retain source inspection when it guards an actual key, byte, path, or architecture
contract and survives an internal identifier rename. Observable call ordering
can itself be behavior.

A failing baseline may reveal a product bug; reproduce and fix or report it.
Age, slowness, static inspection, or refactor sensitivity alone does not justify
removal. No local callers is insufficient evidence for externally consumed
code, documented inactive evidence modules, or retained V1 shared exports.

## Evidence before cleanup

Record each proposed removal in the task notes or PR:

- Exact test name and file, and the failure it can actually detect.
- Production callers and entry points, including external or dynamic consumers.
- The remaining test that protects the same failure, or evidence that the
  supported behavior has been retired and no replacement coverage is needed.
- Relevant history explaining the test or support code.
- Production and test-support code made obsolete by the removal.
- Risk, the focused validation command, and any unresolved uncertainty.

Complete this evidence before editing a candidate. Stay within the authorized
scope and apply existing repository deletion rules. Keep uncertain candidates
as named follow-ups. Group edits by one behavior or subsystem; remove obsolete
test-only hooks with their tests and move useful regressions to the current
implementation's tests. Avoid compatibility aliases for retired internals.

## Validate and report

Finish edits before starting a test run; results must describe one stable
revision. From the repository root, choose the relevant runner:

| Scope | Focused command (replace the example path) |
| --- | --- |
| Server Jest | `npm run test --workspace=server -- --runInBand --coverage=false --runTestsByPath tests/example.test.js` |
| Client Vitest | `npm run test --workspace=client -- src/example.test.jsx` |

For scripts or shared packages, use their existing runner. Include neighboring
consumers when shared behavior changes. Follow `docs/development.md` and the
database rules in `AGENTS.md` for database-dependent checks; contract runners
that call live providers are not a substitute for isolated tests.

When removing a source-only assertion, exercise the real script or contract
check it was meant to cover. Run applicable lint/domain checks and
`git diff --check`; follow the existing shipping workflow when shipping is in
scope. Broaden validation for a specific unresolved risk, not to inflate counts.

Report the evidence, preserved contracts, commands and outcomes, skipped checks,
and remaining candidates. Use `git diff --numstat` to separate production code,
tests/test support, and documentation; give deletions, additions, and net change.
State whether the work is local, in a PR, or merged. A passing suite after
deleting its assertions does not establish that coverage was preserved.
