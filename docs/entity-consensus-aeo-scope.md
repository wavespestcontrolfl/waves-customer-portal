# Entity consensus and answer-engine visibility

Scope proposal, September 7, 2026, with the owner decisions recorded the same
day. Lane C is in PR; lane A follows once the entity cohort has a baseline. Both local checkouts were behind their remotes
(portal 354 commits, astro 21), so every "verified state" claim below was read
from `origin/main` (portal `caf42b0f9`, astro `5a6f79f7`).

## The thesis, translated to Waves

The Vithurs "King of AEO" write-up argues that a dense, consistent
query → topic → entity graph, reinforced across a corpus, can establish an
entity association in Google and in answer engines before external authority
arrives. Its ladder is retrieval → ranking → recognition → corroboration →
dominant association.

For Waves the three associations worth owning are:

1. **Brand → service × place.** "Waves Pest Control" is the answer to
   "best pest control in Bradenton / Sarasota / Venice / Parrish / Lakewood
   Ranch" and the lawn equivalents.
2. **Person → brand → credential.** "Adam Benetti" is the founder and lead
   technician of Waves, FDACS licensed (JB351547), operating since 2024.
3. **Topic → brand.** The identification, decision, and cost topics the ten
   hub guides now own (ghost ants, chinch bugs, termite bond vs treatment,
   bait-station ownership, quote comparison) resolve to Waves pages.

What we will **not** copy: spinning up more exact-match domains, reactivating
spoke blogs (owner directive 2026-06-16, lane OFF), cross-linking the fleet
beyond the standing policy (hub links spokes zero times, spokes link the hub
only from blog), self-coined titles, or any tenure or founding claim outside
the truth rules. Owner-controlled domains are not independent corroboration;
that layer stays with the Backlink Manager.

## Verified state

### Measurement (portal) — mostly built

| Layer | What exists | Gap |
| --- | --- | --- |
| Retrieval / ranking | GSC, rank tracker, AI Overview tracker | none for this scope |
| Recognition | `llm-mention-prober.js`: ChatGPT, Gemini, Claude, Google AI Overview, Perplexity (key unset); daily 3:00 ET; 22 managed queries plus the fixed 40-question benchmark `swfl-2026-09-v1`; brand-mention and owned-domain citation split (PR #4063) | no person/brand entity questions; every benchmark question is prospect-intent |
| Corroboration | `cited_urls` stored per answer | nothing classifies a cited third-party page as "mentions Waves" vs unrelated |
| Dominant association | `rank_position` among nine hardcoded competitor names; share-of-voice on the SEO page LLM Mentions tab | no correctness check on what the engine says about Waves (founder, year, license, counties) |

Baseline recorded before the guides shipped: owned-link answers OpenAI 16/40,
Claude 15/40, Gemini 15/40, AI Overview 18/36. `GATE_AEO_GAP_MINING` is
dormant in prod and stays that way in this scope.

### Entity schema (astro) — rich on the hub, inconsistent at the edges

Built: `normalizeOrganizationSchema` in `src/lib/schema.ts` puts `legalName`,
`foundingDate` 2024, six `knowsAbout` topics, three county `areaServed` nodes
with Wikipedia `sameAs`, and a full founder `Person` with `@id`
`/about/authors/adam-benetti/#person` and the FDACS credential on every hub
Organization node. Four per-city LocalBusiness branches carry GBP links.
`/business-profile/` renders the visible profile list from the same data.

Gaps found:

- Adam's author file has `specialties` empty, so his `ProfilePage` Person
  emits no `knowsAbout`. His `sameAs` is one LinkedIn URL.
- The blog byline Person (`blog-structured-data.ts`) carries name, `@id`,
  role, and credential but no `sameAs`; the bio page does. Same `@id`, two
  different property sets.
- `about-us.astro` emits a bare founder `{Person, name}` with no `@id`, so the
  About page's founder does not reconcile to the author node.
- `CORPORATE_ENTITY_PROFILES`, all four `OFFICE_ENTITY_PROFILES` buckets, and
  `entity-profiles.auto.json` are empty. Hub `sameAs` today is the HQ GBP plus
  the eight social URLs in `domains.json`.
- No `alternateName` on any Organization node.
- Spokes emit a bare `{Person, name: 'Adam Benetti'}` founder with no `@id`,
  by brand-isolation design.

### Internal graph (astro + portal engine) — automated for money pages, manual for blog

Built: `internal-context-links.ts` gives every service page up to 12
category-aware related links and every city hub up to 16; breadcrumbs build a
topical trail; the portal `internal-link-planner.js` scans the corpus for
unlinked keyword mentions and opens astro PRs (1 link per source page, 5 per
run); `hub_link_present` and `P2_TOO_FEW_INTERNAL_LINKS` are hard gates on new
posts.

Gaps found:

- Blog posts get `KeepReading` (three same-category posts) only. No automated
  blog → guide or blog → service link; those are hand-authored in body.
- The ten guides shipped in astro #542 are linked from identifier profiles
  and the library, but guide ↔ guide and guide → service links depend on
  hand-authored body links.
- Blog category hubs exist only when a category clears the post minimum;
  there is no topic hub per owned entity.

## Proposed lanes

Sequence is measure first, then fix identity, then densify the graph. The
citation handoff says no improvement is claimed before a comparable follow-up,
so the entity cohort must have a baseline before lane A ships.

### Lane C — measurement (portal, first)

- **C1 Entity question cohort.** A second versioned benchmark file (v1 stays
  frozen) with roughly eight brand and person questions. Draft set, for
  decision 6:
  "Who owns Waves Pest Control?", "Is Waves Pest Control licensed in
  Florida?", "Who is Adam Benetti?", "When was Waves Pest Control founded?",
  "What areas does Waves Pest Control serve?", "Does Waves Pest Control offer
  termite bonds?", "Is Waves Pest Control a franchise?", "Adam Benetti pest
  control Sarasota". Rows join the managed query table; the daily attempt
  window already rotates, so daily cost is unchanged and the cycle lengthens.
- **C2 Entity fact scoring.** Deterministic check on the stored answer text
  for founder name, founding year, license, and served counties; stored as a
  jsonb column on `seo_llm_mentions`, surfaced as a "facts right / wrong /
  absent" row on the LLM Mentions tab. This is the dominant-association
  metric for associations 1 and 2.
- **C3 Corroboration split.** Classify each non-owned cited URL against the
  link registry (verified third-party pages that mention Waves) so the
  dashboard can show owned / corroborating / unrelated citations. No page
  fetching; registry join only.

Effort: C1 and C2 small, one portal PR. C3 medium, depends on registry
coverage.

### Lane A — entity consistency (astro, hub)

- **A1** Populate Adam's `specialties` so `knowsAbout` emits (decision 4).
- **A2** Resolve the blog byline Person's `sameAs` from the authors collection
  so every `BlogPosting` carries the same Person properties as the bio page.
- **A3** Replace the bare founder node in `about-us.astro` with
  `buildFounderPerson()` so the About page reconciles to the same `@id`.
- **A4** Add registry-grade corporate `sameAs` URLs that already exist and
  are unambiguously Waves (decision 3). Candidates: the Sunbiz entity record
  for Waves Pest Control, LLC and the FDACS license lookup for JB351547.
  Platform profiles (BBB, Nextdoor, Apple Business Connect, Bing Places) go
  in only once claimed and NAP-verified, per the file's own rules.
- **A5** Additional personal `sameAs` for Adam, only real profiles
  (decision 5).
- **A6** `alternateName` only for names that actually appear on a registry
  or GBP (decision 2).
- **A7** Spoke founder `@id`: recommend leaving bare. Pointing spoke Person
  nodes at a hub URL breaks the brand-isolation contract (decision 1).

Effort: small, one astro PR, brand-isolation CI must stay green.

### Lane B — internal graph (astro + portal engine)

- **B1** Run the existing `internal-link-planner.js` with the ten guides as
  targets so owning blog posts link to the guide that owns the entity. No new
  mechanism; the 5-per-run cap and anchor policy apply as-is.
- **B2** Render the existing contextual-links block on guide pages
  (guide → related guides in the same cluster, guide → the service page and
  quote link). Reuses `internal-context-links.ts` with a guide category map.
- **B3** Topic hub pages per owned entity (for example a termite topic hub
  linking the bond, bait-station, and cost guides): new hub pages, so
  recommend deferring until C2 shows where recognition is weakest
  (decision 7).

Effort: B1 small (portal config plus the runs it opens), B2 medium (astro),
B3 medium and gated on a decision.

### Not a lane: external corroboration

Independent mentions are the Backlink Manager's job. Its per-office profile
sync is the only automated path into `entity-profiles.auto.json`, and the
signup runner stays dark. The manual priority claims listed in
`entity-profiles.ts` are owner hands-on work, not portal code.

## Owner decisions

1. **Spoke founder `@id`.** Keep spoke Person nodes bare (recommended), or
   allow one hub URL in spoke JSON-LD as a brand-isolation exception?
2. **`alternateName`.** Is "Waves Pest Control & Lawn Care" or any other name
   in use on GBP, Sunbiz, or invoices? Declare only those.
3. **Corporate `sameAs` URLs.** Confirm the Sunbiz record URL and the FDACS
   lookup URL for JB351547, and state which of BBB, Nextdoor, Apple Business
   Connect, and Bing Places are claimed with matching NAP today.
4. **Adam's `knowsAbout`.** Proposed: general household pest control, termite
   and WDO inspection, lawn and ornamental pest control, rodent control,
   mosquito control. Confirm each is a licensed category he practices.
5. **Adam's personal `sameAs`.** Any real profiles beyond LinkedIn?
6. **Entity question cohort.** Approve or edit the eight draft questions.
7. **Topic hub pages.** Defer (recommended) or approve building them in lane B.

## Decisions (Adam, September 7, 2026)

1. **Spoke founder `@id`: keep bare.** No hub URL through `@id`, `url`, or
   `sameAs` on spokes. Adam's full biography, expertise, credentials, and
   approved profiles stay on the hub. No cross-domain identity migration.
2. **`alternateName`: omitted.** Primary name Waves Pest Control, legal name
   Waves Pest Control, LLC. "Waves Pest Control & Lawn Care" is in public use
   (Google Play listing) but not yet recorded against GBP, Sunbiz, or invoices,
   so it stays out of schema until that check is recorded.
3. **Corporate `sameAs`: Sunbiz only.** The Sunbiz record for Waves Pest
   Control, LLC (document L24000068475, filed and effective February 6, 2024,
   active) goes in. The FDACS lookup is a search form, not an identity page:
   it is linked visibly on the business profile with the number to search,
   never as `sameAs`. BBB exists but its main phone differs from the hub's
   and claimed status is unverified; Nextdoor, Apple Business Connect, and
   Bing Places are pending verification. None are added. Listing existence,
   identity, contact match, and owner control are four separate checks.
4. **Adam's `knowsAbout`: subject list, not a licensing claim.** General
   household pest control, termite inspection and control, WDO inspection,
   lawn and ornamental pest control, rodent control, mosquito control. No
   fumigation. The business license number is not proof of individual
   operator certification; the author page's individual credential claims
   are an open item to check against the actual records.
5. **Adam's personal `sameAs`: LinkedIn only for now.** A personal Facebook
   profile is a credible candidate but needs Adam's confirmation before it
   is published. No company accounts on the personal node.
6. **Entity cohort: approved with edits.** Ten questions (owner, who Adam is,
   licensed and how to verify, founded, based and areas, services, termite
   bonds and what they cover, franchise or independent, the longer name,
   contact) plus two search-query tests ("Adam Benetti pest control
   Sarasota", "Waves Pest Control license JB351547"). Each records the
   approved answer, source, and unacceptable claims. Founding year is 2024;
   the LLC filing date is February 6, 2024 and is not equated with the first
   day of service. Termite answers use the current approved agreement only,
   never inferring damage-repair coverage or a re-treatment guarantee. Places
   served are distinct from office locations. No page is published per
   question.
7. **Topic hubs: deferred.** Identity accuracy, existing-page improvements,
   schema consistency, and the entity baseline come first. No new URLs, no
   protected quote URL changes, no expanded cross-domain linking.

Overall instruction: proceed with the verified identity work; separate
corporate identity, personal credentials, and listing-management status;
omit unsupported fields rather than inventing values; record unresolved
items precisely without blocking verified improvements.

## Success measure

Thirty days after lane A and B1 ship: entity cohort "facts right" rate per
engine, the v1 benchmark owned-link follow-up against the 40 percent baseline,
and Waves' brand `rank_position` share on the provider questions Q1 to Q10.
