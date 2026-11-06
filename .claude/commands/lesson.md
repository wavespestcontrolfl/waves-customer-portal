---
description: Diagnose a correction and strengthen the existing rule, skill, test, or environment fix; return proposed edits for read-only or proposal-only tasks
argument-hint: what went wrong, and (optionally) what the rule should be
---

A mistake was caught. Identify its first concrete cause and check whether
an existing rule, skill, test, or environment fix already covers it.
Strengthen that mechanism when needed; do not add a permanent rule for
temporary task state, unavailable tools, or an already-clear rule.

In proposal-only or read-only work, return the proposed correction without
editing or committing. Otherwise, apply the correction only within the
authorized scope, following the placement rules below.

What happened: $ARGUMENTS

(If the arguments are thin, reconstruct the mistake from the recent
conversation: what was done wrong, what the correction was.)

## Where the rule lives — pick exactly one

1. **A check, not prose** — if the rule can be a test, a
   `check:domain-rules` scanner rule, a contract test, or the route-surface
   allowlist, write that. Code enforces itself; prose rots. Leave a one-line
   pointer in the file the rule would otherwise have lived in.
2. **`AGENTS.md`** — if the lesson is a *code-review rule*: something a
   reviewer should flag when it appears in a diff (a dangerous pattern, a
   file that must not change a certain way, a security invariant). Add it
   under the correct severity (P0 / P1 / out-of-scope) and cite the
   `file:line` it protects, matching the existing entries. Rules here are
   enforced by both Codex (pre-push hook + @codex bot) and Claude reviews.
   The file has a 30 KB budget (`npm run check:domain-rules` fails past
   it; Codex truncates at 32 KiB) — run the check after editing, and if
   you are over, cut narration from the class you are extending rather
   than dropping a rule.
3. **`docs/public-route-contracts.md`** — if the lesson is the security
   contract of a route served without staff auth (its gate, token format,
   rate limit, payload, headers, or an owner ruling about it). A lesson
   about ONE route goes in its entry there; a lesson that applies to EVERY
   public route (baseline guards, the report-family write rules, contract
   burn, ask/find-slots gates) goes in the AGENTS.md P0 "Public route
   surface" rule — never both.
4. **The matching skill in `.claude/skills/*/SKILL.md`** — if the lesson is
   *procedural* and belongs to a domain a skill already covers (billing,
   DB/SQL, LLM call sites, shipping/PRs, content, pricing, UI verification,
   IB write tools). Add it to the relevant section (usually Procedure or
   Failure Modes) in that file's style.
5. **`CLAUDE.md`** — last resort, only for a rule that is global, small, and
   relevant to nearly every session. CLAUDE.md loads into every session's
   context; keep it lean. Prefer options 1–4.

## How to write it

- One rule, stated as the behavior to follow — not a story about the mistake.
- Name the failure it prevents. If you cannot, it is not a rule; drop it.
- No snapshot counts, "as of" dates, or review-round narration — those go
  stale within weeks, and a wrong instruction costs more than a missing one.
- Concrete enough to act on: name the file, command, or pattern involved.
- Match the destination file's existing tone, format, and severity scheme.
- Check the destination first — if an existing rule already covers this,
  sharpen that rule instead of adding a duplicate.

## Check it on live data

A test guards the code you fixed. It does not find the NEXT mistake of the
same kind in live data, so the owner has to catch it again. Ask:

**Would a scheduled, read-only check on live data have found this without
the owner?**

A lesson is not done until a check like that exists, you added it in this
change, or the lesson says `no check yet: <reason>`. Pick the home:

1. **A portal check** — the default for a mistake in portal behavior. A job in
   `server/services/`, registered in `server/services/scheduler.js` inside
   `runExclusive`, that raises one admin bell row per problem and closes the
   row when the problem is gone. Add it in the SAME PR as the fix, dark
   behind a `GATE_*` (the PR template's Kill switch line). Use the existing
   self-closing helpers; do not hand-roll a close:
   - A bell for the owner: `raiseAdminAlert` (`admin-alert-compose.js`) to
     raise it, `closeAdminAlertKeys` and `openAdminAlertKeys`
     (`admin-alert-episodes.js`) to close it. `caller-callback-bell.js` is
     the model.
   - An engineering finding: `deliverOpsDigest` (`ops-digest.js`) with
     `fallOff: true`, which stamps the row's `opsKey`, and `retireIfClean`
     (`ops-digest-fall-off.js`) on the clean run. `seo/owned-url-health.js`
     is the model. Its email fallback goes to an internal address only.
   Do not add a raw `notifyAdmin(` call; a ratchet test counts them.
2. **The nightly call self-audit** (`call-self-audit.js`) — for a mistake in
   how a call is read or handled. It re-reads calls with a paid model, so
   widening what it samples or compares is new spend: stop and ask the owner,
   with the cost per day and per month.
3. **Text drafts** — a Mac job outside this repo (`max-sms-judge`) grades them
   nightly. For a text mistake, note that in the lesson. Do not edit that job.
4. **A check on the owner's MacBook Air** (`~/waves-ops/ops-crons/checks/`,
   host adams-air). Each edit there needs the owner's OK. Write the proposed
   check text in the lesson, say it is a proposal, and never edit the Air.

Rules for any new check:
- Read-only. It never writes a business record.
- One bell row per problem, and the row closes itself when the problem is gone.
- No paid API call. If the check needs one, stop and ask the owner first.
- Never a customer text, email or call.

If no home fits, write `no check yet: <reason>` in the lesson. Name the check,
or that line, in the PR's Encoded lesson section.

## Ship it with the fix

When committing is authorized, commit the rule on the SAME branch/PR as the fix for the mistake, so the
correction and the lesson land together. If there is no associated fix,
include it in the authorized instruction-change commit with a message
explaining what incident it encodes. Local-only work ends with the local
correction; proposal-only work ends with the proposed edit.
