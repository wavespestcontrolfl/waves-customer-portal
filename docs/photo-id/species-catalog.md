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
- **Subgroup** (`fire-ants`, `widow-spiders`, `venomous-snakes`, 36 total,
  optional) — a narrower "we're sure it's a fire ant" stop between group and
  entry, for groups where that middle rung matters. Also has its own
  `generic` label and `next_photo`.
- **Entry** — a specific species (or a `sign`, like mud tubes or droppings,
  which points back at the organism it's a sign of via `sign_of`).

`server/services/species-catalog.js` exposes `lineage(id)` to walk this
ladder for any id, and `nextPhoto(id)` to get the one photo that would narrow
a category/group/subgroup/entry further.

## Files

- `index.json` — `catalog_version`, `section` ("pest" — this catalog does not
  yet cover the lawn or tree & shrub photo ID sections), the five
  `categories`, the 29 `groups` and 36 `subgroups` (ids are fixed by the
  shared build brief), `look_alike_groups` (group-level look-alike notes,
  e.g. ants vs. termites), `legacy_slug_map` (every v1 `PEST_LIBRARY` slug →
  a v2 catalog node — see below), and `planned_slugs` (see "Cross-worker
  slugs" below).
- `entries/<group>.json` — one JSON array per **group** (not per subgroup),
  e.g. `entries/ants.json` holds every ant entry regardless of which ant
  subgroup it's in. This PR ships the 60 entries already live on the website
  (owner "A" in the shared build brief's slug list); later PRs add more
  `entries/*.json` files, or append more entries to an existing one — the
  loader merges every file in the directory, so **adding a species never
  requires touching the loader**.

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
| `look_alikes` (1–3) | `difference` ≤160 chars, `next_photo` ≤180 chars, one visible tell |
| `size`, `where`, `looks`, `verdict` | fixed enums — see brief |
| `safety` (9 booleans) + `safety_line` | line required whenever any of stings/venomous/disease_vector/toxic_to_pets/protected/regulated is true |
| `range`, `active_months`, `peak_months` | Southwest Florida (Manatee/Sarasota/Charlotte/Lee/Collier) specific |
| `service` | hard rules: termites are suggestive-only; honey bees are `bee_relocation` referral; rodents and bed bugs are inspection-first; wildlife groups never auto-price (`key: null`); venomous snakes are `call` + `wildlife_trapper` |
| `urgency` | kept for the current engine's reports |
| `copy.what_it_means` (≤320), `copy.fact` (≤240), optional `copy.blurb` | **customer-facing strings must come from here, never hardcoded in a route or component** — no prices, no guarantees, no response-time promises |
| `tech_notes` | internal only, no product names/rates |
| `links.site_page`, `links.guides` | `site_page` only for the 60 entries with a live website page |
| `legacy_slugs`, `sources`, `review` | see below |

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
master list (see the build brief). This PR ships only the ~60 entries owned
by "A" (the website's existing species). A look-alike may legitimately point
at a species another owner is building in the same batch but that doesn't
exist as a built entry yet — `index.json#planned_slugs` is the list of every
slug the other owners are responsible for. The jest suite fails if a
look-alike points at a slug that is neither a built entry nor in
`planned_slugs` — so a typo or a genuinely missing species is caught, while
a legitimate cross-reference to work in flight is not. A later PR that adds
those entries should remove them from `planned_slugs` as it goes; the list
should reach empty once the full 239-slug catalog is built.

## Nothing reaches customers yet

This catalog is dark: it has no route, no UI, and no gate. Before any part of
it reaches a customer — the app's result card, the website's
`/pest-identifier/` pages, or anywhere else — a later PR needs to:

1. Wire an actual caller (the app result card, the engine's alias resolution,
   or both) and add `GATE_PHOTO_ID_V2` (or similar) so the wiring itself ships
   dark first.
2. Have the owner review every entry's `verdict` and `safety_line` — this PR
   authored them carefully from UF/IFAS, FWC, and FDACS sources, but they are
   still `review.status: "draft"` and have not had an owner pass. Flip
   `review.status` to `"reviewed"` (or similar) as part of that pass, not as
   part of adding new species.
3. Confirm the hard service rules (termite suggestive-only, honey bee
   referral, rodent/bed bug inspection-first, wildlife never auto-priced,
   venomous-snake handling) still read correctly once real customers can see
   them — the jest suite enforces the rules mechanically, but it can't judge
   tone.
