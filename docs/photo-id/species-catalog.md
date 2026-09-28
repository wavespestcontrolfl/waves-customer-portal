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

**No entry exists for any of this yet.** This PR is index + loader only —
`server/data/species-catalog-v1/entries/` is untouched, and every field of
every existing (owner-approved) entry is exactly what it was, since the
approval hash covers every authored field. The plant/condition entry schema
(the `plant` and `condition` objects: `id_cues`, `common_problems`,
`required_signature`, `differentials`, `outcome`, …) is specified in full in
the lawn/plant build brief, not repeated here — see
`~/photo-id-lawn-plant-build-20260927/BRIEF-PLANTS.md`. A later PR (L1b)
copies the build folder's drafted entries into `entries/<group>.json` once
the owner has reviewed them, the same way the pest catalog's content landed.

**The pest engine reads only the pest section.** Every `species-catalog.js`
call site the pest engine and its route use —
`server/services/photo-id-v2/pest-engine.js`'s catalog index text,
`NODE_MEMBERS`, and the reverse look-alike scan, plus
`server/routes/photo-id.js`'s `INSPECTION_FIRST_NODES` build — call
`listEntries({ section: 'pest' })` instead of the unfiltered `listEntries()`.
Today that's a no-op (all 239 entries are pest-section, so the filtered and
unfiltered lists are identical — `server/tests/pest-engine-v2-v1-map.test.js`
and the sanity check below both pin `239`), but once plant/condition content
lands, an entry of kind `turfgrass`/`weed`/`host_plant`/`disease`/`disorder`
will never reach the pest photo ID prompt, its safety-line/`NODE_MEMBERS`
computation, or its look-alike scan.
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

`server/data/species-catalog-v1/index.json#planned_slugs` also changed
contract here: it now stages the lawn/plant build's 119 not-yet-built
plant/condition slugs (see "Cross-worker slugs" below) — a non-empty
`planned_slugs` is no longer itself a sign of unfinished pest work, only of
unbuilt plant/condition work.

## Files

- `index.json` — `catalog_version`, `section` ("pest" — kept for
  compatibility; see "Sections and planned plant/condition kinds" above for
  what changed), the seven `categories` (five pest + `plant` + `condition`),
  the 42 `groups` and 79 `subgroups`, `look_alike_groups`
  (group-level look-alike notes,
  e.g. ants vs. termites), `legacy_slug_map` (every v1 `PEST_LIBRARY` slug →
  a v2 catalog node — see below), and `planned_slugs` (see "Cross-worker
  slugs" below).
- `entries/<group>.json` — one JSON array per **group** (not per subgroup),
  e.g. `entries/ants.json` holds every ant entry regardless of which ant
  subgroup it's in. The catalog currently ships all 239 entries from the
  shared build brief. The loader merges every file in the directory, so
  **adding a species never requires touching the loader**.

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

All 239 catalog entries are owner-approved (`house-centipede` was the last,
on 2026-09-28 after its range fact-check closed). Runtime
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
map, targeting the planned turfgrass slugs. L1 deferred that: every existing
`legacy_slug_map` target with a non-null `node` must resolve through
`getNode()` to a real, already-loaded node (`species-catalog.test.js`'s
"every legacy_slug_map target resolves to a real node, or is documented
null"), and `getNode()` has no notion of a `planned_slugs` placeholder — it
only knows built groups, subgroups, entries, and categories. Making the
loader treat an unbuilt planned slug as a resolvable legacy target would be
new machinery this PR doesn't need (no plant entry exists to resolve to
yet), so the four `grass_type` mappings are left for L1b, once the
turfgrass entries themselves exist.

## Cross-worker slugs (`planned_slugs`)

The pest catalog was built in parallel by three owners against a shared
239-slug master list (see the pest build brief), and all 239 of those
entries are built — none of them are on `planned_slugs` today, and the jest
suite fails if one ever is.

The L1 loader PR (plant/condition sections) reused this same mechanism for
the parallel lawn/plant build: `index.json#planned_slugs` now also stages
that build's 119 not-yet-built plant and condition slugs (from
`~/photo-id-lawn-plant-build-20260927/slugs.tsv`), so a look-alike or
`common_problems`/`differentials` reference into that batch validates before
the content itself lands (L1b copies the drafted entries into
`entries/<group>.json` once the owner reviews them — see "Sections and
planned plant/condition kinds" above). The jest suite's rule is unchanged:
a look-alike must point at either a built entry or a declared `planned_slugs`
placeholder, and a built entry may never remain on the staging list — only
the read that a non-empty `planned_slugs` implies unfinished work changed
(it's no longer "unfinished pest work", it's "plant/condition content not
built yet").

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
