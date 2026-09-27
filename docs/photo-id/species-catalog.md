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
  it's an ant". Every group has a `generic` label and a `next_photo`: the one
  photo that would narrow it further.
- **Subgroup** (`fire-ants`, `widow-spiders`, `venomous-snakes`, 73 total,
  optional) — a narrower "we're sure it's a fire ant" stop between group and
  entry, for groups where that middle rung matters. Also has its own
  `generic` label and `next_photo`.
- **Entry** — a specific species (or a `sign`, like mud tubes or droppings,
  which points back at the organism entries it's a sign of via `sign_of`;
  a sign made by an animal with no catalog entry, such as woodpecker damage
  or hog rooting, has an empty `sign_of`).

Subgroups may name a same-group `parent` when a neutral shared taxon has
more specific situation nodes beneath it. `lineage(id)` includes every such
parent in order. `server/services/species-catalog.js` exposes it to walk this
ladder for any id, and `nextPhoto(id)` to get the one photo that would narrow
a category/group/subgroup/entry further.

When an unapproved entry climbs to a generic node, that node may carry
`generic_guidance`. It records safety and routing facts shared by every
descendant represented by that node; omitted compatibility fields keep the
neutral generic defaults. Ancestor guidance is merged with the selected
subgroup's overlay, including nested safety flags, without consulting any
descendant. An optional source-backed `safety_line` is customer-visible when
an unapproved medical-risk entry cannot be named. This keeps a generic result such as “a venomous
snake” on the high-urgency wildlife referral path without naming an
unapproved species. Mixed or lower-confidence results that stop above that
node do not inherit its guidance.
The subterranean and drywood termite subgroups retain structural-risk,
high-urgency termite inspection contracts; an answer at the broader termite
group keeps the shared termite service and moderate urgency without borrowing
a narrower structural-risk claim. Wasp and bee fallbacks keep their shared
stinging hazard without borrowing a species-specific treatment or referral.
Dedicated neutral subgroups retain special draft-only contracts when a
broader node has incompatible descendants. They cover regulated reporting,
protected-wildlife handling, exposure guidance, medically significant safety
flags, and no-service routing. Mixed or lower-confidence results stop above
those nodes and do not inherit the narrower referral, urgency, or hazard.
Singleton and uniformly benign generic nodes also retain source-backed
contracts that are true of all their descendants: carpenter ants keep
inspection-first moderate service, jumping spiders and orb-weavers keep
no-treatment routing, and stinging caterpillars keep Tree & Shrub Care plus
neutral rash guidance. The native-toad singleton keeps neutral pet-exposure
guidance. Cuban treefrog uncertainty stops at a dedicated child node that
keeps its neutral skin, airway, and pet-exposure guidance; a mixed result with
a native treefrog stops at the parent and cannot borrow those narrower facts.
The same rule applies to the catalog-wide generic audit: shared plant-care,
general-pest, bed-bug, no-treatment, and wildlife routing lives only on nodes
whose represented entries all support it. Source-backed bite, sting, skin,
airway, and pet-exposure advice uses draft-only child nodes when the broader
group contains entries with different risks. This lets an unnamed result keep
useful neutral guidance without attaching it to a mixed result.
Benign draft entries that share a broader node with treatable descendants
keep the conservative Pest Consultation fallback until the photo supports an
entry-level name; a no-treatment contract is not inferred from one candidate.

## Files

- `index.json` — `catalog_version`, `section` ("pest" — this catalog does not
  yet cover the lawn or tree & shrub photo ID sections), the five
  `categories`, the 29 `groups` and 73 `subgroups`, `look_alike_groups`
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
| `common_name`, `aka`, `aliases`, `scientific_name`, `rank` | `aliases` are lowercase, whole-word matchable; avoid short generic words |
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

The catalog currently has 73 owner-approved entries and 166 drafts. Runtime
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

## Cross-worker slugs (`planned_slugs`)

This catalog was built in parallel by three owners against a shared 239-slug
master list (see the build brief). All 239 entries are now built, so
`index.json#planned_slugs` is intentionally empty. The field remains the
explicit staging list for a future catalog expansion: the jest suite fails
if a look-alike points at a slug that is neither a built entry nor declared
there, and it also prevents a built entry from remaining on the staging list.

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
