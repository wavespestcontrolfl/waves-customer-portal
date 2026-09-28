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
  "referral": null, "quality": { "usable": true, "issue": "none" }
}
```

`mode: "identify"` returns the pest identity-card shape instead (`{ version,
kind: "identity", answer, entry, candidates, next_photo, quality }`) for
Layer A only (turf, one weed, or a host plant).

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
via `climbPlantLineage`) — the workup schema has no group-level identity slot,
so a disagreed slot is simply left unnamed (`null`) rather than climbed. Two
pre-push Codex rounds (both zero P0, three P1 each) caught and fixed real
gaps: outcome-class checking was truncated to the display list, three
higher-confidence weeds could silently discard a valid turf candidate, the
identity verify response was never Ajv-validated, escalation
disagreement/non-answer never reached either builder, an unusable-photo read
from the conditions leg alone didn't gate naming, and identity resolution
accepted any catalog slug rather than restricting to its own slot — all six
now have regression tests in `plant-engine-v2.test.js`.

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
