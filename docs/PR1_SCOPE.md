# PR 1 Scope — Trust Layer + Publish Pipeline + Legacy Kill

*(v2 — post-review sign-off. Open questions closed; sections 1, 2, 3, 4, 5, 6 updated.)*

Second PR in the blog template v2 arc. PR 0 shipped the schema contract; PR 0.1 patches it to rename `validateRenderedComponents` → `validateMarkdownComponents` and validate authored markdown instead of rendered HTML. PR 1 stands up the admin → Astro publish pipeline, kills the legacy WordPress path, ships the first four public trust components, seeds the `/about/*` trust infrastructure, and backfills 157 queued posts in preparation for human review.

**No live posts republish as part of PR 1.** Migration prepares frontmatter; publishing is gated behind actual human technical review with truthful dates. PR 1 ships with 5–10 hand-reviewed posts at `ready`, 150+ stay in `manual_review` pending real review.

---

## 1. Publish pipeline contract

### 1.1 Endpoint shape

`GET /api/spokes/:slug/posts` with `Authorization: ApiKey <per-spoke-key>`.

```ts
import type { BlogPostFrontmatter } from '@waves/blog-schema';

interface SpokeFeedResponse {
  spoke: { slug: string; domain: string; canonical_base_url: string };
  generated_at: string;         // ISO 8601
  schema_checksum: string;      // first 12 chars of upstream-checksum.txt
  feed_version: 1;              // bump when contract changes; loader refuses unknown versions
  posts: SpokeFeedPost[];
  authors: Record<string, ResolvedAuthor>;
}

interface SpokeFeedPost {
  frontmatter: BlogPostFrontmatter;
  body_markdown: string;        // markdown source; Astro renders at build time
  body_checksum: string;        // sha256(body_markdown) for loader cache invalidation
  published_at: string;         // ISO; admin's publish timestamp (distinct from frontmatter.published)
}

interface ResolvedAuthor {
  slug: string; name: string; role: string;
  credential: string | null; fdacs_license: string | null;
  years_swfl: number | null; bio_markdown: string;
  photo_url: string | null; specialties: string[];
}
```

Key decisions:
- **Admin ships markdown, not HTML.** Astro owns render — TOC, FAQ schema injection, component rendering all happen at build time via remark plugins and Astro components consuming frontmatter.
- `schema_checksum` is a second drift tripwire, independent of vendor check.
- `feed_version` saves future us when the contract breaks.
- `published_at` distinct from `frontmatter.published` (latter is human-facing, former is cache freshness).
- `authors` inlined (≤20 total).

### 1.2 Auth model — per-spoke API keys

```sql
CREATE TABLE spoke_api_keys (
  id SERIAL PRIMARY KEY,
  spoke_slug TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  UNIQUE(spoke_slug, key_hash)
);

CREATE INDEX idx_spoke_api_keys_hash ON spoke_api_keys(key_hash) WHERE revoked_at IS NULL;
```

Middleware `spokeApiAuth` in `server/middleware/spoke-api-auth.js`. `Authorization: ApiKey <raw>`. 401 with no detail on failure.

Issuance: `scripts/issue-spoke-key.js <slug>` prints raw once, inserts hash. Rotation: `--rotate` flag (7-day dual-live). Raw key stored per-spoke in Cloudflare env as `WAVES_ADMIN_API_KEY`.

### 1.3 Loader error-path decision matrix

| Admin returns | Loader action |
|---|---|
| 2xx, ≥1 post | use; atomic snapshot write |
| 2xx, 0 posts | **fail build** |
| 2xx, schema_checksum mismatch | **fail build** |
| 2xx, feed_version unknown | **fail build** |
| 401 / 403 | **fail build** |
| 404 | **fail build** |
| 5xx / network / timeout >30s | snapshot < 24h old: use; else fail |
| Non-JSON / parse error | **fail build** |

Knobs (spoke build-time env): `WAVES_ADMIN_API_TIMEOUT_MS=30000`, `WAVES_ADMIN_SNAPSHOT_MAX_AGE_HOURS=24`, `WAVES_ADMIN_API_BASE_URL`, `WAVES_ADMIN_API_KEY`.

### 1.4 Cloudflare Pages deploy hooks

Stored as admin env vars. Naming: `CLOUDFLARE_DEPLOY_HOOK_<SLUG_UPPER_UNDERSCORE>`.

### 1.5 Events that trigger deploys

| Event | Affected spokes |
|---|---|
| Post published | `frontmatter.tracking.domains` ∪ hub |
| Post unpublished | last-published spoke set |
| Post updated (already live) | same as publish target |
| Author updated | all spokes citing that author |
| `/about/editorial` edited | all spokes |
| Spoke API key rotated | none |

Dispatcher: `server/services/content/deploy-dispatcher.js`. POSTs all hooks in parallel, logs, fire-and-forget.

### 1.6 Concurrent publish behavior

Accept Cloudflare's default deploy coalescing. No admin-side debounce. Revisit at N>1 admin.

### 1.7 Incremental rebuild

Full rebuild per event for PR 1. Deferred.

---

## 2. WP deprecation path

### 2.1 Kill plan — delete, don't extract

- **Replace** the WP publish handler body at `server/routes/admin-content.js:142` with a 410 Gone response + warning log. URL pattern stays.
- **Remove** the UI trigger in `BlogPage.jsx`; replace with the new "Publish to spokes" button wired to the new endpoint.
- **Delete**, don't extract, the markdown→HTML pipeline in `wordpress-sync.js`. Astro owns render via remark plugins. What looked reusable isn't actually reusable without carrying WP baggage.
- **Dies**: MD→HTML, WP featured image upload, WP tag resolution, FAQ schema injection, TOC generation, `content_html` as a publish artifact (becomes admin-preview-only).
- **Survives as new work** (not extraction): image upload. New standalone service `server/services/content/image-upload.js` writing to Cloudflare R2. Called by the CMS editor on drop. Independent of render; if it grows past ~100 lines, it splits to its own PR.
- **Keep** `wordpress-sync.js` in tree, unreferenced, with `@deprecated` header + "DELETE AFTER <date>" (30 days post-ship).
- **Keep** WP env vars in Railway for 30-day audit window.

### 2.2 Component validation — static markdown analysis

Replaces PR 0's `validateRenderedComponents(html, frontmatter)`.

PR 0.1 (ships before PR 1) patches the schema package:

```ts
// @waves/blog-schema
export function validateMarkdownComponents(
  body_markdown: string,
  frontmatter: { post_type: string },
): ComponentValidationResult
```

Parses markdown AST, looks for component invocations (MDX component tags — exact syntax locked during PR 0.1, matching whatever the Astro components consume). Pure static analysis. No rendering, no network, no spoke dependency.

Admin publish gate calls this locally. Spoke build calls same function again at build time as a second safety net — zero drift.

Render failures (valid markdown, broken component) surface in Cloudflare Pages build logs. Admin UI shows "publish queued, deploy pending" until Cloudflare webhook confirms. Different failure class, different handling.

### 2.3 WP URL redirect map — BLOCKING FOR GO-LIVE

Live WP URLs indexed by Google under `wavespestcontrol.com/blog/*`. Killing them without 301s nukes residual organic traffic + sends decay signal. Single biggest SEO risk in the migration.

**Before PR 1 ships any live traffic:**

- `server/scripts/build-wp-redirect-map.js` — pulls WP sitemap (preferred) or WP DB post list (fallback) or Wayback Machine / Screaming Frog against the live WP sitemap (last-resort).
- Generates slug-by-slug `old_wp_url → new_astro_url` map.
- URLs without 1:1 match → 301 to `/blog/` index. **Not** homepage. **Not** 404.
- Output: Cloudflare `_redirects` file or equivalent Astro spoke config.
- Runs against WP **while WP is still up**. Do not 410 the endpoint until the map is built, deployed, and verified working.

Non-optional. PR-1-blocking for go-live.

---

## 3. Authors — URL + data model

### 3.1 URL: `/about/authors/{slug}` — stable `first-last` kebab.

### 3.2 DDL

```sql
CREATE TABLE authors (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9-]+$'),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  credential TEXT,
  fdacs_license TEXT CHECK (fdacs_license IS NULL OR fdacs_license ~ '^JB[0-9]{4,}$'),
  years_swfl INTEGER CHECK (years_swfl IS NULL OR years_swfl >= 0),
  bio_markdown TEXT NOT NULL,
  photo_url TEXT,
  specialties TEXT[] NOT NULL DEFAULT '{}',
  email TEXT,
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_authors_published ON authors(slug) WHERE published = true;
```

Bylined-posts computed at query time against `blog_posts.frontmatter` JSONB.

### 3.3 FDACS requirement — conditional, not field-level

`author.fdacs_license` and `technically_reviewed_by.fdacs_license` stay **nullable at the field level**. A `superRefine` in `@waves/blog-schema` enforces:

```
IF category ∈ {pest-control, termite, mosquito, lawn-care}
   OR post_type ∈ {diagnostic, protocol, cost}
THEN technically_reviewed_by.fdacs_license MUST be non-null
```

Non-technical reviewer roles (editorial, fact-checker) stay nullable regardless. Schema bump ships in PR 1's `@waves/blog-schema` minor update.

### 3.4 First-wave publication strategy

PR 1 does **not** ship real technician bylines live. Strategy:

- Authors table seeded with five records: `waves`, `adam-benetti`, `jose-alvarado`, `jacob-heaton`, `virginia`. All start `published = false`.
- First-wave posts (5–10) flipped live in PR 1 use a single **house byline** — `waves` = "Waves Editorial", carrying the business's FDACS structural pest control operator license (Waves provides by end-of-week).
- `/about/authors/waves` renders live.
- Individual technician author pages stay `published = false` until Waves enters their JB#s. Flipping to `published = true` is a one-click admin UI action per author.
- Publish validation: `author.bio_url` must resolve to an author with `published = true`. Prevents typo-silent-breakage.

FDACS numbers are not a PR 1 blocker.

---

## 4. Component prop interfaces

### 4.1 `DualByline`

```tsx
interface DualBylineProps {
  author: ResolvedAuthor;
  technicallyReviewedBy: ResolvedAuthor;
  factCheckedBy: string;
}
```
Marker `data-wv-component="dual-byline"`. Astro loader resolves `bio_url` → full author record from inlined `authors` map.

### 4.2 `FourDateStrip`

```tsx
interface FourDateStripProps {
  published: string;
  updated: string;
  technicallyReviewed: string;
  factChecked: string;
  reviewCadence?: 'monthly' | 'quarterly' | 'annually';
}
```
Marker `data-wv-component="four-date-strip"`. Direct from frontmatter.

### 4.3 `BottomLineBox`

```tsx
interface BottomLineBoxProps { verdict: string; }  // ≤40 words
```
Marker `data-wv-component="bottom-line-box"`. Frontmatter field `bottom_line`. Required when `post_type === 'decision'`.

### 4.4 `WhyTrustUsBlock`

```tsx
interface WhyTrustUsBlockProps {
  stats: Array<{ value: string; label: string }>;
  claim: string;
}
```
Marker `data-wv-component="why-trust-us-block"`. Frontmatter field `why_trust_us`. Required for `decision, cost, comparison, case-study`.

### 4.5 Schema changes in the PR 1 bump

- `bottom_line: string` optional (≤~280 chars, ~40 words soft ceiling)
- `why_trust_us: { claim, stats }` optional
- Conditional refinements:
  - `post_type === 'decision'` requires `bottom_line`
  - `post_type ∈ {decision, cost, comparison, case-study}` requires `why_trust_us`
  - `category ∈ {pest-control, termite, mosquito, lawn-care}` OR `post_type ∈ {diagnostic, protocol, cost}` requires `technically_reviewed_by.fdacs_license`

Runs through existing generate → sync → drift check pipeline.

---

## 5. `/about/editorial` content outline

Static `.astro` page. Full prose copy drafted in chat before commit.

### 5.1 Our editorial mission
- Why Waves publishes educational content (service-adjacent authority, not ad funnel)
- What "educational" means: specificity, honest recommendations, local-first (SWFL)
- Standard: accuracy over speed, field-tested over armchair

### 5.2 Who writes and reviews our content
- Named reviewer network: role, credential, FDACS license (where applicable), years in SWFL pest control
- Link to each `/about/authors/{slug}`
- Distinction: authors vs. technical reviewers vs. fact-checkers

### 5.3 Our fact-checking process
- Pre-publish: technical review by FDACS-licensed reviewer for anything pesticide- or pest-biology-related
- Pre-publish: fact-check of pricing, service areas, dated claims
- Post-publish: periodic review (cadence set per post)
- Trigger-based: reader "no" feedback flows to audit queue (PR 3+)

### 5.4 How we source data + claims
- Pest biology: UF/IFAS extension, FDACS publications
- Regulatory: FAC 5E-14, Florida Statutes ch. 482
- Pricing: Waves' own pricing engine — disclosed as such
- Field observations: Waves technicians' documented service call outcomes

### 5.5 Correction policy
- How readers report errors (mailto:contact@wavespestcontrol.com)
- How we handle: new `updated` date; material corrections get a visible "Corrected on YYYY-MM-DD" note above the post
- We don't silently edit claims — if we got it wrong, we note it

### 5.6 Review cadence
- Monthly for time-sensitive
- Quarterly for pricing-sensitive
- Annually for evergreen
- Trigger-override on reader downvote

### 5.7 How to contact editorial
- `contact@wavespestcontrol.com` (Google Workspace alias; routes to Virginia + cc Waves)
- Physical address
- Response SLA: "we aim to respond within 5 business days"

### 5.8 AI disclosure — NEW

One paragraph, framed as a feature:

- Draft content produced with AI assistance
- Every post technically reviewed by a named FDACS-licensed human before publish — reviewer accepts accountability for accuracy
- AI handles scale; humans own truth
- E-E-A-T trust multiplier, not a mea culpa

---

## 6. Post migration — 157 queued posts

### 6.1 State of the world

- 157 posts in `blog_posts`, all `status = 'queued'`.
- Current shape: `id, title, keyword, slug, tag, city, meta_description, status, content, content_html, word_count, seo_score, publish_date, featured_image_url, wordpress_post_id, source, …`. Missing every v2 field.
- ~40 Astro `src/content/blog/*.md` files with legacy `seoSchema` frontmatter; origin unclear. See §6.8.
- Unknown subset edited by Waves/Virginia; treat all as authored until confirmed.

### 6.2 Migration philosophy — **migration does not publish**

Migration prepares `frontmatter` JSONB. Publishing is gated behind real human technical review with truthful dates. Manufacturing an audit trail by backfilling `technically_reviewed` and `fact_checked` would lie about a process that didn't happen.

PR 1 ships with 0 auto-published posts and 5–10 hand-reviewed posts at `ready`. The other 150+ sit in `manual_review` until they pass real technical review.

### 6.3 Migration script

`server/scripts/migrate-blog-posts-to-v2.js`. Two modes:

```
npm run migrate:blog-v2 -- --mode=validate   # schema-check only, no writes, writes report
npm run migrate:blog-v2 -- --mode=apply      # persists frontmatter JSONB + flags
```

Validate writes `~/Downloads/blog-v2-migration-report-YYYYMMDD-HHMMSS.json` with per-post: `{ id, slug, status, missing_fields, ambiguous_fields, zod_errors, migration_flags }`. Apply uses same logic, persists. Rerunnable; idempotent on rows already `ready`.

### 6.4 Backfill table

| Field | Backfill |
|---|---|
| `title` | existing |
| `slug` | normalized to v2 regex |
| `meta_description` | existing if 115–160; else flag `meta_description_out_of_bounds` |
| `primary_keyword` | existing `keyword` |
| `secondary_keywords` | `[]`; flag `secondary_keywords_unfilled` |
| `category` | heuristic; **always flag `category_inferred`** regardless of confidence |
| `post_type` | heuristic; **always flag `post_type_inferred`** regardless of confidence |
| `service_areas_tag` | `city` → 8-city list; else flag `service_area_unresolved` |
| `related_waveguard_tier` | null; Blog Content Engine pass |
| `related_services` | `[]`; flag |
| `hub_link`, `spoke_links` | empty; flag |
| `author` | default `/about/authors/waves` |
| `technically_reviewed_by` | default `/about/authors/waves` |
| `fact_checked_by` | `"Waves Editorial"` |
| `published` | `publish_date` if present; else null + flag |
| `updated` | `publish_date` if present; else null |
| `technically_reviewed` | **null** — don't backfill. Posts weren't reviewed. |
| `fact_checked` | **null** — don't backfill. Posts weren't fact-checked. |
| `review_cadence` | default per `post_type`: annually (cost → quarterly, seasonal → monthly) |
| `reading_time_min` | `ceil(word_count / 200)` — technical-content adjusted (was 225; Waves posts are denser) |
| `hero_image.src` | `featured_image_url` if present; else flag |
| `hero_image.alt` | Blog Content Engine pass |
| `og_image` | `hero_image.src` if dims match; else flag |
| `canonical` | spoke `canonical_base_url` + slug |
| `schema_types` | `['Article', 'BreadcrumbList']`; add `FAQPage` if body has FAQ block |
| `disclosure` | default `{ type: 'none' }`; `pricing-transparency` for cost posts |
| `tracking` | from Astro-side `seoSchema.domains` if importable; else default |
| `bottom_line` | null; required for decision → flag `bottom_line_required` |
| `why_trust_us` | null; required for decision/cost/comparison/case-study → flag `why_trust_us_required` |

Any post with `technically_reviewed: null` is auto-set to `migration_status = 'manual_review'`. Posts cannot reach `ready` without truthful review dates filled by a human.

### 6.5 New columns on `blog_posts`

```sql
ALTER TABLE blog_posts
  ADD COLUMN frontmatter JSONB,
  ADD COLUMN body_markdown TEXT,
  ADD COLUMN body_checksum TEXT,
  ADD COLUMN migration_flags TEXT[] DEFAULT '{}',
  ADD COLUMN migration_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (migration_status IN ('pending','auto','manual_review','ready','failed'));

CREATE INDEX idx_blog_posts_migration_status ON blog_posts(migration_status);
```

`body_checksum` = `sha256(body_markdown)`, matches `SpokeFeedPost.body_checksum`. Saves a second migration.

### 6.6 Markdown source resolution + MDX parseability — validate-mode checks

DB has both `content` and `content_html`. Unknown which is lossless markdown source. Separately, feed bodies ship as MDX (per PR 0.1), so legacy posts with bare `<` or `{` in prose will break MDX parsing.

Validate-mode runs per post:
1. Parse `content` as markdown → render to HTML with the same remark pipeline the spoke will use.
2. Whitespace-normalize, compare to `content_html`.
3. Match within tolerance → `content` is markdown source. Copy to `body_markdown`, compute `body_checksum`.
4. Mismatch → `content` is lossy (pasted HTML or editor-munged). Flag `markdown_source_unclear`. Human decides: re-extract from `content_html`, or rewrite.
5. MDX parse step: attempt to parse the resolved markdown as MDX. If parsing fails (bare `<` in prose, unclosed JSX, stray `{`), flag `mdx_parse_failure` with the parser error string and force `manual_review`.

**Resolve both before apply-mode runs.**

### 6.7 Expected distribution

- `auto` — all fields clean, Zod passes. **Still not `ready`** without truthful review dates.
- `manual_review` — ≥1 flag. Default for ~all posts given `technically_reviewed: null`.
- `ready` — hand-reviewed, dates filled truthfully. Only route to publish.
- `failed` — Zod fails past script's guess-repair.

Practical PR 1 state: Waves picks 5–10 highest-value posts, walks them through real review, flips to `ready`. The other 150+ stay `manual_review`.

### 6.8 Astro legacy .md reconciliation

`server/scripts/reconcile-astro-md-files.js` diffs admin DB slugs vs Astro `src/content/blog/` slugs:

- **Slug in both, content matches** → Astro-side deleted. Admin is source.
- **Slug in both, content differs** → surface to Waves for per-post decision.
- **Slug only in Astro** → net new. Pull into admin DB, run migration, flag `manual_review`.

Report-only; `--apply` required for deletions.

---

## Locked decisions (supersedes prior open questions)

| # | Question | Resolution |
|---|---|---|
| 1 | Spoke count | **5.** 15 was aspirational SEO target. Build for N, provision for 5. Reconcile CLAUDE.md in a separate tiny PR. |
| 2 | FDACS licenses | Not a PR 1 blocker. Ship with `waves` house byline using business's FDACS structural pest control operator license (Waves provides EOW). Technician JB#s flip as entered. |
| 3 | Editorial email | `contact@wavespestcontrol.com`. Google Workspace alias → Virginia + cc Waves. Created this week; not a blocker. |
| 4 | Author photos | Initials for PR 1 (Waves teal + navy). Real photos = later field-day shoot. |
| 5 | Report a correction | `mailto:contact@wavespestcontrol.com`. Admin-backed form lives with "Was this helpful?" in PR 3+. |
| 6 | WP `/blog/*` redirects | **BLOCKING.** Live URLs indexed; 301 map required before WP endpoint 410s. See §2.3. |
| 7 | Astro legacy .md files | Reconciliation script per §6.8. Report-only by default. |
| 8 | Cloudflare deploy coalescing | Accept default. |
| 9 | Concurrent publish | Accept Cloudflare default. |
| 10 | `/about/editorial` legal review | Parallel track. Not a PR 1 blocker. |
| 11 | `bottom_line` / `why_trust_us` in frontmatter | Confirmed. Authored via admin UI form fields, not inline markdown. |

---

## Implementation ordering (locked)

1. **Update this scope doc** with the above. ← done
2. **PR 0.1** — schema package patch in Astro repo: rename `validateRenderedComponents` → `validateMarkdownComponents`, rewrite for markdown AST, regenerate JSON + checksum, sync vendor to admin. Small clean patch; lands before PR 1.
3. **Draft `/about/editorial` prose copy in chat.** Waves reviews. Iterate.
4. **WP redirect map script.** Runs against live WP, generates 301 map, reviewed + wired into Cloudflare/Astro redirects. Completes before PR 1 ships live traffic.
5. **PR 1 implementation** — trust layer components, publish pipeline, migration script in validate-mode only. No apply. No publish.
6. **Validate-mode dry runs** — review `manual_review` queue, iterate heuristics. 3–5 passes expected.
7. **PR 1 go-live** — components live, 5–10 hand-reviewed posts at `ready` flipped published, redirect map deployed, WP 410'd after redirect map confirmed working. 150+ stay in `manual_review` pending human technical review.

---

## What's NOT in PR 1

- Recommendation quiz (PR 3, deferred)
- Annotated diagnostic photo component (PR 2)
- Admin preview iframe of spoke `/preview/{slug}?token=` (follow-up)
- Dynamic `why_trust_us` stats from admin DB (PR 2+)
- Incremental spoke rebuild (future)
- Admin UI for issuing / rotating spoke API keys (scripts suffice for PR 1)
- Cloudflare deploy outcome dashboard tile (PR 2+)
- Full delete of `wordpress-sync.js` (30-day soak)
- Cloudflare R2 image upload — in PR 1 if ≤100 lines, splits off if not
- Real technician author photos (later field-day shoot)
- Admin-backed correction form (PR 3+)
- "Was this helpful?" reader widget (PR 3+)
