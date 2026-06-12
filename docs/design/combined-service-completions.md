# Combined service completions — companion typed sections

Owner directive (2026-06-12): combined services — "Quarterly Pest + Termite Bait
Station", "Pest & Rodent Control" (pest + rodent bait), "Lawn + Tree & Shrub" —
must complete as ONE service, in ONE submission, producing ONE customer report.
This is a GENERAL mechanism, not a per-combo build.

## Concept

A `service_completion_profiles` row may declare **companion types**: typed
findings sections that ride the service's normal primary completion flow
(recurring pest, lawn, or a typed primary). The tech completes once; the
customer gets one report with the primary content first and one section per
companion below it. Billing, scheduling, and the primary flow are untouched.

## Data model

- New column `service_completion_profiles.companion_types` — JSONB, nullable.
  Shape: `[{ "type": "<typed findings type>", "delivery": "auto_send" | "internal_only" | "disabled" }]`.
- Profile row stays the feature flag (house doctrine): the mechanism ships
  DARK — no row carries `companion_types` until the cutover migration.
- `serializeProfile` emits `companions: [{type, delivery}]`, FAIL-SAFE:
  entries with an unknown typed findings type are dropped; missing/invalid
  delivery coerces to `internal_only` (never accidentally customer-facing);
  an entry duplicating the profile's own `findingsType` is dropped; `disabled`
  entries are dropped at serialization (section fully off); duplicate
  companion types are dropped (first entry wins — two schemas for one type
  would strand /complete on `companion_duplicate_type`; a `disabled` entry
  claims its type so a stale duplicate can't resurrect it).

## Delivery semantics (the shadow rule)

Each companion entry carries its OWN delivery posture, set by cutover and
flipped by the same graduation migrations that flip the standalone keys.
At completion time each companion snapshot freezes its delivery
(`auto_send` | `internal_only`):

- The PRIMARY report delivery is unchanged (the service's own
  `delivery_mode`). A shadowed companion never blocks the primary send.
- `internal_only` companion sections are stored and render for STAFF viewers
  only (reuse the #1631 staff-read mechanism + internal badge); the customer
  copy (web, PDF, SSR metadata) omits them entirely.
- Graduation never retro-publishes: stored sections keep their frozen posture.

## /complete contract

New payload field `companionFindings`:
`[{ type, values, nextStepChips, activityScore, activityScoreSource }]`.

- AUTHORIZATION: every submitted type must be in `profile.companions`
  (409 `companion_type_mismatch`) — the profile is authoritative, never the
  client payload.
- REQUIRED: on a completed (non-incomplete) visit, every declared companion
  must be submitted → 422 `companion_findings_required` naming the missing
  type(s). Incomplete visits skip companions entirely.
- Each companion validates EXACTLY like a typed completion, reusing the
  existing machinery per type: `validateTypedFindings` (enforceRequired:
  true — a declared companion is by definition cut over),
  `validateNextStepChips(chips, type, values)`, `nextStepRequiredForType`,
  derive-then-pin scoring, trend types require a score (422
  `companion_activity_score_required` naming the section),
  `validateActivityScoreConsistency`.
- INDICATOR UNIQUENESS: a companion whose activity indicator collides with
  the primary typed indicator or another companion's → 422
  `companion_indicator_conflict` (the composite unique on
  service_activity_scores would otherwise silently drop a row).
- Trend per companion: prior-score + visit-sequence resolved per
  `indicator_key` (same queries as the primary typed path).
- PERSISTENCE: `service_data.companionReportSnapshots = [snapshot]` where each
  snapshot is `buildTypedReportSnapshot(...)` plus `delivery` (frozen).
  One `service_activity_scores` insert per companion with activity.
- Photos, photo AI summary, follow-up suggestions, AI-drafted
  recommendations, and pest pressure remain PRIMARY-ONLY in v1 (companion
  sections are chips-first deterministic copy). Disclosed for ratification.

## Report

- `report-data` exposes `companionReports: [snapshot + {internalOnly}]`,
  ordered as declared on the profile. Customer view filters out
  `internal_only` sections; the staff view includes them flagged
  `internalOnly: true`. Activity history per section loads with the same
  customer-view loader as the primary typed path.
- `ReportViewPage` renders, per companion, after the primary content:
  the Today's Result section, the findings card, and the activity gauge —
  reusing the existing TodaysResultCard / TypedFindingsCard / ActivityCard
  with the companion snapshot. Internal-only sections render the existing
  internal-review treatment and only for staff viewers.
- Staff reads never count as customer engagement: the /data route skips
  `report_viewed_at` + activity logging when the staff JWT resolves, and the
  payload carries `staffViewer: true` so the client posts NO interaction
  events for that token (the /events endpoint is unauthenticated — the gate
  has to ride the payload).
- PDF renders the customer view of the same page — no separate work.

## Completion panel

- Companion schemas ship in the dispatch payloads alongside `findingsSchema`
  (`companionSchemas`) — mobile must not block on a registry fetch.
- One `TypedFindingsSection` per companion (both mobile and desktop
  variants) with per-companion values/chips/gauge state. The recommendations
  textarea + AI draft controls stay primary-only.
- Every client pre-submit mirror applies PER COMPANION:
  `typedFieldRequiredNow` (requiredUnless), required-chips, score-required,
  `typedNextStepChipConflict`, `typedActivityScoreConflict`. Server-side
  conditional checks without client mirrors are a known Codex flag.
- Companion draft state participates in the existing completion draft
  autosave/restore, with the same type-aware pruning on restore.

## Cutover (migration 20260612000031)

Three combined catalog keys, each a standard recurring primary
(service_report, no findingsType) + companion(s); companion delivery mirrors
the type's standalone graduation state at cutover:

| service_key | name | companion | delivery |
|---|---|---|---|
| `pest_rodent_quarterly` | Pest & Rodent Control | rodent_bait_station | internal_only (rodent shadow) |
| `pest_termite_bait_quarterly` | Quarterly Pest + Termite Bait Station | termite_bait_station | auto_send (graduated 20260612000023) |
| `lawn_tree_shrub_combo` | Lawn + Tree & Shrub | tree_shrub | auto_send (always was) |

- Names are the customer-facing combined names verbatim, so name-based
  profile resolution works; existing "Pest & Rodent Control"
  scheduled_services rows are additionally service_id-linked by the
  migration (name-matched, self-healed, prior service_id recorded).
- `detectServiceLine`: a "pest" mention BEFORE the rodent/termite token
  marks the pest-primary combined name — never beats lawn/turf or mosquito,
  and token order is load-bearing ("Rodent Pest Control" =
  rodent_general_one_time stays a rodent report). Without this, "Pest &
  Rodent Control" rendered the RODENT report layout.

## Graduation recipe (rodent family — future migration)

When the rodent family graduates (owner shadow review), the graduation
migration must flip BOTH:
1. `delivery_mode` on the standalone rodent keys (the 20260612000023
   pattern), AND
2. the companion entry on `pest_rodent_quarterly`:
   `companion_types` jsonb → set `delivery: 'auto_send'` on the
   `rodent_bait_station` entry (read row, modify the parsed array in JS,
   write back; marker + prior value in notes for rollback fidelity).
Graduation never retro-publishes — stored snapshots keep their frozen
posture (the runtime already guarantees this; the flip only affects new
completions).

## Out of scope (follow-up PR)

- Estimate routing: the converter still emits one scheduled service per
  recurring estimate line; combining pest+rodent_bait / pest+termite_bait /
  lawn+tree_shrub estimate selections into ONE combined scheduled service
  carries cadence + billing decisions (lawn 6/9/12-app vs T&S visit
  mandates) and ships separately.
- Harris: pest + rodent disclosed as SEPARATE services — not name-matched
  by the cutover migration; mapping to the combined key is an owner
  decision (then a one-off re-type of the rows or an admin edit).
