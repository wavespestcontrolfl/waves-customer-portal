# Species catalog v1

`server/data/species-catalog-v1/` is the one species list meant to be shared by
the app's photo ID result, the website's `/pest-identifier/` pages, and the
identification engine (`server/services/pest-identification.js`), replacing
three separate lists that have drifted (the app/engine's 30-entry
`PEST_LIBRARY`, the website's 60-entry `pestIdentifier.ts`, and whatever the
next photo-ID feature would otherwise hardcode). Plan background:
`pest-identifier-scope-20260924.md` §3.1 and §9.

**This PR is data + pure code only.** Nothing here has a runtime caller yet —
no route, no gate, no change to existing behavior. `pest-identification.js`
and the live app are untouched. A later PR wires a caller and adds
`GATE_PHOTO_ID_V2` (see "Nothing reaches customers yet" below).

## The ladder: category → group → subgroup → entry

Every node in the catalog sits on a ladder from broad to specific, matching
how a photo ID app should behave when it isn't sure yet ("we're sure it's an
ant; we can't yet tell you which kind"):

- **Category** (`insect`, `arachnid`, `rodent`, `wildlife`, `other`) — the
  broadest bucket, with a generic label like "an insect".
- **Group** (`ants`, `termites`, `spiders`, `snakes`, 29 total) — "we're sure
  it's an ant". Every group has a `generic` label.
- **Subgroup** (`fire-ants`, `widow-spiders`, `venomous-snakes`, 74 total,
  optional) — a narrower "we're sure it's a fire ant" stop between group and
  entry, for groups where that middle rung matters. Also has its own
  `generic` label.
- **Entry** — a specific species (or a `sign`, like mud tubes or droppings,
  which points back at the organism entries it's a sign of via `sign_of`;
  a sign made by an animal with no catalog entry, such as woodpecker damage
  or hog rooting, has an empty `sign_of`).

Subgroups may name a same-group `parent` when a neutral shared taxon has
more specific situation nodes beneath it. `lineage(id)` includes every such
parent in order. `server/services/species-catalog.js` exposes it to walk this
ladder for any id.

**What an unnamed answer shows.** The engine names an entry only when it is
owner-approved and fact-check-clean. Any other answer (an unapproved
species, a spread of candidates, a disagreement, or an unknown) shows only
the engine's fixed templates in `server/services/photo-id-v2/pest-engine.js`:
one safe-distance retake prompt (`UNNAMED_NEXT_PHOTO`), or the fixed
technician guidance (`NO_PHOTO_CONFIRMS`) when the top candidate has a
look-alike no photo can separate, and, when any entry under the answered node
can bite, sting or irritate, is wildlife, is protected or is toxic to pets (or
when nothing was identified at all), one safety line assembled from fixed
`UNNAMED_SAFETY_CLAUSES`. The line is triaged for the node's worst member: a
venomous biter anywhere under it (snakes, widows, recluse) makes a bite an
emergency-care instruction, and every other hazard flag a member carries
(irritant, allergen, disease vector, toxic to pets, protected, a bat's unnoticed-contact risk, or a biting
wild mammal's rabies risk) adds its own fixed clause (`HAZARD_CLAUSES`), so
withholding a draft's prose never withholds its first aid. It carries no referral: the next step is the team,
or an inspection for a node whose every entry is inspection-first (termites,
rodents, bed bugs, carpenter ants). Its v1 columns are derived from every
entry under the node: any hazard flag one of them has, the highest urgency,
and a service line/key/label only when they all share it; inspection stays
v1's unmatched default. Nodes carry no prose of their own, so adding or
re-drafting a species can never make a group's text wrong for it.
`server/tests/species-catalog.test.js` checks this for every unapproved entry.

## Sections and planned plant/condition kinds (L1)

The top-level `"section": "pest"` key on `index.json` predates the catalog
having more than one section and stays for compatibility. Since the L1
loader PR, every **category** carries its own `section` (`pest` | `plant` |
`condition`), and everything under it inherits that section through the
usual ladder (category → group → subgroup → entry):

- `plant` (generic "a plant") holds six new groups — `turfgrasses`,
  `broadleaf-weeds`, `grassy-weeds`, `sedges`, `palms`, `shrubs-trees` — for
  the kinds `turfgrass`, `weed`, and `host_plant`.
- `condition` (generic "a lawn or plant problem we want a closer look at")
  holds seven new groups — `nematodes`, `turf-diseases`,
  `ornamental-diseases`, `palm-diseases`, `nutrient-disorders`,
  `water-and-site`, `cultural-and-chemical` — for the kinds `organism`
  (nematodes only), `disease`, and `disorder`. Lawn nematodes (`nematodes`
  group, `sting-nematode` slug planned) keep `kind: "organism"` — the loader
  doesn't tie `kind` to `section` — but live in `condition`, not the pest
  `other` category: a nematode is never a photo identity (a soil assay is
  the only confirmation), so it must stay out of the pest engine's reach
  the same way every other condition does.
- Four new subgroups: `date-palms` and `fan-palms` under `palms`,
  `turf-nutrient` and `palm-nutrient` under `nutrient-disorders`.
- Seven new `site_categories`: "Lawn grasses", "Lawn weeds", "Palms",
  "Shrubs & trees", "Lawn problems", "Plant & palm problems", "Lawn & plant
  problems".

**L1 itself shipped no entry** — index + loader only, with
`server/data/species-catalog-v1/entries/` untouched and every field of every
existing (owner-approved) entry exactly what it was, since the approval hash
covers every authored field. L1b (below) landed the content.

**The pest engine reads only the pest section.** Every `species-catalog.js`
call site the pest engine and its route use —
`server/services/photo-id-v2/pest-engine.js`'s catalog index text,
`NODE_MEMBERS`, and the reverse look-alike scan, plus
`server/routes/photo-id.js`'s `INSPECTION_FIRST_NODES` build — call
`listEntries({ section: 'pest' })` instead of the unfiltered `listEntries()`.
L1b landed 119 plant/condition entries (kinds
`turfgrass`/`weed`/`host_plant`/`disease`/`disorder`, plus `sting-nematode`
whose kind stays `organism`) with none of them ever reaching the pest photo
ID prompt, its safety-line/`NODE_MEMBERS` computation, or its look-alike
scan — `server/tests/pest-engine-v2-v1-map.test.js` and the sanity check
below still pin the pest section at exactly `239`, scoped away from the new
content the same way `species-catalog.test.js` is (see "L1b" below).
`server/tests/pest-engine-v2.test.js`'s "L1: pest engine reads only the pest
section" describe block proves the filter with an injected plant-section
fixture entry, alongside a real-catalog check that the filtered and
unfiltered lists still match today. `species-catalog.js` also exports a
`sectionOf(nodeOrSlug)` helper for any other caller that needs a node's
section without walking `lineage()` itself.

Filtering the prompt alone doesn't bound what the model can *return*
(Codex #5143 r1 P2): a hallucinated or leaked slug/group id could still
resolve to a real, non-pest catalog node once plant/condition content
exists. `resolveCandidate` and `candidateNodeId` — the one place every
model-returned identifier (candidates, verify's merge-by-slug, and
escalation all route through them) becomes a catalog node — reject any
resolved node whose `sectionOf(...) !== 'pest'`, treating it exactly like an
off-catalog/unresolved candidate. Proven by the same describe block with a
model response that names a plant-section slug and group id directly.

`server/data/species-catalog-v1/index.json#planned_slugs` briefly staged the
lawn/plant build's 119 not-yet-built plant/condition slugs between L1 and
L1b (see "Cross-worker slugs" below); L1b built every one of them, so
`planned_slugs` is empty again.

## L1b: the lawn/plant content landed (119 entries, owner-approved 2026-09-28)

`entries/{turfgrasses,broadleaf-weeds,grassy-weeds,sedges,palms,shrubs-trees,
nematodes,turf-diseases,ornamental-diseases,palm-diseases,nutrient-disorders,
water-and-site,cultural-and-chemical}.json` now hold the 119 entries drafted
in `~/photo-id-lawn-plant-build-20260927/` (72 plant-section: 6 turfgrass +
29 weed + 37 host_plant; 47 condition-section: 24 disease + 22 disorder + 1
organism/sting-nematode). Total catalog: 358 (239 pest + 72 plant + 47
condition), `catalog_version: "2026-09-28.1"`.

**All 119 are owner-approved (owner, 2026-09-28: "approve all 119").** Each
carries `review.status: "owner_approved"` and an `approval_hash` over its
current content, set in one approvals PR after a safety pass on every
customer instruction (gloves for breaking stems with irritant sap, a
technician rather than a ladder for a palm's spear leaf, zoom rather than
approach for the spiny date palms). The pest engine still refuses any node
outside `section: 'pest'` (PR #5143); the plant engine (L3, #5186) names this
content, but nothing calls it until the L4 route PR, which is the go-live.

### The `plant` object (required exactly for `turfgrass`/`weed`/`host_plant`)

```json
"plant": {
  "type": "sedge",                       // broadleaf | grassy | sedge | turf | palm | shrub | tree | cycad | vine
  "life_cycle": "perennial",             // annual_warm | annual_cool | perennial
  "spreads_by": ["tubers", "rhizomes"],  // seed | stolons | rhizomes | tubers | runners | offsets | n/a (1+)
  "id_cues": ["Triangular stem — roll it between your fingers", "…"],  // 2-5, ≤140 chars each
  "common_problems": [],                 // turfgrass/host_plant: 2-8 real catalog slugs; weed: []
  "frond_pattern_note": null             // palms only, ≤200 chars; null for every other group
}
```

`id_cues` are the plant-only visible features a photo can show (may repeat
`traits`). `common_problems` drives the engine's condition index for
turfgrass and palms — every slug must resolve to a real catalog entry (pest
or plant/condition). `look_alikes` (1-3, from the shared schema) are required
for every plant kind, same as a pest organism.

### The `condition` object (required exactly for `disease`/`disorder`, and for `sting-nematode`)

```json
"condition": {
  "hosts": ["turf"],                     // 1+: turf | palms | shrubs | trees | citrus | a plant-kind slug
  "signs": ["Circular to irregular patches with a yellow-to-orange outer ring"],   // 0-5, ≤140 each
  "symptoms": ["Thinning inside the patch; turf may recover from the center"],     // 0-5, ≤140 each — signs+symptoms together non-empty
  "required_signature": {
    "text": "A close-up of the patch margin showing the orange ring…",  // ≤240
    "elements": ["Circular to irregular patches with a yellow-to-orange outer ring"],  // 1-4, ≤120 each; each must equal a signs/symptoms item verbatim when confirmable_by is "photo" (the engine matches by exact text)
    "confirmable_by": "photo"            // photo | field_test | technician | lab
  },
  "field_tests": [
    { "name": "Tug test", "who": "customer", "how": "…", "reads_as": "…" }
    // confirmable_by "field_test" requires >=1 of these; "technician"/"lab" requires service.inspection_first: true
    // customer tests are a fixed allowlist: Tug test, Plug pull, Soap flush, Footprint test, Irrigation can test, Water response check — anything with a product/tool/chemical is "technician"
  ],
  "differentials": [
    { "slug": "take-all-root-rot", "difference": "…", "next_observation": "…", "photo_can_confirm": true }
    // 1-4; never self; every slug resolves to a real catalog node; reciprocal
    // within this folder (A lists B => B lists A) — pest-side reciprocity is
    // a later sidecar, not an edit to an approved pest entry
  ],
  "site_factors": ["frequent_irrigation", "poor_drainage", "high_n"],  // from the fixed 19-value enum
  "outcome": "manageable",               // treatable | manageable | cultural_fix | no_cure | regulated
  "recovery_note": "Treatment stops the spread first; browned turf regrows over weeks to months."  // ranges only, never a bare day count
}
```

`outcome: "no_cure"` (lethal bronzing, lethal yellowing, Ganoderma butt rot,
Fusarium wilt of palms, citrus greening) forbids `service.line: "lawn"`,
forbids treat/treatment/treated/control/cure/spray anywhere in the customer-
facing text, and requires `action` `specialist` or `fix_conditions`.
`outcome: "regulated"` requires a verified FDACS/USDA source in `sources`.
Nematodes (`sting-nematode`) carry `photo_can_confirm: false` everywhere in
their differentials — a soil assay a technician collects is the only
confirmation, never a photo.

### Shared-schema deltas for this content

`service.key` is `null` for every one of the 119 entries — owner decision 4
(2026-09-27) routes turf conditions to Lawn Care but auto-prices nothing, so
nothing here prices anything automatically. Disorders (abiotic conditions) carry
`scientific_name: null` and `rank: "condition"`; every other plant/condition
kind carries a real taxon like every pest entry. `size` is omitted (plants
and conditions carry no size; organisms, including sting-nematode, still do).
Customer copy carries the same Revision 2/3 bans as pest entries, plus:
never recommend fertilizing (the Jun 1 – Sep 30 county blackout — say "a
technician times any nutrition within the local fertilizer rules"), never say
"certified" (say "trained"), never "organic-only", and no product/brand/
active-ingredient name, rate, or FRAC/HRAC/IRAC code anywhere, including
`tech_notes`.

**Verification policy.** `verification` holds only claims the customer copy
or a safety flag actually asserts and that could not be verified against a
cited source — never a general sourcing gap or an estimate. Best-estimate
fields (`range`, `active_months`/`peak_months`) plus a `review.notes` line
are the honest record for county-level prevalence; sourcing gaps, per-photo
judgment calls, and process notes belong in `review.notes`, not
`verification`. The owner's review page reads both.

Full field-by-field rules (enums, length limits, the reciprocity check) live
in `~/photo-id-lawn-plant-build-20260927/BRIEF-PLANTS.md` and are mirrored as
jest assertions in `server/tests/species-catalog-plants.test.js`.

### Content changes made to pass the repo's own tests

Two aliases collided with unrelated content and were removed (the entries
otherwise match the drafted content exactly): `centipedegrass`'s bare
`"centipede"` alias (collided with the pest catalog's `many-legged` group
alias — "centipede grass" and "centipedegrass" remain) and
`phytophthora-root-rot`'s bare `"phytophthora"` alias (collided with
`palm-bud-rot`, a different disease sharing the same genus, in a different
group — "phytophthora root rot" and "root rot" remain). `sting-nematode`'s
differential against `white-grub` had `photo_can_confirm: true` on a step
that actually confirms/rules out the grub, not the nematode; corrected to
`false` per "nematodes: photo_can_confirm false everywhere" (BRIEF-PLANTS.md
copy rule 9).

## Files

- `index.json` — `catalog_version` (`2026-09-28.1`), `section` ("pest" — kept
  for compatibility; see "Sections and planned plant/condition kinds" above
  for what changed), the seven `categories` (five pest + `plant` +
  `condition`), the 42 `groups` and 79 `subgroups`, `look_alike_groups`
  (group-level look-alike notes,
  e.g. ants vs. termites), `legacy_slug_map` (every v1 `PEST_LIBRARY` slug →
  a v2 catalog node, plus the lawn scorer's 4 `grass_type` values — see
  below), and `planned_slugs` (empty — see "Cross-worker slugs" below).
- `entries/<group>.json` — one JSON array per **group** (not per subgroup),
  e.g. `entries/ants.json` holds every ant entry regardless of which ant
  subgroup it's in. The catalog ships 358 entries: 239 pest (the original
  build brief) + 119 lawn/plant entries (L1b — 72 plant + 47
  condition), all owner-approved. The loader merges every file in the directory, so **adding a
  species never requires touching the loader**.

## How to add a species

1. Pick its `group` (and `subgroup`, if the group has one that fits) from
   `index.json` — the ids are fixed; don't invent a new one without updating
   the shared brief.
2. Add one object to the right `entries/<group>.json` file (create the file
   if the group has no entries yet), following the schema below. Keep
   `slug`s and cross-references (`look_alikes`, `sign_of`) consistent with
   the shared build brief's master slug list if you're working from it.
3. Run the suite (`npm exec jest -- server/tests/species-catalog.test.js
   --runInBand`) — it will fail loudly on a bad enum, a look-alike pointing
   nowhere, a missing safety line, or forbidden customer copy (prices,
   guarantees, timing promises).
4. Leave `review: { status: "draft", notes: "..." }` — nothing here is
   customer-facing until the owner reviews it (see below).

### Entry schema (summary — the full field rules are in the shared build
brief; the jest suite enforces them)

| field | notes |
|---|---|
| `slug`, `kind` | `kind` is `organism` or `sign`; a `sign` needs `sign_of` |
| `common_name`, `aka`, `aliases`, `scientific_name`, `rank` | `aliases` are lowercase, whole-word matchable; avoid short generic words. A nickname (`aliases`, `aka`) resolves to its entry only when it spells one of the entry's own names (the common name, a name in its parenthetical, a scientific name) or qualifies the common name keeping every word ("tomato hornworm" for Hornworm); any other nickname resolves to the entry's group. A bare genus resolves to the deepest node holding every catalog entry of that genus (never a single species; an entry that is itself the genus, "Phyllophaga spp.", keeps it) |
| `group`, `subgroup`, `site_category` | must resolve against `index.json` |
| `traits` (3–5) | visible features only, most decisive first, ≤140 chars each |
| `look_alikes` (1–3) | `difference` ≤160 chars, `next_photo` ≤180 chars, one visible tell; `photo_veto_applies_to` may scope a false confirmation veto to `sign` or `organism` photos |
| `size`, `where`, `looks`, `verdict` | fixed enums — see brief |
| `safety` (9 booleans) + `safety_line` | line required whenever any of stings/venomous/disease_vector/toxic_to_pets/protected/regulated is true |
| `range`, `active_months`, `peak_months` | Southwest Florida (Manatee/Sarasota/Charlotte/Lee/Collier) specific |
| `service` | hard rules: termites are suggestive-only; honey bees are `bee_relocation` referral; rodents and bed bugs are inspection-first; wildlife groups never auto-price (`key: null`); venomous snakes are `call` + `wildlife_trapper` |
| `urgency` | kept for the current engine's reports |
| `copy.what_it_means` (≤320), `copy.fact` (≤240), optional `copy.blurb` | **customer-facing strings must come from here, never hardcoded in a route or component** — no prices, no guarantees, no response-time promises |
| `tech_notes` | internal only, no product names/rates |
| `links.site_page`, `links.guides` | `site_page` only for the 60 entries with a live website page |
| `legacy_slugs`, `sources`, `review` | `owner_approved` reviews carry a SHA-256 `approval_hash`; see below |

All 239 pest catalog entries are owner-approved (`house-centipede` was the
last, on 2026-09-28 after its range fact-check closed), and so are the 119
lawn/plant entries L1b added (owner, 2026-09-28; see "L1b" above) — 358 of
358. Runtime
naming requires all three conditions: `review.status` is `owner_approved`, the
`verification` list is empty, and `review.approval_hash` matches the stable
hash of every authored entry field. `review` metadata and the loader-injected
`level` are the only excluded fields. Editing identity, aliases, traits,
look-alikes, safety, copy, service, sources, or any other authored field makes
the stored approval stale and the engine climbs to a generic catalog node.

The approval-hash migration compared approval-bound content against the
three commits that recorded the real owner decisions: `f05b815b4c` (52
website entries), `c5e8e2f86f` (7 more website entries), and `bbe617e26a`
(the review-backup decisions for the 179-entry expansion). Of the 74 entries
still marked approved before migration, 73 matched their first trusted
approved snapshot exactly. `bagworm` had since gained `not_matches`, so it
was downgraded to draft rather than receiving a hash for changed content.
The machine-readable comparison record is
[`species-catalog-approval-migration.json`](./species-catalog-approval-migration.json).

## The v1 → v2 legacy slug map

`server/services/pest-identification.js` has its own fixed 30-entry
`PEST_LIBRARY` allowlist that the live app and public pest-identifier funnel
read today. `index.json#legacy_slug_map` maps every one of those v1 slugs to
a v2 catalog node — an entry, a subgroup, or a group — so a later PR can
translate between the two without re-deriving the mapping. A plural or
umbrella v1 entry (`mosquito`, `tick`, `rodent`, `whitefly`, `aphid-scale`,
`black-widow`, `sod-webworm`, `honey-bee`) maps to the group or subgroup that
doesn't over-claim a specific species the v1 entry never actually
distinguished; `beneficial` maps to `null` (v1 lumped together several
unrelated species with nothing in common but "leave it alone") with a note
for the caller to keep its own fallback copy for now. Read a mapping with
`species-catalog.js`'s `resolveLegacySlug(v1Slug)`.

The lawn/plant build brief proposed adding the Waves app's lawn scorer
`grass_type` values (`st_augustine`, `bahia`, `zoysia`, `bermuda`) to this
map, targeting the turfgrass entries. L1 deferred that (no turfgrass entry
existed yet to resolve to, and `getNode()` has no notion of a `planned_slugs`
placeholder). L1b added all four now that the entries exist:
`st_augustine` → `st-augustinegrass`, `bahia` → `bahiagrass`,
`zoysia` → `zoysiagrass`, `bermuda` → `bermudagrass`, each resolving through
`getNode()` like every other legacy mapping.

## Cross-worker slugs (`planned_slugs`)

The pest catalog was built in parallel by three owners against a shared
239-slug master list (see the pest build brief), and all 239 of those
entries are built — none of them are on `planned_slugs` today, and the jest
suite fails if one ever is.

The L1 loader PR (plant/condition sections) reused this same mechanism for
the parallel lawn/plant build: `index.json#planned_slugs` briefly staged that
build's 119 not-yet-built plant and condition slugs (from
`~/photo-id-lawn-plant-build-20260927/slugs.tsv`), so a look-alike or
`common_problems`/`differentials` reference into that batch validated before
the content itself landed. L1b built every one of those 119 slugs (see "L1b"
above), so `planned_slugs` is `[]` again — the jest suite's rule is
unchanged: a look-alike must point at a built entry, and a built entry may
never remain on the staging list.

## Nothing reaches customers yet

This catalog is dark: its only caller ships behind a gate that defaults off.
Before any part of it reaches a customer — the app's result card, the
website's `/pest-identifier/` pages, or anywhere else — these need to happen:

1. Wire an actual caller behind a dark gate. Done for the Waves app's pest
   Photo ID only: `GATE_PHOTO_ID_V2` (off unless exactly `true`) sends
   `POST /api/photo-id/pest` through `identifyPestV2` and serves the stored v2
   answer back on `GET /api/photo-id/pest/:id` and the history list. The
   website's `/pest-identifier/` pages and SMS photo triage are still v1.
2. Have the owner review each remaining draft's complete authored content.
   Record `review.status: "owner_approved"` and the matching `approval_hash`
   only from that real decision; never copy a hash from another revision or
   mint approval as part of an unrelated species edit.
3. Confirm the hard service rules (termite suggestive-only, honey bee
   referral, rodent/bed bug inspection-first, wildlife never auto-priced,
   protected-turtle no-treatment routing, venomous-snake handling) still read
   correctly once real customers can see them — the jest suite enforces the
   rules mechanically, but it can't judge tone.
