---
name: waves-content
description: Use when writing or editing blog posts, hub or spoke pages, SEO metadata, GBP/social content, or working on the portal's autonomous content engine — anything that publishes words to a Waves surface. Covers the truth rules, the prohibitions registry, hub-and-spoke boundaries, and the publish gates.
---

# Waves Content — publishing rules for the hub, spokes, blog, and social

## Purpose
Content ships autonomously here (the portal's content engine writes and
merges blog posts with Codex review as the only gate), so the rules that
keep it truthful, compliant with owner directives, and SEO-safe must be
applied at write time. The astro repo's own `CLAUDE.md` is authoritative for
build mechanics (tokens, collections, redirects, sitemap) — this skill
layers the business rules and cross-repo workflow on top; don't duplicate it.
Brand voice, positioning, and conversion-writing reference: `EXAMPLES.md` in
this skill.

## When to Use
- Authoring/editing anything in the astro repo's `src/content/` or the
  portal's content engine (`server/services/content*`, seo services).
- SEO audits, metadata changes, internal-link work, GBP posts, social
  content, newsletters.

## Truth rules (non-negotiable)
- **Real E-E-A-T only:** Adam Benetti, founded **2024**, FDACS license
  **JB351547** (licensed in every FL pest-control category EXCEPT
  fumigation). Never a 2014 founding, invented tenure (SWFL tenure is only
  since 2024 — no `years_swfl`/years-of-experience claims, ever), or a
  `fact_checked_by` attribution; `technically_reviewed_by: Adam` + the
  `fact_checked` date stay.
- **Company name in copy is "Waves Pest Control"** — never
  "Waves Lawn & Pest". The mascot logo artwork carrying the old name is
  current and intentional; never flag or swap the asset.
- **Pesticide compliance idiom:** no product is ever "safe" (incl.
  "pet-safe"/"family-safe"); "EPA-registered" or "EPA-exempt", never
  "EPA-approved"; NEVER a fixed re-entry/drying minute figure — the idiom
  is "safe once dry" + technician confirms timing. Applies to portal
  surfaces too (estimator benefit lines, prep guides, reports). When one
  instance of a banned claim class is flagged, sweep the WHOLE tree for
  the class.
- Every local/pest claim grounds in the facts bank
  (astro `content-ops/facts-bank/`) or a citable source — no invented
  county stats, pest seasons, or "customers report…" claims.
- Verify links by their actual `href`, not label text; verify a blog URL
  against the live sitemap before "fixing" it (root-level `.md` files still
  route to `/{category}/{slug}/` by frontmatter).

## Prohibitions registry (owner directives — do not relitigate)
- **No near-me/transactional phrasing in blog posts** (blog = informational
  lane). Near-me terms are INTENTIONAL on service/city pages — including the
  ~2,000-char city-page metaTitles; never "fix" those.
- **No door-to-door sales content.** Ever.
- **No fumigation, insulation, or wildlife-trapping content** (rodent stays
  core).
- **No bulk FAQ frontmatter expansion** on the remaining service spoke pages.
- **Social/GBP content is non-promotional value-first:** DIY tips, facts,
  holidays, humor; brand in the footer only; no phone/CTA headlines;
  uplifting, never scary; grounded in SWFL.
- **Never hardcode WaveGuard/dollar amounts on marketing pages** — link
  `/pest-control-calculator/`.
- **Protected URL families:** `/pest-control-{city}-fl/` and the `-quote-`
  families take no 301/canonical/title changes without per-URL owner
  sign-off; city×service pages with >5K impressions follow the same
  per-URL rule. The `/pest-control-services-{city}-fl/` variants are NOT
  protected — 301 them to the hub family (settled; don't re-ask).
- **GBP imagery:** NO AI-generated imagery on GBP, ever (owner rule);
  social images strip EXIF GPS before upload. KNOWN GAP (2026-07-29): the
  live GBP publishers still auto-generate images (`social-media.js`
  `gbpWantsImage` path + the autonomous GBP action) — a code-side fix is
  owed; never extend that pattern, and flag any diff adding AI imagery to
  a GBP path.
- **Termite copy rulings:** the warranty is an OPTIONAL annual renewable
  bond — NEVER "included in the first year". "No contracts" is a GENERAL
  brand promise allowed on termite pages, but guarantee/re-treat promises
  stay OFF termite (re-treatment requires the paid bond). NO
  `/termite-bait-stations/` URL — program content lives on the city pages.
  Comparison claims use sourced label facts only (never "requires 2×
  stations").

## Hub-and-spoke boundaries
- **All blog lives on the hub.** Spoke `/blog/` renders empty by design;
  spoke blog URLs 301 to the hub. Reversing this needs Adam's explicit OK.
- Spokes are Waves-branded keyword sites with their OWN address and **no
  GBP** — never publish the LWR HQ address or GBP sameAs on a spoke.
- Brand isolation is token-based (`{{brandName}}`, `{{siteUrl}}`,
  `{{cityPhone}}`…) and CI-enforced; never hardcode the hub brand into
  spoke-shared content, and never fix a leak with an invisible build-time
  rewrite.
- Spoke-canonical pages are never re-rendered on the hub; hub orphans get
  blanket 301s. Exact-match 301s live in the Cloudflare account Bulk
  Redirect list (`waves_redirects`), NOT the repo `_redirects` file (the
  deployed hub `_redirects` already runs ~96 of the 100-rule Pages cap).
- **Linking policy:** spokes link to the hub ONLY from blog content —
  spoke service/city pages never link the hub; the hub links out to spokes
  ZERO times. Breadcrumbs build from the SERVED domain (`Astro.site`),
  never the canonical. `contact@wavespestcontrol.com` is the ONE permitted
  Waves-domain string in spoke rendered HTML.
- **GBP truth source** is `server/config/locations.js` (`WAVES_LOCATIONS`):
  4 GBPs cover 5 staffed cities (the LWR GBP is shared with Bradenton);
  North Port / Port Charlotte / Palmetto are service-area-only with NO GBP
  — never invent one. The hub homepage HQ address is intentional
  back-office (NOT a NAP mismatch), and the org-level schema node carries
  no `aggregateRating` (ratings live on the 4 branch LocalBusiness nodes).

## Publishing procedure (blog)
1. Draft per the astro CLAUDE.md frontmatter/component rules; the binding
   schema gate is `packages/blog-schema/schema.json` (meta description
   115–160 chars, 24 required fields, additionalProperties false).
2. `npm run publish:post <file>` before merge;
   `npm run validate:generated-blog -- --slug=<slug>` after build. The
   ASTRO repo is upstream for the blog schema: the portal's
   `packages/blog-schema` is a VENDORED copy pulled from astro via
   `npm run sync:blog-schema` (`scripts/sync-from-astro.js`; a checksum
   drift check fails the build on mismatch) — edit the schema in the
   astro repo, then sync; never hand-edit the vendored copy here.
3. Bump `modified:` frontmatter on ANY content edit (drives sitemap
   lastmod); never rename a slug without a 301.
4. Ship via the waves-ship skill; pace astro pushes (every push rebuilds the
   whole Pages fleet; hub deploy lags 30–45 min).
5. Quality-gate changes: required publish criteria are HARD (`isHard`)
   checks, never score weights — recompute the guaranteed floor when adding
   checks.

## Autonomy posture
- The portal already has a full autonomous content engine
  (`server/services/content*` + seo services) — audit the gap first, never
  rebuild it. Competitor-intercept briefs run fully autonomous; the
  Codex-gated auto-merge is the control surface. Blog-backlog PRs merge via
  the poller — don't merge them manually. While Codex is usage-limited that
  safety layer is ABSENT — treat content auto-merges as ungated during a
  sustained limit.
- Newsletter voice: irreverent local-guide FOMO, events lead, banned
  corporate phrases, sign-off "— The Waves Pest Control Team"; its social
  auto-share stays fully automatic (no review queue).

## Tooling (recipes in memory / topic files)
- GSC: service-account helper `~/.config/gsc-venv` (`gsc-query.py`,
  `gsc-inspect.py`, creds from Railway `GOOGLE_SERVICE_ACCOUNT_JSON`), or
  gcloud ADC with `x-goog-user-project: waves-portal`.
- Indexing API: recrawl nudge (200 URLs/day), send a browser UA.
- Never automate the GrowthBook UI; provision via its API.

## Verification
- Blog: both publish gates pass; rendered URL checked against sitemap;
  brand-isolation CI green on spoke-shared edits.
- Claims: every stat/claim traceable to the facts bank or a source.
- SEO changes: no protected-family URLs touched without sign-off; sitemap
  lastmod updated where content changed.

## Failure Modes
- "Fixing" intentional SEO (city-page titles, empty spoke blogs, meta
  proximity terms).
- Fabricated local facts or credentials.
- Promotional social content.
- Hardcoded brand/prices in shared content.
- Unpaced astro pushes hammering the Pages build queue.

## Escalation
Ask Adam for: anything touching protected URL families, new spoke
pages/domains, pricing claims, reversing a standing content directive.
