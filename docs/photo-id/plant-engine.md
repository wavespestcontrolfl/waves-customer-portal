# Photo ID v2: lawn/plant engine (L3)

`server/services/photo-id-v2/plant-engine.js` (+ `plant-engine-prompts.js`) is
the sibling of the pest engine (`pest-engine.js`,
`~/photo-id-v2-build-20260926/V2-CONTRACT.md`) for the catalog's `plant` and
`condition` sections landed by #5143/#5158. Binding spec:
`~/photo-id-lawn-plant-build-20260927/PLANT-ENGINE-CONTRACT.md`.

**L3 has no runtime caller.** No route, no gate, no storage. L4 wires
`identifyPlantV2` into `POST /api/photo-id/lawn` and `/tree_shrub`; because
those routes ride the already-on `GATE_PHOTO_ID_V2`, L4 is the go-live PR.

## What it does

A pest photo asks "what is it?"; a lawn/plant photo usually asks "what's
wrong with it?" — several causes can look alike, and a photo alone often
can't separate them. So `identifyPlantV2` returns a **workup**, not a single
identification: what we can see, up to three possible causes with what fits
and what doesn't fit yet, the one observation that would settle it, and the
next step. Weeds, grass type, host plants and palms still get the pest-style
identity answer ("We're pretty sure: Purple Nutsedge").

```js
const { identifyPlantV2 } = require('./plant-engine');
const { ok, v2, internal, reason } = await identifyPlantV2({
  photos, subject, chips, context, now, mode, // mode: 'workup' (default) | 'identify'
});
```

`ok:false` shapes mirror the pest engine: `no_photos`, `invalid_subject`,
`vision_unavailable`, `no_route`. `internal` (which models answered,
escalation reasons, the resolved account turf) is admin-only and must never
be merged into `v2`.

## The `v2` workup shape

```json
{
  "version": 2, "kind": "workup", "subject_type": "lawn", "tier": "needs_more_evidence",
  "subject": { "plant": { "slug": "...", "source": "account|photo", "wording": null|"pretty_sure"|"likely" }, "weeds": [...] },
  "answer": { "level": "entry|symptom", "headline": "...", "symptom": "browning"|null },
  "observed": ["..."], "possibilities": [{ "slug", "strength", "fits", "not_yet", "local", ... }],
  "evidence": { "photos": 3, "chips": {...}, "account": {...} },
  "settle_it": { "kind": "photo|field_test|technician|retake", ... },
  "next_step_hint": { "kind": "specialist|inspection|fix_conditions|none|unclear", "text": "..." },
  "referral": null, "quality": { "usable": true, "issue": "none", "shows": "plant|damage|both|nothing|conflicting|null" }
}
```

`mode: "identify"` returns the pest identity-card shape instead (`{ version,
kind: "identity", answer, entry, generic_safety_line, evidence: { matches,
still_need }, candidates, next_photo, quality }`) for Layer A only, so the existing
`V2Result` card renders its "What matches" / "What we still need to see"
sections; that evidence (and the next-photo pair) is read only from the
candidates that support the chosen answer node, never from a top candidate
outside the group the headline names. The one identity lane is the host for `tree_shrub`/`palm`; for a
lawn it is whichever of turf and weeds the photos populated, and when both
are populated the one with the better answer the customer would actually
get (`laneEligibilityRank`, read off `identitySlotAnswer` — the same
function the builder uses: `pretty_sure` > `likely` > a subgroup > group >
category climb > `unknown`), then the higher top confidence (turf on a
tie) — a photo of a weed returns the weed, not an empty turf answer.
`internal.identity.lane` records the choice.

## Photo reads that gate naming

- **Quality.** Any leg (candidates, conditions, escalation, a host re-run)
  reading `usable: false` makes the photos unusable.
- **`shows`.** Call A and the escalation each report whether the photos show
  the `plant`, `damage`, `both`, or `nothing`; the combined read rides along
  as `quality.shows`. `nothing` from any leg makes the photos unusable
  (`usable: false`, issue `subject_unclear` when no other issue was
  reported). Two different specific reads (`plant` vs `damage`) are
  `conflicting`: nothing is named, though the workup keeps its symptom
  headline, possibilities and next step. `both` is compatible with either
  read.
- **Unusable** → workup: fixed unusable headline, no named identity or
  condition, no possibilities or observations, the retake prompt as
  `settle_it`, `next_step_hint: unclear`, tier `needs_more_evidence`;
  identify: the `unknown` answer, no candidates or evidence, a retake
  prompt, tier `needs_more_evidence` (the same gate in both modes).

## Identity verification and escalation provenance

- Cue citations are cleaned before anything reads them: out-of-range
  numbers and a cue cited as both visible and not visible are dropped; a
  candidate is `verified` (required for `pretty_sure`) only with at least
  one clean visible cue.
- The verify leg counts as a miss (→ escalation) unless it returns a record
  for EVERY catalog candidate it was asked about. A candidate an answered
  verify leg left out is `uncovered` and is never named unless a checked
  escalation score replaces it (a whole-leg miss keeps the older rule: the
  escalation trigger fires and an unanswered one caps wording at `likely`).
- When both providers agree on a slot's top, the combined candidate carries
  ONE provider's score together with its own provenance: a score whose cue
  check passed beats one whose did not, the higher of two passed checks
  wins, and otherwise Gemini's stands — never the `Math.max` of a checked
  and an unchecked number. OpenAI's cue numbers count as a check only for
  slugs it was given a numbered cue list for.
- Self-contradiction (raw vs verified top, compared by candidate identity)
  and low confidence are checked per slot — turf, weeds and host
  separately, off-catalog tops included — so
  a flipped or uncertain turf answer escalates even under a
  higher-confidence weed, and a turf/weed confidence swap does not.
- The lawn's account turf (`context.grass_type_on_file`) outranks any photo
  guess, but is shown by name only once its catalog entry is owner-approved;
  until then `subject.plant` stays `null` (contract §4: unapproved entries
  are excluded from every answer).
- A provider disagreement in `mode: "identify"` resolves to the two tops'
  deepest shared catalog node ("Looks like a plant" for a palm vs a citrus),
  never to a group only one provider supports.
- Each provider's selected conditions are ranked by confidence before the
  agreement check reads either provider's top.
- **Off-catalog groups.** Call A and the escalation return a nullable
  `group_id` for an off-catalog answer; the engine keeps it only when it is
  a real plant-section group of that slot's own index. Two providers
  agreeing on an off-catalog plant in the same group therefore agree (same
  candidate key) and `mode: "identify"` climbs to the group generic
  ("Looks like a palm"). The workup still has no group-level identity slot,
  so there it stays unnamed.
- **Next photo.** `next_photo` follows the chosen answer: on a disagreement,
  the look-alike between the two providers' own tops; at `likely`, the named
  entry's first approved look-alike; for a group-level answer, a look-alike
  pair among the candidates that support that group; otherwise the retake
  prompt.

## Condition index for trees, shrubs and palms

The tree/shrub/palm condition index (Call C and the escalation prompt) is
the union of `conditionIndexFor` over every catalog host candidate still
reading ≥ 0.20 after verification plus the customer's `plant_slug` chip (no
viable host → the class index). An OpenAI host correction inside that union
was therefore already covered. When the escalation's top host is OUTSIDE the
union, the engine runs Call C ONCE more against union + corrected host,
within what is left of the total time budget, and recombines it with
OpenAI's own condition picks (read against the index OpenAI was actually
shown — a condition new to the expanded index comes only from the re-run). With no budget left, or if that call misses,
the possibilities fall back to the class index (host-specific conditions
for a host neither provider settled on are dropped). `internal.conditions`
records `host_union` and `corrected_host`; `internal.models.condition_rerun`
the extra leg.

## Admin-only `internal`

`internal.disagreed` / `internal.openai_answered` fold in the condition
combiner as well as every identity slot, so a symptom fallback caused by a
condition disagreement is explained. `internal.identity` (per slot
`{ disagreed, openai_answered }`, `trigger_reasons`, `lane`) and
`internal.conditions` (`disagreed`, `openai_answered`, `trigger_reasons`,
`host_union`, `corrected_host`) break the same flags out per scope;
`escalation_reasons` is the union. `internal.referee` (see the Referee
section below) is a separate top-level key — the per-slot `disagreed` /
`openai_answered` flags above already reflect a referee-settled outcome
(e.g. `disagreed: false` after the referee sides with one earlier read), but
never carry the referee's own diagnostics.

## The naming gate (§6.3)

A possibility is **named** (`answer.level: "entry"`) only when ALL hold: its
`required_signature.confirmable_by === "photo"`; every required element was
reported visible; verified confidence ≥ 0.55; and no other possibility with a
**different outcome class** (`no_cure`/`regulated` vs. everything else) reads
≥ 0.20 confidence (potassium deficiency next to lethal bronzing never
names either). `technician` / `lab` / `field_test` confirmability is never
named — those possibilities only ever appear in the `possibilities` list.
A **hard cap** (the tech-side lawn engine's own rule) caps wording at
`likely`, never `pretty_sure`, for the `turf-diseases` group, every
`disorder`, `drought-irrigation-stress`, and every pest possibility
(`isHardCapped`). Unapproved (`review.status !== "owner_approved"`, via
`isApproved`) entries never enter the condition index or an answer at all.
Every entry in the real catalog is owner-approved (pest 2026-09-27/28, plant
and condition 2026-09-28), so all of it can be named under the rules above;
an entry edited later drops out until it is approved again.

Every customer-visible string is a catalog field or one of the template
constants this module exports (`RETAKE_TEXT`, `TECHNICIAN_CONFIRM_TEXT`,
`LAB_CONFIRM_TEXT`, `REFERRAL_TEMPLATES`, `NEXT_STEP_TEMPLATES`,
`SYMPTOM_HEADLINES`, `UNUSABLE_HEADLINE`) — never model prose. The
`settle_it` picker (§6.5) walks: the top possibility's differential against
the second possibility (upgraded to a named customer field test when the
differential's own text names one) → the top possibility's own signature
(photo text / its first field test / a fixed technician-or-lab template) →
a fixed subject-specific retake prompt when there are no possibilities at
all.

## Reuse decision

Pure, section-agnostic helpers (`dedupeCandidates`, `sameCandidateKey`,
`isApproved`) are imported straight from `pest-engine.js`. `climbLineage` is
**not** reused: its own (unexported) `candidateNodeId` hardcodes
`sectionOf(group) === 'pest'` for an off-catalog group answer, which would
silently reject every off-catalog turf/weed/host climb, so this module has
its own `climbPlantLineage` (section-`'plant'`-aware, same algorithm). The
model-call orchestration (identity candidates/verify, condition selection,
escalation) is a new, plant-specific ladder — its shape (three identity
slots, a fifth condition-selection call, a new "different outcome classes"
escalation trigger) differs enough from the pest engine's two-call identity
ladder that lifting both into one shared `ladder.js` without risking pest
behavior was not attempted here; duplication is the documented trade-off
(§7 of the contract explicitly allows it).

**Known simplification for L4/first review to scrutinize**: unlike
`pest-engine.js`'s escalation combiner (many rounds of adversarial
hardening), a Gemini/OpenAI identity disagreement doesn't climb to a shared
lineage node for the WORKUP's `subject.plant` (it does for `mode: "identify"`,
via the pest engine's `deepestSharedNode` over the two providers' tops) — the workup schema has no group-level identity slot,
so a disagreed slot is simply left unnamed (`null`) rather than climbed. Two
pre-push Codex rounds (both zero P0, three P1 each) caught and fixed real
gaps: outcome-class checking was truncated to the display list, three
higher-confidence weeds could silently discard a valid turf candidate, the
identity verify response was never Ajv-validated, escalation
disagreement/non-answer never reached either builder, an unusable-photo read
from the conditions leg alone didn't gate naming, and identity resolution
accepted any catalog slug rather than restricting to its own slot — all six
now have regression tests in `plant-engine-v2.test.js`. Codex round 1 on
#5186 (9 P1, 5 P2) is covered by the sections above; its regression tests
are grouped under "Codex #5186 round 1 regressions" in the same file.

## Round 2 hardening (Codex #5186 r2)

- **Identify mode escalates on an empty read**: a schema-valid Call A that
  says the photos show a plant but raises no candidate in any lane the mode
  can answer from fires `no_identity_candidate`, so the second opinion runs
  before the customer gets an unknown.
- **Lane choice ranks eligibility first**: when both lawn lanes are
  populated, the lane with the better real answer wins (see "Identify mode"
  above; since round 5 the rank is read off the lane's built answer, not
  its top candidate alone), then confidence, turf on a tie — a verified
  turf at 0.85 beats an off-catalog weed guess at 0.95.
- **A workup stands on Call C alone**: identity legs and the escalation can
  all miss and the conditions leg's symptom/possibility workup is still
  returned (`subject.plant` null); identify mode, which has no Call C, still
  needs an identity or escalation envelope before it can answer.
- **Named plants carry their safety line and flags** (`entry.safety_line`,
  `entry.safety`, `entry.risk`, on identity entries and on workup weeds), so
  the card renders sago palm's, oleander's or spotted spurge's warning.
- **Pest possibilities carry a real `outcome`**: `regulated` when the pest's
  `safety.regulated` is true (it then joins the outcome-class naming guard
  and routes to the FDACS referral template), else `treatable`.
- **Identity results carry `catalog_version`**; **leg diagnostics record the
  answering model**; **a schema-invalid answer flips its ledger row**
  (`rejectCall`, reason `schema_invalid:<call>`).

## Round 3 hardening (Codex #5186 r3)

- Displayed workup possibilities carry `safety_line`, `safety` and `risk`
  (a workup has no separate `entry` payload).
- An identity whose catalog look-alike is `photo_can_confirm: false` never
  reads `pretty_sure` (`hasPhotoVetoLookAlike`); its next-photo card shows
  that pair's technician / time-based guidance.
- Several unapproved candidates of one group collapse into one masked row
  in the identity candidates block, with no locality badge.
- A `multiple_subjects` photo read blocks naming even when `usable: true`.
- A `plant_slug` chip counts toward the condition-index host union only
  when it names a plant in the subject's own host index.

## Round 4 hardening (Codex #5186 r4)

- Identify mode also escalates when a lane holds only candidates that
  resolve to no catalog node (an off-catalog guess with no valid group).
- The resolved host's group adds its class token (a tree_shrub request that
  resolves to a palm still sees the general `hosts: ['palms']` conditions).
- `signatureFor` reads the validator-guaranteed fields without fallbacks;
  `localAnnotationsFor` is a rule table (`LOCAL_FIT_RULES`); a blank
  `watering_days` chip never earns `fits_watering`.
- `PHOTO_ID_ESCALATE_BELOW` accepts only 0 < value <= 1 (else 0.80).
- Named plant identities carry `verdict_label`, `role`/`role_label`,
  `risk_label`, `action`/`action_label` for the identity card
  (`PLANT_ROLE_LABELS`, `PLANT_VERDICT_LABELS`; risk/action from the pest
  engine's maps).

## Round 5 hardening (Codex #5186 r5, and the pre-push audit on r4)

- One function, `identitySlotAnswer`, computes what an identity slot
  answers (named, climbed, or unknown). The identity builder, identify
  mode's lane choice and its `no_identity_candidate` trigger all read it,
  so a turf guess with no group (unknown) never beats a weed guess that
  climbs to its group, and the trigger fires exactly when every answerable
  lane would say unknown.
- A schema-valid Call C that selects nothing in the index (an empty list,
  or only slugs the index does not list) reads as confidence 0, so
  `low_confidence` fires and the OpenAI second opinion runs — the pest
  engine's rule for an empty read.
- `tier` follows the pest engine's rule in both modes (`answerTier`): only
  an entry-level answer is an `ai_suggestion`, and not even that when the
  pair that would settle it is one no photo can separate (identity
  `next_photo.photo_can_confirm: false`, workup `settle_it.photo_can_confirm:
  false`) — that answer is `needs_more_evidence`.
- The palm retake prompt asks for three views (whole palm, oldest fronds,
  newest fronds with the spear), matching the app's three guided palm shots
  and the 3-photo request limit.

## Round 6 hardening (Codex #5186 r6)

- An unnamed identity (a climbed group or category, or unknown) carries
  `generic_safety_line`, built only from fixed clauses
  (`UNNAMED_PLANT_SAFETY_CLAUSES`), each chosen when any plant under the
  answered node — reviewed or not — carries that hazard (medical risk →
  Poison Control, irritant sap → wash skin/eyes, toxic to pets → call the
  vet); an unknown answer is triaged over the subject's whole identity
  index. The pest engine's `unnamedSafetyLineFor` rule; its skin/eye and pet
  clauses are reused verbatim.
- Escalation triggers are tracked per scope (each identity slot, and the
  condition list). An unanswered or unavailable second opinion caps
  `pretty_sure` only in a scope that asked for it — a confidently verified
  turf keeps its wording when only the weeds escalated.
- `settle_it` finds the catalog comparison between the top two
  possibilities from either side (a one-way pair ranked "backwards"), a
  "photo can't settle this" side wins with its own wording, and either
  entry's field test can match it.
- An application with an unknown age (`null`, `''`, non-numeric, negative)
  never earns `fits_application`.
- An agreed identity keeps the score with the strongest provenance: a
  passed cue check > a completed check that found no cue > an unchecked
  guess (a completed check replaces an unchecked guess; only a passed check
  can raise a score).
- A Call A read of `usable: false` or `shows: "nothing"` ends the ladder:
  it is final under the conservative quality combine, so verify, Call C and
  the escalation are not called.

- Only contract §3 inputs are used or sent: `chips` keep the listed keys
  and `context` keeps `grass_type_on_file`, `irrigation_type` and
  `applications[{ kind, days_ago }]`, primitive values only (pre-push audit
  on r6). Anything else the caller passes — a customer record's name, phone
  or address, the app's free-text `plant_name` — never reaches a Gemini or
  OpenAI prompt.

## Round 7 hardening (Codex #5186 r7)

- The unnamed-identity line adds a puncture clause for the date palms
  (`date-palms` subgroup, genus Phoenix), whose spines the catalog states
  only in each entry's own `safety_line`; a real-catalog test fails if any
  plant's own safety line triggers no clause.
- An identity capped by a look-alike a photo cannot separate still gets
  "a photo can't settle this" guidance when that look-alike is a draft: the
  pest engine's fixed `NO_PHOTO_CONFIRMS` text (the pair's own text names
  the draft, so it stays hidden), never a retake prompt, and the tier stays
  `needs_more_evidence`.

## Photo-eval follow-ups (2026-09-28)

A 27-photo labeled eval (openly licensed photos, production models) named
18 of 27 exactly and listed 3 more correctly; the weak spot was lawn grass.
A textbook bahiagrass photo (Y-shaped seed heads) read "Likely:
Bermudagrass" with bahia as the runner-up, and no second opinion ran
because Gemini was confident. With the second opinion forced on, it read
bahiagrass.

- **Close calls escalate** (`close_call`): when the turf or host slot's top
  two catalog candidates share a group (two grasses, two palms) and the
  runner-up reads >= 0.20, the slot gets the OpenAI second opinion even at
  high confidence. An agreement keeps the name; a disagreement names neither
  — identify mode answers with the shared group ("Looks like a lawn grass"),
  and a workup leaves `subject.plant` unnamed — rather than a confident wrong
  name. The weeds slot is excluded: a lawn can hold several weeds at once,
  so two weeds are not rival answers.
- **Output budget 4096**: Gemini's reasoning shares the output budget with
  the JSON answer, and at 2048 one lawn read came back cut off (a miss).

## Referee (GATE_PLANT_ID_REFEREE, owner ruling 2026-09-29 — narrowed from 09-28)

Owner ruling 2026-09-28 replaced the 09-26 "Gemini → GPT-6 Astra, no Claude"
ruling **for the plant engine only** (the pest engine's `photoIdVision`
ladder in `pest-engine.js` / `pest-identification.js` is unchanged): the
plant engine's second opinion moved from `OPENAI_FRONTIER` (Astra) to
`OPENAI_PLANT_ID` (Sol) — `TEXT_POLICIES.plantIdVision`, unchanged by this
narrowing. Owner ruling 2026-09-29 then narrowed the referee itself: Claude
Fable 5.1 at effort `high` (`MODELS.ROUTES.plantIdReferee`) now breaks a
plant-**NAME** tie only. Ships DARK behind `GATE_PLANT_ID_REFEREE` (off
unless exactly `'true'`); off, the ladder is byte-identical to Gemini → Sol
with no third call.

`runReferee` runs AFTER `runEscalation` and AFTER the leg-failure check
(`legFailureReason`): a run with no usable vision leg returns its failure
first, so the billed referee call never runs for an answer that cannot be
returned. It then runs only when **the run is `identify` mode**, the prior
legs' combined photo read is neither unusable nor blocked, the
total budget (`PHOTO_ID_V2_TIMEOUT_MS`) has room for one more leg, and at
least one identity lane the subject actually uses
(`identifyLaneSlotsFor(subject)`: turf/weeds for a lawn, host for
tree_shrub/palm) came back **disagreed** (`identityFlags[slot].disagreed`
with a `disagreementPair`). `identifyPlantV2` skips the call entirely when
the combined prior read is already `blocked` (`namingGateFor(...).blocked`:
unusable, conflicting `shows`, or `multiple_subjects`) — a blocked identify
result discards every candidate, so the referee's vote could never surface
either way.

**Never a referee call for**: a workup (problem check) of any subject —
workups stay Gemini → Sol, always; a missing second opinion
(`blockPrettySure` with no disagreement); or a low-confidence AGREEMENT
(both providers named the same thing, just under-confident). Only a genuine
two-provider NAME split draws the call.

One call covers every disagreed lane at once — same photos, the same
`ESCALATION_SCHEMA` output (so the existing resolvers/validators apply
unchanged), with an appended "earlier reads" block (`buildRefereePrompt`)
naming each disagreed lane's first (Gemini) read and second (Sol) opinion
(slug + confidence) and asking the referee to look at the photos fresh,
since either earlier read may be wrong. The second read is exactly
`disagreementPair[1]` — `combineIdentity` already sets that pair to
`[geminiTop, openaiTop]`, i.e. Sol's own ranked top for that slot, never a
merged (Gemini+Sol) list's top.

**Merge (tie-break only, deterministic)**, per disagreed lane, `R` = the
referee's own top for that slot:

- `R` matches side `A` or `B` of `disagreementPair` → that side goes first,
  `disagreed: false`, `disagreementPair: null`; wording is capped at
  `likely` — a referee-settled split never reads `pretty_sure`. A match on
  an off-catalog side also requires the normalized `offCatalogName` to
  match (case/whitespace-insensitive) — `sameCandidateKey` alone (shared
  with the pest engine, never changed here) matches two off-catalog
  candidates by `groupId` only, so two different off-catalog names in the
  same group must not count as the same candidate for this tie-break.
- Anything else — a third name, no referee answer for that slot at all,
  schema-invalid, or unusable referee photos — leaves the lane **exactly**
  as the escalation left it: no append, no re-rank, no partial credit.
  `internal.referee.outcome[slot]` reads `'no_majority'` (a third name) or
  `'unavailable'` (no usable referee answer for that slot).
- The referee's own `quality`/`shows` verdict joins the conservative
  photo-quality combine (`photoReadFor`) only when its vote actually settled
  a lane. When it says the photos are unusable (`quality.usable === false`
  or `shows === 'nothing'`), its identity vote is not merged at all, every
  disagreed lane is left exactly as it was, and its quality read does not
  count either: a tie-break that changed nothing never downgrades the
  Gemini/Sol answer that stands.

Diagnostics land in `internal` only (never `v2`): `internal.models.referee`
(the leg, like every other model call) and `internal.referee: { triggered,
scopes, outcome }` — `outcome` maps each identity lane the referee actually
looked at to `'settled' | 'no_majority' | 'unavailable'`.

## What L4 must do

- Wire `identifyPlantV2` into `POST /api/photo-id/lawn` / `/tree_shrub`
  (both already ride `GATE_PHOTO_ID_V2`, on in prod).
- Store `v2` in the row's `result_v2` column (or equivalent additive
  column) and `internal` admin-only, same split as the pest engine.
- Map the workup's `next_step_hint.kind` to the existing `next_step` kinds
  (`specialist` → the existing `referral` kind, `inspection` → `inspection`,
  `fix_conditions`/`none` → `none`, `unclear` → `unclear`).
- Client card for the workup shape (separate from the existing pest/identity
  `V2Result` card) — possibilities list, `settle_it` card, next-step block.
- Chips UI (§3 of the contract) and admin rendering of `internal`.
- The plant/condition content is owner-approved (2026-09-28), so workups
  name possibilities as soon as L4 calls the engine — `isApproved` is read
  live, no code change needed.
