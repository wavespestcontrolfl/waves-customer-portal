# Universal One-Time Services — Terminal Build Kickoff

For the Claude Code session driving this build with the owner (Adam) in the
terminal. Reference this file to start: it runs the ratification interview
first, then the build.

## Read first, in order

1. This file.
2. `docs/design/universal-onetime-services-plan.md` — the plan of record
   (Phases A–H + WDO + commercial lens + coverage guarantee). UNRATIFIED
   until the interview below is recorded.
3. Supporting contracts as needed:
   `docs/design/specialty-service-completion-contract.md`,
   `docs/design/combined-service-completions.md`,
   `docs/design/specialty-phase2-owner-spec.md`.

House skills, non-negotiable: **waves-ship** for every PR;
**waves-db** for every migration and every timestamp-window query (F/G/H
bounds are the documented ET/timestamptz incident class); **ui-verify**
before review on any client UI PR; **pricing-config** ONLY for the Q8 WDO
fee resolution; **ib-write-tools** only if Intelligence Bar tools get built.

## Session flow

- **Step 0 — build A0 immediately, no decision needed.** The shadow-report
  review list (Phase A item 1: date · service key · customer · staff report
  link for every `internal_only` rodent-family report since 2026-06-12) is
  read-only tooling. Build it first so the owner can review shadow reports
  while the interview proceeds.
- **Interview:** ask the questions below ONE at a time, in block order.
  Short prompts — the owner often answers by voice. After each answer,
  confirm your interpretation in one line, then move on. "Default" or
  "your call" = adopt the inline recommendation.
- **Record:** after each block, append the answers verbatim to a
  "Ratified decisions (date)" section at the bottom of the plan doc, adjust
  the affected phase text, commit (`Scope: ratify Qn–Qm`). When all blocks
  are answered, flip the plan header from "not yet ratified" to ratified.
- **Build:** once Block 1 + Q11 are answered, propose the first batch —
  A graduation migration (post-review), B0 coverage audit + the unblocked B
  cutovers, E1 combined-key routing — get an OK, then go. Follow plan
  order; one shippable PR at a time; every migration scratch-DB replayed
  with the self-healed per-key pattern (the `20260611000012` lesson); kill
  switch per new lane; DECISIONS.md entry only when PRs ship.

## The interview

### Block 1 — unlocks Phase A + most of B (highest impact, do first)

**Q1 — Rodent graduation.** After reviewing the A0 list: graduate the whole
rodent family at once, or `rodent_trapping` first and exclusion/sanitation a
week later? The graduation flip also covers the `pest_rodent_quarterly`
companion and the B0 `rodent_monitoring` repoint.
*Recommendation: whole family at once if the exclusion/sanitation reports
read well — one migration, one verification pass. Customers currently get
NOTHING for rodent, so speed matters.*

**Q2 — Bed bug copy.** Approve the bed-bug customer wording so its cutover
can ship? (Zero-state copy is contract-fixed and already fixture-reviewed.)
Also: does `bed_bug_treatment` become customer-visible/bookable, or stay
internal?
*Recommendation: approve; keep visibility a separate later call.*

**Q3 — cockroach_control.** Flip the multi-visit German program to the typed
`cockroach` flow now? The knockdown keys already prove the flow.
*Recommendation: yes.*

**Q4 — general_appointment / waveguard_initial_setup.** Leave on the project
flow (they aren't customer-report lanes), or build a minimal no-gauge typed
form for general_appointment?
*Recommendation: leave as-is.*

### Block 2 — unlocks the E1 build

**Q11 — Combined booking.** Should the estimate converter auto-combine the
three known pairs (pest+rodent bait, pest+termite bait, lawn+tree&shrub)
into ONE combined scheduled service? And the Harris case — re-type the
existing separate pest + rodent rows onto `pest_rodent_quarterly`?
*Recommendation: yes to both; Harris re-type ships as a marker-reversible
one-off.*

**Q12 — Add-on / auto-fold billing (E2/E3).** When a section is added at
completion (ad hoc, or same-day complete-together): always $0-included, or
bills its own service price through the per-component billing gate? One
merged invoice or one per service? (Payer-routed components never merge
with customer-responsible ones — already fixed in the plan.)
*Recommendation: same-day fold bills each service its own price, one
invoice per service (no money behavior change); ad-hoc extra work defaults
$0-documentation unless the owner flags it billable at completion.*

### Block 3 — numbers for F/G/H (the context engine)

**Q13 — Comms windows.** Ratify: recurring = since last completed visit of
the service line, capped 120 days; one-time = since job origin, capped 180
days. Checkbox default: checked or unchecked?
*Recommendation: accept caps; default checked (owner is the only tech and
already uses it).*

**Q14 — Program episodes.** Episode gap 90 or 120 days? K=3 prior visits in
the AI digest? Prior-report digest always-on, or behind the comms toggle?
*Recommendation: 120 days, K=3, always-on (it's our own service data).*

**Q15 — Prep + coverage in customer copy.** v1 tech-context only, or may
reports also say "per the prep instructions sent July 9" and structured
coverage lines ("covered under your termite bond")? And: list the prep docs
still being authored so the H1 registry starts complete.
*Recommendation: tech-context only at v1; revisit after H ships.*

### Block 4 — UI decisions (gate C/D)

**Q7 — Naming.** Keep "Projects" in the admin nav, or relabel to "One-Time
Services" / "Jobs"? Label-only either way.
*Recommendation: relabel to "Jobs" once Phase C1 ships.*

**Q9 — Tech entry (C4).** Open the completion sheet directly on /tech, or is
the dispatch-tab habit fine?
*Recommendation: open directly — it's a small PR and removes the alert
bounce.*

**Q10 — D2/D3 rollout.** Timeline: trend types only, or all typed families?
Video recap: which family first, and is during-visit capture wanted beyond
pest jobs?
*Recommendation: timeline trend-types-first; video recap rodent-first after
graduation; capture affordance decision deferred until the first typed
composition exists.*

### Block 5 — compliance + WDO

**Q5 — Termite Phase 3.** Who performs the FS 482.226 / FS 482.2265 /
FAC 5E-14 review for the inspection + remedial lanes, and when? (Bait lane
precedent: owner signed off 2026-06-12.)

**Q6 — WDO.** Confirm W1 — universal shell and report polish, FDACS
pipeline untouched (`V1_EXCLUDED_PROJECT_TYPES` stays) — over W2 full merge.
Same treatment for pre-treat certs?
*Recommendation: W1, both.*

**Q8 — WDO fee, three disagreeing sources.** Tech estimator $125 flat;
invoice tiers $150/$200/$250 by structure sq ft; stale
`SPECIALTY.wdo.brackets` $175/$200/$225 by lawn sq ft still read by the
estimate engine. Which is right? (Then all three converge via
pricing-config.)

### Block 6 — commercial

**Q16 — Commercial.** (a) Do you ever service multiple buildings in ONE
appointment (drives per-building sections vs one-visit-per-property)?
(b) Explicit commercial designation on customers, or keep tier/tax
inference? (c) Priority of the compliance-logbook export?
*Recommendation: (b) yes, add the explicit flag when the first commercial
delta ships.*

## First build batch (after Block 1 + Q11)

1. A0 review list (already built in Step 0) → owner review → **A graduation
   migration** (family flip + companion + `rodent_monitoring` repoint).
2. **B0 coverage audit** script + fall-through contract test; file the
   verify list (palm_treatment, termite_renewal, seed lawn_care rows).
3. **B cutovers** unblocked by Block 1 (wildlife, cockroach_control, bed
   bug per Q2).
4. **E1** converter combining + Harris re-type (per Q11).
5. Then C → D → E2/E3 → F/G/H per the plan, with the F1/G1/H3 shared
   context service built as one foundation.
