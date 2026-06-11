# Specialty Service Completion & Report Contract (PR 0)

Product/UX contract for routing 13 specialty service types through the standard
appointment lifecycle + Service Report V1 pipeline. This document is the
binding spec for the implementation PRs (dark backend → report → CompletionPanel
→ follow-ups → gating → staged cutover). Engineering plan of record:
`docs/design/DECISIONS.md` entry "Specialty services → Service Report V1".

**North star:** a tech finishes a normal visit in under one minute, and the
customer receives a short, plain-English, confidence-building report they
actually read.

---

## 1. Scope

In scope (the 13 `PROJECT_TYPES` keys): `termite_inspection`, `pest_inspection`,
`flea`, `cockroach`, `rodent_exclusion`, `rodent_trapping`, `wildlife_trapping`,
`one_time_pest_treatment`, `one_time_lawn_treatment`, `mosquito_event`,
`palm_injection`, `termite_treatment`, `bed_bug`.

Out of scope / unchanged: `wdo_inspection`, `pre_treatment_termite_certificate`
(stay in Projects), all recurring service lines.

Cutover phases (profile row = feature flag; explicit allowlists only):

| Phase | Types | Gate |
|---|---|---|
| 1 (pilot) | pest_inspection, mosquito_event, palm_injection, one-time lawn, one-time pest keys | Golden fixtures owner-approved; kill switch armed |
| 1b (shadow) | ONE trend key (cockroach_control or one rodent_trapping key), `delivery_mode='internal_only'` first | Proves gauge, follow-up CTA, $0 follow-up, trend words, progress copy |
| 2 | remaining cockroach, flea, rodent trap/exclusion, wildlife, bed bug | Phase 1 + 1b verified; client-read + support metrics reviewed; bed bug copy owner-approved |
| 3 | termite_inspection, then termite remedial | Compliance signoff (FS 482.226, FS 482.2265, FAC 5E-14) |

## 2. Hard product constraints (binding)

1. p90 mobile completion **≤ 60 seconds** for pilot types; ≤5 required
   interactions when nothing major found; ≤8 when activity found.
2. **≤ 4 required service-specific fields** per pilot type (products/photos in
   the normal flow don't count). Tier 3 compliance types exempt.
3. **No required free-text.** Required fields are selects/taps only. Textareas
   and AI are optional; submit never waits on AI; deterministic summary always
   sends; AI failure is invisible to the customer artifact.
4. Customer copy is generated at completion and **persisted in
   `service_data.typedReportSnapshot`** (`schemaVersion`, `copyMapVersion`,
   `summaryTemplateVersion`, generated `todaysResult` text, resolved findings
   items with customer labels, `serviceKey`/`serviceLabel`/`reportTypeLabel`).
   Reports render from the snapshot forever; never recomputed from live
   templates.
5. Every typed report opens with **Today's Result** (headline + body +
   next step). It must answer: was there a problem / what we did / is it
   getting better / what should I do next.
6. **Zero states render.** `0`, `none_found`, `cleared`-class values, and
   meaningful `false` are results, displayed positively. Only
   null/undefined/"" are skipped.
7. **Banned words in customer copy:** "clear", "cleared", "gone",
   "eliminated", "no infestation", "guaranteed", "resolved". Absence wording
   is always observation-scoped: "No active signs observed today",
   "No visible evidence found during today's service",
   "No new activity observed in accessible areas".
8. Compliance details (product, active ingredient, reentry, notices where
   applicable) are automatic and snapshot-backed — never dependent on optional
   chips, recommendations, or AI text.

## 3. Form tiers and quick paths

| Tier | Types | Required interactions | Target |
|---|---|---|---|
| 1 — routine | mosquito_event, palm_injection, one_time_lawn_treatment | outcome → confirm products/photos → submit | 20–45s |
| 2 — findings | pest_inspection, one_time_pest_treatment, cockroach, flea, rodent_exclusion, rodent_trapping, wildlife_trapping, bed_bug | outcome → activity tap (or confirm prefill) → required selects (≤4) → 1–3 next-step chips → submit | <60s |
| 3 — compliance | termite_treatment (later termite_inspection if WDO-adjacent) | full mandated fields | accuracy over speed |

Quick path for "nothing major found" (Tier 2): outcome tap → zero-state
activity tap → "No action needed" chip → submit. 4 interactions.

## 4. Per-type contract

Required = blocks submit (post-cutover only). All other registry fields render
but are optional. "Zero option" = the select value that maps to activity 0 and
must be added to the registry where marked **(add)**.

| type | tier | gauge (indicator_key) | required fields | zero option | derivation |
|---|---|---|---|---|---|
| pest_inspection | 2 | — | severity | "None observed" **(add)** | — |
| one_time_pest_treatment | 2 | — | activity_level | "None observed" **(add)** | — |
| mosquito_event | 1 | — | (none) | — | — |
| palm_injection | 1 | — | (none) | — | — |
| one_time_lawn_treatment | 1 | — | (none) | — | — |
| cockroach | 2 | roach_activity | species, activity_level | "None observed" **(add)** | None 0 · Low 1 · Moderate 3 · Heavy 4 · Severe 5 |
| flea | 2 | flea_activity | evidence_level | "None observed" **(add)** | same map |
| rodent_trapping | 2 | rodent_activity | species, activity score | n/a (tech-set score; 0 allowed) | tech-set |
| rodent_exclusion | 2 | rodent_activity | species, activity score | n/a | tech-set |
| wildlife_trapping | 2 | wildlife_activity | activity score | n/a | tech-set |
| bed_bug | 2 | bed_bug_activity | evidence_level, treatment_method | "No active signs observed" **(add)** | None 0 · Low 1 · Moderate 3 · Heavy 4 · Severe 5 |
| termite_inspection | 2/3 | termite_activity | termite_type, activity_status | "No activity" (exists) | No activity 0 · Old/inactive 1 · Active 4 |
| termite_treatment | 3 | termite_activity | target_termite, treatment_method, products_used, linear_feet_or_stations, gallons_or_amount | n/a | tech-set (Phase 3 only) |

Activity score semantics (tech picker + customer wording — never show a number):

| score | tech picker | customer wording |
|---|---|---|
| 0 | None | No active signs observed today |
| 1 | Very low | Very low activity |
| 2 | Low | Low activity |
| 3 | Moderate | Moderate activity |
| 4 | High | High activity |
| 5 | Severe | Severe activity |

Pin semantics: derived prefill recomputes while untouched; the first tap on the
picker pins technician-set (even on the same value). Persist
`derived_from: {field, value, initialDerivedScore, pinnedAt}`.

Trend wording (2nd+ visit with same indicator): "decreased since the last
visit" / "increased since the last visit" / "about the same as the last
visit". First visit: "Baseline recorded today" — never claim a trend.

## 5. Customer-copy map (tech label → customer label)

Tech form keeps registry labels; reports use these. Any field without a
mapping renders with a humanized label and is flagged in fixture review.

| fieldKey(s) | tech label | customer label |
|---|---|---|
| activity_level / evidence_level / severity / activity_status | Activity level / Evidence level / Severity / Activity status | **Activity observed** |
| areas_inspected | Areas inspected | Areas we checked |
| areas_treated / treatment_areas / rooms_treated | Areas treated / Rooms treated | Areas we treated |
| harborage_locations | Harborage locations | Where activity was concentrated |
| conducive_conditions | Conducive conditions | Conditions to address |
| treatment_performed | Treatment performed | What we did |
| products_used / bait_or_products_used | Products used | Products applied |
| prep_for_customer / customer_instructions | Customer prep / instructions | What you can do |
| followup_plan / daily_check_plan | Follow-up plan | Next steps |
| entry_points_found / entry_points_observed | Entry points | Entry points we found |
| traps_set | Traps set | Traps in place |
| species / target_animal / target_pest / termite_type / roach species | Species / Target | What we found |
| sanitation_or_damage_notes / property_damage | Sanitation/damage notes | Damage & conditions noted |
| exclusion_completed | Exclusion work completed | Sealing work completed |
| exclusion_pending | Exclusion work pending | Sealing work still scheduled |
| standing_water_sources | Standing water / breeding sources | Mosquito breeding sources found |
| condition_found | Condition found | What we observed |
| turf_type | Turf type | Lawn type |
| irrigation_or_cultural_notes | Irrigation / cultural notes | Watering & care notes |

Value-label examples: `German` → "German cockroach"; `Roof rat` → "Roof rats";
`Low (few bugs)` → "Low activity"; `Chemical + heat` → "Combined chemical and
heat treatment".

## 6. Today's Result templates (deterministic; AI only polishes)

- **Initial, activity found** — headline: "{PestNoun} activity was
  {levelWord} today." body: "{WhatWeDid sentence from treatment_performed/
  chips}. {NextStep sentence}."
- **Initial, zero state** — headline: "No active signs of {pestNoun} observed
  today." body: "{WhatWeDid}. Continue monitoring and contact us if activity
  returns."
- **Progress visit (trend types)** — headline: "{PestNoun} activity has
  {trendWord} since our last visit." body: status + next check date.
  Report title: "{Program label} — Progress Visit" (e.g. "Rodent Program —
  Progress Visit"), never "Inspection Report".
- **One-shot (Tier 1)** — headline: "{reportTypeLabel} completed today."
  body: areas + products + any advisory.
- **Bed bug zero state (fixed copy)** — "No active signs observed during
  today's service. Continue monitoring and contact us if activity returns."

Subtype awareness: snapshot carries `serviceKey`/`serviceLabel`/
`reportTypeLabel` so one-time pest visits read as what they were
("Bee/Wasp Treatment Summary", "Fire Ant Treatment Summary"), not generic
"One-Time Pest Treatment". `reportTypeLabel` derives from the booked service's
display name, falling back to the type label.

## 7. Next-step chips (per family; generate the summary's next-step sentence)

- **pest/cockroach**: No action needed · Monitor activity · Sanitation
  recommended · Reduce moisture · Seal entry gaps · Remove cardboard/clutter ·
  Keep treated areas undisturbed · Follow-up recommended
- **flea**: Vacuum daily for 2 weeks · Wash pet bedding · Coordinate vet flea
  control · Stay off treated areas until dry · Follow-up recommended
- **rodent**: Trap check scheduled · Seal entry points · Sanitation
  recommended · Monitor for new activity · Exclusion work scheduled
- **wildlife**: Daily trap checks underway · Avoid trap area · Secure
  trash/food sources
- **bed bug**: Follow prep sheet · Wash/dry bedding on high heat · 14-day
  follow-up scheduled · Continue monitoring
- **mosquito**: Dump standing water weekly · Avoid treated foliage until dry
- **lawn**: Follow watering guidance · Mow guidance provided · Re-check
  scheduled
- **palm**: Retreatment scheduled · Monitor fronds for change

## 8. Report sections (typed reports)

Order: Today's Result → Activity gauge (trend types only; level word + history
+ trend chip; no customer rating prompt) → Findings (customer labels,
reportPriority order) → What we did / products → Photos → Reentry/advisory
(when products applied) → Review CTA → footer. Never: Pest Pressure card,
pressure trend, lawn program cards. Metrics band swaps pressure_index for the
activity level (gauge types) or drops it (non-gauge) and must look intentional
with few metrics.

SMS copy (short, service-specific):
- Initial: "Hi {first}, your {reportTypeLabel} report is ready: {url}"
  (+ reentry line when products applied).
- Progress: "Your {check noun} was completed today. Activity is {trendWord}.
  Details: {url}".

## 9. Follow-up flow

Follow-up types: rodent_trapping, wildlife_trapping, bed_bug, cockroach (only
when species = German, matched on the canonical registry value). Completion
success screen offers "Schedule follow-up (suggested {date})" — booking either
reuses existing scheduling validation or creates an admin-confirmed follow-up
request (decided in PR 4); it never blocks report delivery. Follow-up
appointments are $0 with `followupIncluded` (billing gate bypass).

## 10. Telemetry

Tech-speed (CompletionPanel): `panel_opened`, `first_field_touched`,
`submit_clicked`, `server_complete_success`, `required_field_error_count`,
`ai_draft_used`, `recommendation_text_edited`, `activity_score_touched`.
Budget check: p90(submit − open) ≤ 60s on mobile for pilot types.

Client-read (report): `report_opened`, `sms_link_clicked`,
`email_link_clicked`, `pdf_downloaded`, `time_to_first_open`, `repeat_open`.

Support metrics reviewed before Phase 2 (manual pull is fine): customer
replies/questions after report, office calls within 48h of report, manual
resend requests, follow-up scheduling conversion, review-request completion.

## 11. Readability acceptance criteria (golden-report review)

A fixture passes when an owner review answers yes to all:
1. Understandable by a customer in ~10 seconds (Today's Result alone tells the
   story).
2. Would plausibly prevent a phone call rather than cause one.
3. Sounds professional; nothing alarming, hedgy, or awkward.
4. No internal jargon or raw field keys; no banned words (§2.7).
5. Zero states read as positive results, observation-scoped.
6. Next step is explicit.
7. A tech could have produced it within the tier's time budget.

## 12. Golden fixtures

`docs/design/specialty-report-fixtures/*.json` — one per Phase-1 family,
zero-state and payment-required cases, and first/second-visit pairs for trend
types. Each fixture contains the `typedReportSnapshot` plus `expected`
assertions (PR 2 turns these into rendering tests).

| fixture | proves |
|---|---|
| pest_inspection_no_major_findings | Phase 1; zero-state severity |
| one_time_pest_bee_wasp_completed | Phase 1; subtype-aware labels; payment-required completion |
| mosquito_event_completed | Phase 1; Tier 1 minimal form |
| one_time_lawn_treatment_completed | Phase 1; lawn family |
| palm_injection_completed | Phase 1; Tier 1 |
| cockroach_initial_moderate_german | Phase 1b/2; gauge baseline; German follow-up trigger |
| cockroach_followup_improving | trend words; progress framing; same indicator history |
| rodent_trap_check_initial | trend baseline; traps language |
| rodent_trap_check_declining | progress visit; short SMS |
| bed_bug_followup_no_active_signs | zero-state trend; bed-bug-safe wording |
