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

## When to Use
- Authoring/editing anything in the astro repo's `src/content/` or the
  portal's content engine (`server/services/content*`, seo services).
- SEO audits, metadata changes, internal-link work, GBP posts, social
  content, newsletters.

## Truth rules (non-negotiable)
- **Real E-E-A-T only:** Adam Benetti, founded **2024**, FDACS license
  **JB351547**. Never a 2014 founding, invented tenure, or `fact_checked_by`.
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
  sign-off.

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
  Redirect list (`waves_redirects`), NOT the repo `_redirects` file.

## Publishing procedure (blog)
1. Draft per the astro CLAUDE.md frontmatter/component rules; the binding
   schema gate is `packages/blog-schema/schema.json` (meta description
   115–160 chars, 24 required fields, additionalProperties false).
2. `npm run publish:post <file>` before merge;
   `npm run validate:generated-blog -- --slug=<slug>` after build.
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
  the poller — don't merge them manually.
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
