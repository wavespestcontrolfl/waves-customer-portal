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
const { ok, v2, internal, error } = await identifyPlantV2({
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
kind: "identity", answer, entry, evidence: { matches, still_need },
candidates, next_photo, quality }`) for Layer A only, so the existing
`V2Result` card renders its "What matches" / "What we still need to see"
sections; that evidence (and the next-photo pair) is read only from the
candidates that support the chosen answer node, never from a top candidate
outside the group the headline names. The one identity lane is the host for `tree_shrub`/`palm`; for a
lawn it is whichever of turf and weeds the photos populated, and when both
are populated the one whose top candidate has the higher verified
confidence (turf on a tie) — a photo of a weed returns the weed, not an
empty turf answer. `internal.identity.lane` records the choice.

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
`escalation_reasons` is the union.

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
`isApproved`) entries never enter the condition index or an answer at all —
today's real catalog is **100% draft** for `plant`/`condition` content, so a
real-catalog workup is symptom-only with zero named possibilities; the
catalog's `pest` section is 100% owner-approved, so lawn/tree_shrub pest
possibilities (chinch bug, white grub, …) already show up and can be named
at `likely`.

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
- As soon as any `plant`/`condition` catalog entries clear owner review, the
  workup stops being symptom-only automatically — no code change needed
  here, since `isApproved` is read live.
