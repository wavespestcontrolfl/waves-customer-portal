# Autonomous Blog SEO Completion Layer - Implementation Map

Date: 2026-05-24

## Scope

This is the repo audit and implementation map for the Waves autonomous blog SEO completion layer. It is intentionally documentation-only. It does not change production behavior, publishing behavior, shadow flags, content generation, schema output, or admin UI.

The goal of the follow-up implementation work is to make every generated supporting-blog draft easier to review and safer to merge by standardizing:

- Visible breadcrumbs.
- Matching `BreadcrumbList` JSON-LD.
- `BlogPosting` or `Article` JSON-LD.
- Visible FAQ sections when required/useful.
- Conditional `FAQPage` JSON-LD only when visible FAQs exist.
- Internal-link recommendations while link edits remain shadowed.
- Pest-practices content.
- CTA placement.
- SEO completion gate findings.
- Admin review and Astro PR review artifacts.

## Non-Goals

- Do not enable unattended publishing.
- Do not change any `SHADOW_MODE_*` production flags.
- Do not configure IndexNow.
- Do not unshadow city-service, customer-question, metadata rewrite, GBP, or reverse internal-link automation.
- Do not edit generated Astro content in this PR.
- Do not replace the existing content engine, queue, gates, or publisher.

## Repository Context

Primary portal repo:

```text
waves-customer-portal
```

Astro source repo inspected through GitHub API:

```text
wavespestcontrolfl/wavespestcontrol-astro-
```

Important note: portal code defaults `GITHUB_ASTRO_REPO` to `wavespestcontrol-astro`, while the accessible/active repo name inspected here is `wavespestcontrol-astro-` with a trailing dash. Tests also reference the trailing-dash repo in places. Do not change this in this docs PR, but verify production `GITHUB_ASTRO_REPO` before any publisher behavior changes.

Local breadcrumb strategy dependency:

```text
/Users/adambenetti/Downloads/waves-breadcrumb-seo-strategy-final.md
```

The breadcrumb implementation must follow the topical local hub model:

- Blog posts: `Home > Waves Blog > Post Title`
- City/local hub pages: `Home > Service Areas > Pest Control in {City}, FL`
- Local lawn subservices: `Home > Lawn Care in {City}, FL > Service Page`
- Local termite subservices: `Home > Termite Control in {City}, FL > Service Page`
- Other local pest subservices: `Home > Pest Control in {City}, FL > Service Page`

## Current Production Guardrails

The implementation PRs that follow this map must keep these flags unchanged:

```bash
SHADOW_MODE_NEW_SUPPORTING_BLOG=true
SHADOW_MODE_REFRESH_EXISTING_PAGE=true
SHADOW_MODE_CREATE_OR_REFRESH_CITY_SERVICE_PAGE=true
SHADOW_MODE_CREATE_CUSTOMER_QUESTION_PAGE=true
SHADOW_MODE_REWRITE_TITLE_META=true
SHADOW_MODE_ADD_INTERNAL_LINKS=true
```

The current engine should remain review-assisted: generate, gate, review, open PR where supported, request Codex review, verify preview, and merge manually.

## Implementation Map

| Feature area | Current file path | Current behavior | Required change | Test coverage needed | Risk |
|---|---|---|---|---|---|
| Astro blog route selection | `wavespestcontrol-astro-:src/pages/[...slug].astro` | Blog collection entries render through `BlogPostLayout`. Blog detail routes are hub-only; spokes exclude blog detail pages and redirect. | No portal change needed. Future validation should assume generated supporting blogs render through this path. | Render-validation fixture for generated blog slugs. | Low |
| Astro blog layout | `wavespestcontrol-astro-:src/layouts/BlogPostLayout.astro` | Renders `BlogArticleHero`, TOC, MDX/markdown body, spoke callout, sticky CTA, keep-reading, and final CTA. Calls `buildBlogStructuredData`. Passes schema into `BaseLayout` with `stripFaqPageSchema={false}`. | Add/confirm SEO completion inputs as needed after breadcrumb cleanup. Ensure BlogPosting/Article, FAQ, CTA, and rendered body expectations are included in validation. | Astro unit/render tests or HTML validation for generated blog fixtures. | Medium |
| Astro base layout and schema injection | `wavespestcontrol-astro-:src/layouts/BaseLayout.astro` | Builds breadcrumbs using `buildBreadcrumbItems` and `buildBreadcrumbList`, renders `<Breadcrumb>`, appends `BreadcrumbList` to schema blocks, normalizes schema, rewrites schema by domain, and emits one JSON-LD script. Defaults `stripFaqPageSchema=true`, but blog layout overrides it to false. | Consume final topical breadcrumb resolver from breadcrumb cleanup. Ensure visible breadcrumbs and JSON-LD use the same item array. Ensure blog pages emit valid article schema plus breadcrumb schema. | Breadcrumb JSON-LD and visible breadcrumb parity tests. HTML validation for blog/service examples. | High |
| Visible breadcrumb component | `wavespestcontrol-astro-:src/components/Breadcrumb.astro` | Renders nav when `items.length >= 2`; last crumb is unlinked and uses `aria-current="page"`. | Keep as shared renderer. Ensure labels exactly match JSON-LD names. Avoid homepage/private/noindex breadcrumbs. | Component/render test for last crumb, duplicate Home/Blog prevention, and hidden homepage breadcrumb. | Medium |
| Breadcrumb resolver | `wavespestcontrol-astro-:src/lib/breadcrumbs.ts` | Current resolver handles homepage, neighborhood parent cities, city hubs, and city-suffix service pages. It currently routes most city service pages through `Pest Control in {City}, FL`, so lawn and termite subservices need the topical local hub correction. Blog posts currently fall back to `Home > Post Title`; they need `Home > Waves Blog > Post Title`. | Implement the final topical local hub strategy. Add route detection order and prefix maps for lawn, termite, pest, neighborhoods, and blog posts. Keep JSON-LD generation from the same items. | Unit tests for blog, pest, termite, mosquito, lawn, city hub, neighborhood, homepage, and excluded routes. | High |
| Blog structured data | `wavespestcontrol-astro-:src/lib/blog-structured-data.ts` | Builds `Article` schema when schema types are empty or include `Article`. Extracts visible FAQ items from markdown and emits `FAQPage` only when `schema_types` includes `FAQPage` and FAQs are found. | Decide whether to keep `Article` or switch generated blog posts to `BlogPosting`. If switching, update schema builder, portal schema enum, and tests. Keep FAQ conditional behavior. | `jsonLd.article` or `jsonLd.blogPosting` tests; FAQ present/absent/malformed tests; rendered schema tests. | Medium |
| FAQ extraction | `wavespestcontrol-astro-:src/lib/blog-structured-data.ts` | Finds a FAQ heading, then extracts lower-level question headings ending in `?` and non-empty answers. Limits to 8 items. | Harden as canonical extractor or export/duplicate equivalent in portal gate. Add review flag for non-question FAQ headings and schema/body mismatch. | FAQ extractor tests for present, absent, malformed, hidden/non-FAQ, empty answer, markdown links, and heading-depth changes. | Medium |
| Service/page schema normalization | `wavespestcontrol-astro-:src/lib/schema.ts` | Normalizes Organization/LocalBusiness, rewrites schema by domain, strips duplicate FAQPage on non-blog layouts, and applies city LocalBusiness on city hub pages. | Do not duplicate this in portal. Future SEO completion gate should understand that final schema may be normalized Astro-side. | Rendered HTML validation against final output rather than only draft payload. | Medium |
| Astro content schema source | `wavespestcontrol-astro-:packages/blog-schema/schema.ts` | Source of truth for blog frontmatter. Allows `schema_types` values including `Article`, `FAQPage`, and `BreadcrumbList`. Requires title, slug, meta description, primary keyword, taxonomy, service areas, author/reviewer/fact-check fields, hero image, canonical, and schema types. | Add SEO contract either beside this source schema in Astro or as a portal-side companion that references it. If adding `BlogPosting`, update enum and generated JSON schema upstream, then sync vendor. | Schema generation test upstream; portal vendor drift check; frontmatter validation tests. | High |
| Vendored portal schema | `packages/blog-schema/schema.ts`, `packages/blog-schema/schema.json`, `packages/blog-schema/README.md`, `packages/blog-schema/scripts/sync-from-astro.js`, `packages/blog-schema/scripts/verify-vendor.js` | Portal vendors Astro blog schema and verifies checksum during build. README says not to edit directly; sync from Astro after upstream changes. | Do not edit vendored schema directly unless syncing from Astro. Future SEO contract changes should follow upstream-first flow. | `npm run verify:blog-schema`; schema validator tests. | High |
| Portal frontmatter validation | `server/services/content-astro/schema-validator.js` | Validates frontmatter against vendored JSON schema, allowing the emitted `domains` extension. Used before Astro publish. | Extend or wrap with SEO contract validation in follow-up PR. Missing SEO completion fields should fail before PR creation where they are required. | Frontmatter and SEO contract validation tests. | Medium |
| Generated blog frontmatter builder | `server/services/content-astro/astro-publisher.js` | `buildFrontmatter()` maps DB blog rows to Astro frontmatter, estimates reading time, normalizes category/post type/service areas/target sites, and sets `schema_types` using `schemaTypesForContent(post.content, ['Article'])`. Adds `FAQPage` when visible FAQ section is detected. | Add or consume SEO contract fields. Consider `BlogPosting` decision. Keep conditional FAQPage. Ensure breadcrumbs are not requested unless visible breadcrumbs render Astro-side. | Existing `blog-astro-pipeline.test.js` plus SEO contract fixtures. | Medium |
| Autonomous draft publisher | `server/services/content-astro/astro-publisher.js` | `publishOrUpdatePage()` supports only `new_supporting_blog` drafts. Validates frontmatter and canonical, writes `src/content/blog/{slug}.md`, opens Astro PR, comments `@codex review`, and returns `status: pr_open` without live URL. | Run SEO completion gate before PR creation. Put SEO findings and internal-link recommendations into the PR body. P0 should block PR creation; P1 should be visible as needs-fix/review if PR creation is allowed. | Publisher tests for P0 blocking, PR checklist, link recommendations, and Codex comment. | High |
| Manual/admin Astro publish path | `server/services/content-astro/astro-publisher.js` | `publishAstro(postId)` publishes DB `blog_posts` rows to Astro PRs with hero image, markdown, PR body, Codex review comment, and status updates. | Keep compatible. If SEO completion applies to manual posts, make it opt-in or review-only first to avoid breaking existing admin publishing. | Existing publish tests plus manual blog fixture. | Medium |
| Codex PR tagging | `server/services/content-astro/astro-publisher.js` | `requestCodexReview()` comments `@codex review` with head SHA/context. `mergeAstro()` requires a clean Codex review unless `ASTRO_REQUIRE_CODEX_REVIEW=false`. Usage-limit comments are not considered clean. | Add SEO checklist/findings to PR body before tagging Codex. Do not weaken merge rule. | Existing Codex status tests plus current-head/re-tag checklist test. | Low |
| Cloudflare preview flow | `server/services/content-astro/pages-poll.js`, `server/services/scheduler.js` | Polls Pages every 2 minutes for preview deployments and merged production deployments. Marks preview URLs, build failures, and live status. | Future render validation can consume preview URL once available. Keep publisher/preview separation. | Pages poll tests plus validation script test with mocked HTML. | Medium |
| Autonomous runner | `server/services/content/autonomous-runner.js` | Claims opportunities, composes briefs, dispatches agents, runs uniqueness and quality gates, respects shadow mode, trust-builds live runs, opens Astro PRs only through supported publisher path, and parks PR-pending output for review. | Insert SEO completion gate after writer output and before Astro PR creation. Persist SEO findings in run/review payload. Keep shadow behavior unchanged. | `autonomous-runner.test.js` for P0, P1, shadow, and PR-pending paths. | High |
| Brief builder | `server/services/content/content-brief-builder.js` | Builds structured briefs from opportunity, SERP, customer, and conversion signals. Supporting blog required sections include hub link, city/SWFL framing, 2+ H2s, pro-tip, FAQ section, and CTA. Schema types for supporting blog are `Article` + `BreadcrumbList`. Internal links are simple hub/city links. | Add `seoRequirements`, content cluster, pest-practices requirement, CTA requirements, and internal-link recommendation requirements. Do not fabricate category breadcrumbs. | `content-brief-builder.test.js` for supporting blog, lawn, termite, city, and service fixtures. | Medium |
| Managed writer prompt | `server/services/content/agents/writer-agent-config.js` | Writer handles city-service, customer-question, and supporting-blog drafts. Supporting blog prompt already requires visible FAQ section with 2-3 H3 questions. Prompt says `Article + BreadcrumbList`; customer-question still says no FAQPage schema. | Add pest-practices section, CTA placement, internal-link recommendation expectations, and visible FAQ rules. Align schema language with the final `Article` vs `BlogPosting` decision and FAQ conditional policy. | Agent config snapshot or prompt tests; dispatcher fixture asserts required instructions are present. | Medium |
| Agent tools | `server/services/content/agents/brief-driven-tools.js` | Provides tools for loading briefs, SERP/GSC/customer context, KB search, existing content checks, and draft emission. | If SEO contract is tool-visible, include it in `get_content_brief` output and/or require `emit_draft` to carry contract fields. | Tool contract tests. | Medium |
| Legacy/admin blog writer | `server/services/content/blog-writer.js` | Operator-triggered blog generator. Recently updated to include visible FAQ output. | Keep separate from autonomous SEO completion unless explicitly extending manual admin generation. | Existing admin content tests. | Low |
| Quality gate | `server/services/content/content-quality-gate.js` | Common hard checks include schema, spam, SERP/GSC signals, duplicate intent, canonical, indexable, sitemap, preview. Supporting-blog checks include hub link, two city mentions, FAQ section, and voice match. Does not verify breadcrumbs, article schema, FAQ/schema parity, CTA placement, pest practices, or internal-link mix. | Extend with a separate SEO completion gate instead of overloading this file, then optionally feed summarized results into this gate. P0 findings should block PR creation. | New `seoCompletionGate` tests plus existing quality gate tests. | High |
| Uniqueness gate | `server/services/content/uniqueness-gate.js` | Used for city-service and customer-question pages. Runner requires `ASTRO_REPO_DIR` for live sibling corpus loading. Supporting blogs do not currently require this gate. | Keep city-service/customer-question in manual/shadow until `ASTRO_REPO_DIR` and corpus access are configured. SEO completion should not assume uniqueness corpus in production. | Existing uniqueness tests plus runner missing-corpus path. | Medium |
| Internal-link planner | `server/services/content/internal-link-planner.js` | Plans anchor insertion tasks from a local Astro corpus. Avoids self-links, existing links, markdown/html excluded regions, duplicate anchors, and unsupported hosts. Runner only queues tasks when live URL exists. `add_internal_links` action stays shadowed unless explicitly unshadowed. | Add a recommendation engine for generated drafts that does not edit existing pages. Include city/service/conversion/related-blog/hub recommendations in draft metadata, review queue, and PR body. Keep reverse-link insertion future-only. | Internal-link recommendation tests, shadow-mode tests, current-page/dedupe/generic anchor tests. | High |
| Admin review read model | `server/services/content/autonomous-review-queue.js` | Lists pending-review opportunities, latest brief/run, draft summary, quality/uniqueness gate summary, and actions. Decisions are requeue, dismiss, and approve trust-build. | Add SEO completion summary, P0/P1/P2 findings, recommended links, CTA/pest-practices/FAQ/breadcrumb status, and schema status. Keep decisions compatible. | `autonomous-review-queue.test.js` for new fields and backward compatibility. | Medium |
| Admin review UI | `client/src/pages/admin/AutonomousContentReviewPage.jsx` | Displays queue KPIs, selected row details, basic gate summary, meta description, draft preview, and review actions. | Add structured SEO completion panel and recommended link display. Avoid nested-card bloat; keep it dense and scan-friendly. | React/component test if available; build test; manual screenshot check if UI changes. | Medium |
| Admin content routes | `server/routes/admin-content-v2.js` | Exposes autonomous review list/detail/decision endpoints and manual blog CRUD/publish routes. | Extend review API response through read model first. Add no new publishing endpoint for this layer unless needed. | Route tests for response shape. | Low |
| Content registry | `server/services/content/content-registry.js`, `server/routes/admin-content-registry.js`, `client/src/pages/admin/ContentRegistryPage.jsx` | Reconciles DB rows with Astro content through local filesystem or GitHub source. Used for inventory and live status. | Use as a source for future internal-link inventory and duplicate/corpus checks. Do not block PR 1 on changes here. | Existing registry tests. | Medium |
| GSC opportunity miner | `server/services/seo/gsc-opportunity-miner.js` | Mines buckets and maps to action types such as refresh, city-service, supporting blog, metadata rewrite, and do-not-publish. | No change in SEO completion layer except to carry cluster classification into briefs where useful. | Existing miner tests or targeted fixture tests. | Low |
| Decision router | `server/services/content/decision-router.js` | Routes opportunities, blocks do-not-publish/cannibalization/page-type mismatch patterns for human review. | No immediate change. Future SEO completion should preserve human-review flags. | Router tests for human-review signals. | Low |
| Scheduler | `server/services/scheduler.js` | Runs autonomous content daily Mon-Fri at 9 AM ET behind feature gate. Polls Cloudflare Pages every 2 minutes. | No change. SEO completion should run inside runner, not scheduler. | Existing scheduler tests. | Low |
| CLI/manual runner | `server/scripts/run-autonomous-next.js`, `server/scripts/approve-autonomous-run.js` | Manual dry-run/live-shadow execution and trust-build approval. | Include SEO completion result in CLI output in a follow-up PR. | CLI output snapshot or integration test. | Low |
| Render validation command | Not present | No generated-blog rendered HTML validator exists in portal. Astro build/render tests may exist upstream, but not mapped locally. | Add a script such as `server/scripts/validate-generated-blog-render.js` or an npm script that validates rendered HTML/preview. | Script tests with static fixture HTML and non-zero failure assertions. | Medium |
| SEO contract | Not present | Existing frontmatter schema validates Astro frontmatter; brief/gate/publisher do not share a single SEO completion contract. | Add `BlogSeoContract` or repo-equivalent shared module consumed by brief builder, writer output, SEO gate, publisher, and review queue. | Contract validation tests for required fields and FAQ/breadcrumb/schema invariants. | High |

## Unknowns and Follow-Up Checks

- The active Astro repo is `wavespestcontrol-astro-`, but the portal default is `wavespestcontrol-astro`. Verify production `GITHUB_ASTRO_REPO` before changing publisher behavior.
- The Astro repo is not cloned locally as `../wavespestcontrol-astro`; the portal's `sync:blog-schema` default path will fail locally unless `BLOG_SCHEMA_ASTRO_REPO` is set or the repo is cloned.
- Breadcrumb cleanup appears to be underway separately. The SEO completion layer should consume that final resolver rather than duplicating its route rules in the portal.
- Google FAQ rich results are limited/deprecated, so FAQ success should be based on valid visible content and conditional schema, not guaranteed Search Console FAQ enhancements.
- `ASTRO_REPO_DIR` is not required for supporting-blog review mode, but it is required before live uniqueness/corpus automation for city-service/customer-question pages.

## Recommended Follow-Up PR Order

1. Breadcrumb cleanup in Astro: topical local hub resolver, visible breadcrumbs, and matching `BreadcrumbList`.
2. Blog article schema decision: keep `Article` or switch generated blog posts to `BlogPosting`, then align Astro and portal schema enums.
3. Blog SEO contract: shared validation object for generated supporting-blog output.
4. FAQ hardening: shared/exposed extractor, conditional `FAQPage`, and gate findings.
5. Internal-link recommendations: draft/review/PR recommendations only; no existing-page edits.
6. Pest-practices brief and writer requirements.
7. CTA resolver and placement checks.
8. SEO completion gate: P0/P1/P2 findings, persisted in run/review payload.
9. Admin review SEO panel and PR checklist.
10. Rendered HTML validation script/command.

## Acceptance Criteria for This PR

- [x] No production behavior changes.
- [x] No shadow flags changed.
- [x] Relevant portal files mapped.
- [x] Relevant Astro files mapped from the active remote repo where accessible.
- [x] Unknowns clearly marked.
- [x] Follow-up PRs listed in order.
