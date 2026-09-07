# Affiliate Links in Blog Posts — Pilot Playbook (registry/component model)

Owner-approved scoping 2026-08-31, revised same day after the owner's review:
affiliate links are a **fallback monetization layer** on the hub blog's
informational lane — never the reason a post exists, and never allowed to
cannibalize a service lead. One lost WaveGuard/termite/lawn/rodent customer
($200–$1,000+) erases months of $3–$10 commissions, so the system is built
to protect the service funnel first.

## The model (what replaced the v1 env-var allowlist)

Blog bodies never contain an affiliate URL. They reference an approved
product by ID:

```mdx
<AffiliateLink product="rain-gauge-001" placement="primary-rec">a rain gauge</AffiliateLink>
```

- **Registry** — `packages/affiliate-registry/registry.json`, vendored from
  the astro repo (the renderer resolves product → URL at build time, so the
  astro copy is the source of truth; `npm run sync:affiliate-registry`
  pulls it here). Adding or re-approving a product row is an **astro PR the
  owner merges — the merge IS the approval record** (`owner_approved_at`).
  Tracking URLs exist ONLY in the registry.
- **Renderer (astro)** — resolves the URL, stamps
  `rel="sponsored nofollow noopener"`, renders a visible "Affiliate link"
  label, attaches static post/product/placement click metadata, and falls
  back to a plain link (or bare text) when a product is paused — a paused
  program never breaks the fleet build.
- **Publish gate (this repo)** — `content-guardrails.js`
  `affiliateComponentFindings` + the registry validator enforce everything
  below deterministically. Raw retailer/tracking URLs in a draft are always
  `DISALLOWED_EXTERNAL_LINK` (the v1 exact-URL bypass was removed).

## Kill switch

`GATE_AFFILIATE_LINKS` (Railway env, portal server; read at call time;
must be EXACTLY `true` — `1`/`on` stay dark).
Unset/anything-but-true = the product index is empty, so every
`<AffiliateLink>` is a P0 `UNREGISTERED_AFFILIATE_LINK` and nothing
affiliate can publish. Channel stripping (below) runs REGARDLESS of the
gate. The v1 `CONTENT_AFFILIATE_LINKS` env var is gone — one kill switch,
not two.

## Product risk classes (owner rulings 2026-08-31)

| Class | What | Policy |
|---|---|---|
| **green** | Tools, exclusion materials, PPE, moisture/rain gauges, non-pesticide traps, durable lawn/tree equipment | Owner approval per row |
| **yellow** | Consumer pesticides: RTU products, ant/roach baits, mosquito larvicides, consumer rodent bait stations, biologicals, misusable-but-legal concentrates | **APPROVED conditional on per-product manual review**: `epa_reg_number`, current `label_url`, `florida_registration_verified_at`, `label_reviewed_at`, owner approval — stale after **180 days** (`PESTICIDE_LINK_WITHOUT_CURRENT_LABEL_REVIEW`) |
| **red** | Restricted-use pesticides, fumigants, professional termiticides, loose/professional rodenticides, anything not FL-registered | **Never.** A red row may exist only as an explicit `status:"prohibited"` denial record |

## Page-class eligibility

Product rows declare `allowed_post_types`. The registry validator refuses
`location` / `cost` / `decision` / `comparison` / `case-study` in any row —
those post types capture local service intent and never carry affiliate
links (`AFFILIATE_LINK_ON_PROTECTED_PAGE`, fail closed on a missing
post_type). Service/city pages are structurally excluded (blog lane only).

## Placement rules (enforced, not aspirational)

- Disclosure: `frontmatter.disclosure.type: "affiliate"` required
  (`AFFILIATE_LINK_WITHOUT_DISCLOSURE`); the astro layout auto-renders the
  disclosure block above the body, so it always precedes the first link.
- ≤ 3 affiliate links per post; none before the first section heading
  (`EXCESSIVE_AFFILIATE_LINK_DENSITY`, P1).
- A Waves service CTA link must be present in every affiliate post
  (`SERVICE_CTA_MISSING_FROM_LOCAL_ARTICLE`, P1).
- Meta fields never carry one (`AFFILIATE_LINK_IN_META`).
- Refreshes preserve but never add (`AFFILIATE_LINK_ADDED_ON_REFRESH`,
  fail closed without the prior body).
- No hardcoded prices anywhere (existing global `HARDCODED_PRICE` P0) —
  anchor convention is "view current price".
- Amazon rows: direct `amazon.com` URL with `tag=` (validator-enforced;
  amzn.to/redirect/cloak domains are invalid rows), static per-placement
  subtags only — never per-visitor (Associates policy).

## Channels: web-only

Affiliate material (component tags, registry URLs, tracking-network URL
shapes) is blocked outside the rendered blog page, gate on or off:

- Newsletter: `newsletter-validator.js` hard-blocks the send
  (`AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL`), every type incl. manual.
- Social: `social-media.js publishToAll` — the convergence point for the
  RSS cron, the poller post-merge share, the studio, and manual shares —
  refuses affiliate links and strips affiliate copy field-by-field.
- Astro: `feed.xml` carries no bodies and `llms.txt` links no posts today;
  the astro PR adds a dist-scan CI assertion so that stays true.

## Autonomy posture (pilot)

- Autonomous supporting blogs publish without a per-post human approval.
  The owner superseded the pilot's approval requirement on 2026-09-05.
  Registry eligibility, sourcing, disclosure, placement, current-head checks,
  Codex review, and the affiliate kill switch still apply. The poller checks
  the live Astro registry at merge time; it never fabricates approval data.
  Other content lanes retain their existing contracts.
- The writer never proposes affiliate products and never sees commission
  rates (rates are not a registry field by design). Product IDs enter via
  hand-authored briefs. `GATE_AFFILIATE_WRITER_PROPOSALS` is reserved for a
  post-pilot proposal lane — do not build it during the pilot.

## Merchant programs (researched 2026-08-31; confirm terms in-dashboard at application)

Pilot pair: **Amazon Associates** (3% lawn & garden, 24h — long-tail tools)
+ **Solutions Pest & Lawn** (up to 15%, 180-day — niche incl. approved
yellow products). Add rows opportunistically where an article fits:
**Thermacell** (Impact 4–8%/30d), **The Andersons**
(FlexOffers ~5%/30d, lawn fertility), **Husqvarna**
(CJ ~5%/45d, tree/chainsaw-safety fit), DoMyOwn (Awin ≤6%/90d — email
placements restricted), ARBICO (7.5%), Greenworks (Rakuten 3–6%/30d).

Rates above are unverified desk research except where noted below. The
2026-09-01 signup pass verified only: DoMyOwn (Awin advertiser 88419,
90-day cookie) and Solutions Pest & Lawn (up to 15%, 180-day, confirmed
on their affiliate page). Confirm each remaining row against the
advertiser's own network profile before joining — the EGO row below shows
what name-matched research gets wrong.

Excluded, do not revisit without an explicit owner ruling: **ClickBank**
(info-product funnels — E-E-A-T damage), **Pestie** (no program exists;
direct service substitute), **Sunday/Lawnbright** (DIY lawn subscriptions —
direct lawn-program substitutes; $35–45 bounties do not cover a lost $500+/yr
customer), **EGO** (owner ruling 2026-09-01 — the only EGO program on Awin
is advertiser 12450, a footwear and clothing brand, not EGO Power+ the
outdoor power equipment maker; the "7%/30d, best equipment economics" line
this doc previously carried was that clothing listing's terms, matched on
the name), any pest-service lead-gen/referral network, the dropped Terminix
idea. Home Depot (1%/1d) and Lowe's (~2%/24h) only for bulky hardware Amazon
ships badly. Stihl is dealer-only — no program.

## Pilot composition & measurement (before the gate flips)

- **6 hub-only articles**: 2 nonchemical prevention, 2 lawn/irrigation
  measurement, 2 field-tool/equipment. Excluded: top local lead pages,
  termite/WDO, German cockroach, bed bug, rodenticide, emergency/health-
  anxiety content.
- **Baseline first**: 90 days of GSC + GA4/PostHog per candidate URL
  (sessions, queries, geography, estimate starts, calls, CTA clicks)
  recorded before any link activates.
- **Events** (astro, consent-gated PostHog): `affiliate_link_click`,
  `affiliate_link_impression`, `service_cta_click` with static
  merchant/product/placement/article properties.
- **Stop/scale**: run ≥60 days or 300 outbound clicks; STOP a page if its
  local service conversion drops >10% vs baseline; scale only on total page
  value (commissions + service-lead gross profit − lost gross profit),
  never on affiliate clicks alone; review SWFL vs out-of-area separately.

## Ship order

1. **This PR (portal)** — registry package + gates + channel strip, dark.
2. **Astro PR** — registry source of truth, `AffiliateLink.astro`,
   layout-inserted `AffiliateDisclosure`, `disclosure: affiliate` schema
   enum + `validateAffiliateUsage` in the publish gate, `/affiliate-
   disclosure/` page + hub footer Associates line, analytics events,
   `check-affiliate-links` CI (raw-URL scan, registry lint, dist scan).
3. **Portal follow-up PR** (this one) — re-vendored blog-schema + first
   registry sync, `AffiliateLink`/`InlineCTA`/`SpiderIdBoard` cataloged in
   `SAFE_MDX_COMPONENTS`, automated blog checks, legacy approval
   path extended, poller affiliate belt.
4. **Ops** — owner signs up for programs; product-row PRs (yellow rows
   arrive with all four review fields filled — first six green Amazon rows
   landed via astro #509 + portal #3724); `GATE_AFFILIATE_LINKS=true`
   after a shadow run confirms parking; then the 6 pilot briefs.
5. **Pilot briefs** — `server/data/affiliate-pilot-briefs-v1.json`, seeded
   with `node server/scripts/seed-category-topics.js --file=<path>` (the
   category-seed lane: informational hub posts, operator-pinned). A brief's
   `affiliate_products` (≤3; `product_id`, `placement`, `anchor`,
   optional `section`) is validated at seed time against the vendored
   registry and reaches the writer verbatim as binding instructions; the
   writer's system prompt carries the general AffiliateLink rules
   (disclosure, placement after the first H2, service CTA first, no prices).
   Shadow check before the flip: seed one brief, then run
   `GATE_AFFILIATE_LINKS=true SHADOW_MODE_NEW_SUPPORTING_BLOG=true railway run node server/scripts/run-autonomous-next.js --live`
   — expect `skipped_shadow_mode` / `shadow_would_gate` with the draft
   carrying the link and clean guardrails, no PR.
