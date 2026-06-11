/**
 * intercept-brief-seeder.js — operator-authored competitor-intercept briefs
 * → opportunity_queue rows that flow through the EXISTING autonomous chain
 * (claim → decision-router → brief → writer agent → gates → hero → Astro PR
 * → poller auto-merge → IndexNow/links) with zero human touchpoints.
 *
 * Source of truth: server/data/intercept-briefs-v1.json (13 briefs,
 * clusters A/B/C/D/F; E1 deliberately absent — never re-add door-to-door
 * content). Each brief carries the full editorial plan (thesis, outline,
 * required sources, verify notes, internal links, CTA codes, byline,
 * schema types) that the content-brief-builder injects VERBATIM into the
 * writer agent's brief instead of regenerating it from signals.
 *
 * Design decisions (each verified against the existing engine):
 *  - bucket 'operator_intercept': decision-router treats this bucket as
 *    operator-PINNED — no SERP-profile action upgrades, no do_not_publish
 *    demotion, no park-for-review bucket rules. The action the operator
 *    chose is the action that runs.
 *  - skipSerp: the runner composes these briefs without SERP profiling
 *    (several primary keywords are competitor-brand queries that a SERP
 *    profiler would mis-read as "navigational"; the operator already did
 *    the SERP homework). content-quality-gate exempts the serp/gsc
 *    evidence-attachment hard checks for this bucket — the operator
 *    manifest IS the provenance.
 *  - city = NULL on every row: these are SWFL-wide consumer-protection /
 *    comparison posts, not city×service local-claim pages, so the
 *    facts-sufficiency gate correctly reports "not applicable" (no
 *    city/service anchor) instead of parking them for facts gaps. Local
 *    color comes from the operator outline (which the LLM fact-check gate
 *    still verifies at publish).
 *  - service = truthful coarse category ('pest' / 'lawn' / 'termite').
 *    The termite-cluster briefs (C1/C2/F1) are labeled 'termite' even
 *    though 'termite' is on FAQ_BLOCKED_SERVICES: the operator manifest
 *    explicitly mandates an FAQPage on every intercept post (owner
 *    directive 2026-06-11), so instead of mislabeling the service to dodge
 *    the guard, the FAQ policy carries a NARROW, explicit operator
 *    exception — operator_brief.faq_required=true (derived from the
 *    manifest payload) is honored by content-guardrails (via the runner's
 *    operatorFaqException flag) and content-quality-gate. Every mined
 *    opportunity still gets the full FAQ_BLOCKED_SERVICE enforcement.
 *  - dedupe_key `intercept:v1:<id>` + ON CONFLICT DO UPDATE → idempotent
 *    re-runs (same status-preserving CASE as gsc-opportunity-miner: a
 *    claimed/done/pending_review row is never reset by a re-seed).
 *  - window: 'immediate' → available_at NULL (claimable now). A future
 *    YYYY-MM-DD window → available_at at midnight ET of that date;
 *    claimNext()/peek() filter (available_at IS NULL OR available_at <=
 *    now()), so the row self-activates with no cron hook.
 *  - scores follow the manifest priority order (A=88, B1=86, B2–B5=84,
 *    C/D/F=82) — all clear the 75 non-blog floor (A0's refresh action) and
 *    the 45 blog floor with room to outrank routine mined opportunities.
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');
const { parseETDateTime } = require('../../utils/datetime-et');

const OPERATOR_INTERCEPT_BUCKET = 'operator_intercept';
const DEDUPE_PREFIX = 'intercept:v1:';
const DEFAULT_MANIFEST_PATH = path.join(__dirname, '../../data/intercept-briefs-v1.json');
const EXPIRES_DAYS_AFTER_AVAILABLE = 45;

// Manifest priority order → fixed scores. Must clear the 75 non-blog floor
// (A0 refresh) and the 45 blog floor (everything else).
function scoreForBrief(brief) {
  if (brief.cluster === 'A') return 88;
  if (brief.id === 'B1') return 86;
  if (brief.cluster === 'B') return 84;
  return 82; // C / D / F
}

// Coarse engine service category, labeled TRUTHFULLY from the slug prefix —
// termite-cluster briefs are 'termite' even though that id is FAQ-blocked;
// the operator FAQ mandate flows through the explicit faq_required override
// instead of a service mislabel (see header).
function serviceForBrief(brief) {
  const slug = String(brief.slug || brief.page_url || '');
  if (slug.includes('/lawn-care/')) return 'lawn';
  if (slug.includes('/termite/')) return 'termite';
  return 'pest';
}

// Byline mapping. The Astro authors collection has a single Adam record
// (adam-benetti); 'adam-augusta' is the SAME author with his golf-course
// turf background (Augusta National) emphasized in the body for lawn-post
// E-E-A-T — there is no separate author record, so both map to the same
// frontmatter block and 'adam-augusta' adds a body-emphasis instruction.
const BYLINE_AUTHORS = {
  adam: {
    author_slug: 'adam-benetti',
    frontmatter: {
      name: 'Adam Benetti',
      role: 'Founder & Lead Technician',
      fdacs_license: 'JB351547',
      years_swfl: 12,
      bio_url: '/about/authors/adam-benetti',
    },
    emphasis: null,
  },
  'adam-augusta': {
    author_slug: 'adam-benetti',
    frontmatter: {
      name: 'Adam Benetti',
      role: 'Founder & Lead Technician',
      fdacs_license: 'JB351547',
      years_swfl: 12,
      bio_url: '/about/authors/adam-benetti',
    },
    emphasis: 'Lawn-post E-E-A-T: naturally reference Adam\'s professional turf-care background (Augusta National groundskeeping) once in the intro or an early section. Same author record as every other post — the emphasis lives in the body, not the author block.',
  },
};

function dedupeKeyFor(brief) {
  return `${DEDUPE_PREFIX}${brief.id}`;
}

function availableAtFor(brief) {
  const window = String(brief.window || 'immediate').trim();
  if (!window || window.toLowerCase() === 'immediate') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window)) {
    throw new Error(`intercept brief ${brief.id}: unrecognized window "${window}" (expected "immediate" or YYYY-MM-DD)`);
  }
  // Midnight ET of the window date — the row becomes claimable on that
  // ET day (the engine cron runs 9am ET).
  return parseETDateTime(`${window}T00:00`);
}

function isOperatorIntercept(opportunity = {}) {
  if (!opportunity) return false;
  if (opportunity.bucket === OPERATOR_INTERCEPT_BUCKET) return true;
  const meta = opportunity.signal_metadata;
  return !!(meta && typeof meta === 'object' && meta.operator_pinned === true);
}

function loadManifest(file = DEFAULT_MANIFEST_PATH) {
  const raw = fs.readFileSync(file, 'utf8');
  const manifest = JSON.parse(raw);
  if (!Array.isArray(manifest.briefs) || manifest.briefs.length === 0) {
    throw new Error(`intercept manifest at ${file} has no briefs`);
  }
  for (const brief of manifest.briefs) {
    if (!brief.id || !brief.action) {
      throw new Error(`intercept manifest entry missing id/action: ${JSON.stringify(brief).slice(0, 120)}`);
    }
    if (String(brief.id).toUpperCase().startsWith('E')) {
      // Owner directive 2026-06-11: no door-to-door content, ever.
      throw new Error(`intercept manifest contains an E-cluster brief (${brief.id}) — door-to-door content is excluded by owner directive`);
    }
  }
  return manifest;
}

function rowForBrief(brief, manifest, { now = new Date() } = {}) {
  const score = scoreForBrief(brief);
  const availableAt = availableAtFor(brief);
  const expiresBase = availableAt || now;
  const expiresAt = new Date(expiresBase.getTime() + EXPIRES_DAYS_AFTER_AVAILABLE * 86400_000);
  return {
    bucket: OPERATOR_INTERCEPT_BUCKET,
    action_type: brief.action,
    query: brief.primary_kw || null,
    page_url: brief.page_url || null,
    service: serviceForBrief(brief),
    city: null, // deliberate — keeps the facts gate "not applicable" (see header)
    score,
    score_breakdown: { base: score, operator_priority: `manifest ${manifest.set || 'intercept'} / cluster ${brief.cluster}` },
    signal_metadata: {
      source: 'intercept-brief-seeder',
      operator_pinned: true,
      manifest_set: manifest.set || null,
      manifest_version: manifest.version || null,
      intercept_brief: brief,
      manifest_notes: manifest.notes || null,
      cta_codes: manifest.cta_codes || {},
    },
    status: 'pending',
    mined_at: now,
    expires_at: expiresAt,
    available_at: availableAt,
    dedupe_key: dedupeKeyFor(brief),
  };
}

/**
 * Upsert every manifest brief into opportunity_queue. Idempotent: re-runs
 * update payload/score/window in place via ON CONFLICT (dedupe_key); the
 * status CASE mirrors gsc-opportunity-miner.persistAll — claimed / done /
 * pending_review rows are never reset, while skipped/expired rows revive to
 * pending (an operator re-seed is an explicit "run these" signal).
 */
async function seedAll({ file = DEFAULT_MANIFEST_PATH, dryRun = false, now = new Date() } = {}) {
  const manifest = loadManifest(file);
  const rows = manifest.briefs.map((brief) => rowForBrief(brief, manifest, { now }));
  if (dryRun) return { dryRun: true, count: rows.length, rows };

  let count = 0;
  for (const row of rows) {
    const result = await db.raw(
      `INSERT INTO opportunity_queue
         (bucket, action_type, query, page_url, service, city,
          score, score_breakdown, signal_metadata, status,
          mined_at, expires_at, available_at, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown,
             signal_metadata = EXCLUDED.signal_metadata,
             mined_at = EXCLUDED.mined_at,
             expires_at = EXCLUDED.expires_at,
             available_at = EXCLUDED.available_at,
             action_type = EXCLUDED.action_type,
             status = CASE WHEN opportunity_queue.status IN ('claimed', 'done', 'pending_review')
                           THEN opportunity_queue.status
                           ELSE 'pending'
                      END,
             updated_at = now()
      `,
      [
        row.bucket, row.action_type, row.query, row.page_url, row.service, row.city,
        row.score, JSON.stringify(row.score_breakdown), JSON.stringify(row.signal_metadata), row.status,
        row.mined_at, row.expires_at, row.available_at, row.dedupe_key,
      ]
    );
    count += result.rowCount || 1;
  }
  logger.info(`[intercept-brief-seeder] seeded ${count}/${rows.length} intercept brief(s) from ${path.basename(file)}`);
  return { dryRun: false, count, rows };
}

// ── brief overlay (consumed by content-brief-builder) ────────────────

const FAQ_SECTION_RE = /\bfaq\b|frequently asked|common questions/i;

/**
 * Build the operator overlay the content-brief-builder applies when it
 * composes a brief for an operator_intercept opportunity. The overlay is
 * VERBATIM operator material — thesis/outline/sources/links/byline reach
 * the writer agent as binding instructions, not signal-derived guesses.
 *
 * required_sections = the operator outline (the content plan), followed by
 * the standard page-type structural sections that aren't already covered
 * (the seo-completion-gate keys faqRequired off this list, and the house
 * structure — hub link, early/final CTA — still applies). When the outline
 * already includes an FAQ item, the standard FAQ section is dropped so the
 * operator's question count wins.
 */
function buildOperatorOverlay({ opportunity, pageType, requiredSections = [], schemaTypes = [] }) {
  const meta = (opportunity && typeof opportunity.signal_metadata === 'object' && opportunity.signal_metadata) || {};
  const payload = meta.intercept_brief;
  if (!payload) return null;

  const outline = Array.isArray(payload.outline) ? [...payload.outline] : [];
  const outlineHasFaq = outline.some((s) => FAQ_SECTION_RE.test(String(s || '')));
  const structural = requiredSections.filter((s) => {
    if (outlineHasFaq && FAQ_SECTION_RE.test(String(s || ''))) return false; // operator FAQ spec wins
    return !outline.includes(s);
  });

  // Operator schema_types + the house BreadcrumbList requirement (the SEO
  // completion gate P1s a supporting blog whose schema_types omit it).
  //
  // REFRESH exception (A0): publishRefresh freezes the live page's schema/
  // frontmatter — only body + editable title/meta ship — so requiring new
  // schema_types on a refresh brief would let the runner accept a draft
  // schema that silently never lands on the Astro page. Keep the refresh
  // contract's preserve-existing schema list and route the operator's
  // schema request to the human reviewer instead (refresh_schema_note +
  // binding instruction → notes_for_reviewer); the refresh lane parks for
  // review in prod, so the reviewer applies it manually.
  const isRefresh = pageType === 'refresh' || payload.action === 'refresh_existing_page';
  const schema = isRefresh
    ? [...schemaTypes]
    : Array.from(new Set([
      ...(Array.isArray(payload.schema_types) ? payload.schema_types : []),
      ...(pageType === 'supporting-blog' ? ['Article', 'BreadcrumbList'] : []),
      ...schemaTypes,
    ]));

  const byline = BYLINE_AUTHORS[payload.byline] || BYLINE_AUTHORS.adam;
  const ctaCodes = meta.cta_codes || {};
  const ctaDirectives = (Array.isArray(payload.cta) ? payload.cta : [])
    .map((code) => `${code}: ${ctaCodes[code] || 'see manifest'}`);

  const operatorBrief = {
    id: payload.id,
    set: meta.manifest_set || null,
    working_title: payload.working_title || null,
    intent: payload.intent || null,
    slug: payload.slug || null,
    page_url: payload.page_url || null,
    thesis: payload.thesis || null,
    outline,
    primary_kw: payload.primary_kw || null,
    secondary_kws: Array.isArray(payload.secondary_kws) ? payload.secondary_kws : [],
    required_sources: Array.isArray(payload.sources) ? payload.sources : [],
    verify_notes: Array.isArray(payload.verify_notes) ? payload.verify_notes : [],
    internal_links_required: Array.isArray(payload.internal_links) ? payload.internal_links : [],
    schema_types: Array.isArray(payload.schema_types) ? payload.schema_types : [],
    // Explicit operator FAQ mandate (owner directive 2026-06-11: FAQPage on
    // every intercept post). content-guardrails / content-quality-gate honor
    // this as a NARROW exception to the FAQ_BLOCKED_SERVICE policy — derived
    // from the manifest payload, never from generated content.
    faq_required: (Array.isArray(payload.schema_types) && payload.schema_types.includes('FAQPage'))
      || outlineHasFaq,
    cta_directives: ctaDirectives,
    byline: {
      key: payload.byline || 'adam',
      author_slug: byline.author_slug,
      author_frontmatter: byline.frontmatter,
      emphasis: byline.emphasis,
    },
    global_rules: meta.manifest_notes || null,
    // Surfaced for the human reviewer on the refresh lane: requested schema
    // additions cannot ship through publishRefresh (schema is frozen).
    refresh_schema_note: isRefresh && Array.isArray(payload.schema_types) && payload.schema_types.length
      ? `Operator requests ${payload.schema_types.join(' + ')} schema on this page, but the refresh publisher freezes live schema/frontmatter — apply the schema change manually (or via a follow-up page edit) when reviewing this parked refresh.`
      : null,
    binding_instructions: buildBindingInstructions({ payload, byline, ctaDirectives, globalRules: meta.manifest_notes, isRefresh }),
  };

  return {
    required_sections: [...outline, ...structural],
    schema_types: schema,
    internal_links: operatorBrief.internal_links_required,
    operator_brief: operatorBrief,
  };
}

function buildBindingInstructions({ payload, byline, ctaDirectives, globalRules, isRefresh = false }) {
  const lines = [
    'This is an OPERATOR-AUTHORED intercept brief. Everything below is BINDING — do not re-derive the topic, angle, slug, or sources.',
    payload.working_title ? `TITLE DIRECTION: "${payload.working_title}" — refine for length/SEO but keep the meaning and promise intact.` : null,
    payload.slug ? `SLUG (exact, binding): ${payload.slug} — set frontmatter slug and canonical to match exactly.` : null,
    payload.thesis ? `THESIS (the post must argue exactly this): ${payload.thesis}` : null,
    'OUTLINE: cover every outline item in the brief\'s required_sections, in order — they are the content plan, not suggestions.',
    payload.sources?.length
      ? `REQUIRED SOURCES (cite IN-POST): every source below must be linked in the body with explicit attribution (name the source where you cite it). Quote exactly where the brief calls for verbatim quotes. Sources: ${payload.sources.join(' | ')}`
      : null,
    ...(Array.isArray(payload.verify_notes) ? payload.verify_notes.map((n) => `VERIFY BEFORE WRITING (mandatory): ${n} If a claim cannot be verified against the cited source, OMIT the claim entirely.`) : []),
    payload.internal_links?.length
      ? `REQUIRED INTERNAL LINKS (each must appear as a natural in-body anchor): ${payload.internal_links.join(', ')}. You may add further house-style internal links beyond these.`
      : null,
    `AUTHOR (exact frontmatter author block): ${JSON.stringify(byline.frontmatter)}.`,
    byline.emphasis || null,
    ctaDirectives.length ? `CTAs: ${ctaDirectives.join(' || ')}` : null,
    // Refresh lane cannot ship schema changes (publishRefresh freezes live
    // schema/frontmatter) — convert the operator's schema request into an
    // explicit reviewer note instead of an instruction the publisher would
    // silently drop.
    payload.schema_types?.length && isRefresh
      ? `SCHEMA (refresh limitation): the refresh publisher ships body + title/meta ONLY — live schema/frontmatter are frozen and any schema you emit will NOT land on the page. Do not treat ${payload.schema_types.join(' + ')} as deliverable here; instead list the operator's requested schema additions in notes_for_reviewer so the human reviewer applies them when this parked refresh is approved.`
      : null,
    payload.schema_types?.length && !isRefresh
      ? `SCHEMA: emit ${payload.schema_types.join(' + ')} structured data with matching VISIBLE content (FAQPage requires the visible FAQ section; HowTo requires visible steps). The operator manifest explicitly REQUIRES the FAQ section for this post (owner directive 2026-06-11) — this operator mandate overrides the default no-FAQ rule for blocked topics for THIS brief only; include the FAQ section as outlined.`
      : null,
    globalRules ? `GLOBAL RULES (apply to every intercept post): ${globalRules}` : null,
    'COMPARISON DISCLAIMER: end the post with a short footer noting competitor pricing/terms are as of the publish date and readers should verify current terms directly.',
    'Never hardcode Waves pricing — link to /pest-control-calculator/ instead.',
    // The publish-time price guards (content-guardrails + seo-completion-gate)
    // P0 any bare dollar figure unless one of their allowance words sits
    // within ~80 characters. The manifest REQUIRES sourced competitor dollar
    // figures, so the framing rule below is what makes those two requirements
    // compatible — without it a compliant draft gets routed out as
    // HARDCODED_PRICE.
    'COMPETITOR PRICING FRAMING (mandatory for every dollar figure): each competitor dollar amount must appear in the same sentence as at least one of these exact words: "quote", "range", "pricing varies", "depends", or "estimate" — AND carry a dated source attribution. Example: "Aptive\'s early-cancellation fee is $199 as of June 2026 per ConsumerAffairs, though quoted pricing varies by contract." A bare dollar figure with none of those words nearby will block the post at the publish-time price guard.',
  ];
  return lines.filter(Boolean);
}

// ── archive.org snapshot-on-publish ──────────────────────────────────

/**
 * snapshotSources(sources) — request a Wayback Machine capture of every
 * http(s) source URL via https://web.archive.org/save/<url>. STRICTLY
 * fail-soft: per-URL timeout, errors recorded per entry, never throws,
 * never blocks publish. Non-URL source entries (e.g. "UF/IFAS for
 * pre-treat longevity claims") are skipped.
 *
 * Returns { attempted, ok, snapshots: [{ url, snapshot_url, ok, error? }] }.
 */
async function snapshotSources(sources, { fetchImpl = global.fetch, timeoutMs = 20000, now = () => new Date() } = {}) {
  const urls = (Array.isArray(sources) ? sources : [])
    .map((s) => String(s || '').trim())
    .filter((s) => /^https?:\/\//i.test(s));
  const snapshots = [];
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(fetchImpl, `https://web.archive.org/save/${url}`, timeoutMs);
      const contentLocation = res?.headers?.get ? res.headers.get('content-location') : null;
      const snapshotUrl = contentLocation
        ? `https://web.archive.org${contentLocation}`
        : (res?.url && res.url !== `https://web.archive.org/save/${url}` ? res.url : null);
      snapshots.push({
        url,
        snapshot_url: snapshotUrl || `https://web.archive.org/web/${waybackTimestamp(now())}/${url}`,
        ok: !!res?.ok,
        status: res?.status ?? null,
        captured_at: now().toISOString(),
      });
    } catch (err) {
      snapshots.push({ url, snapshot_url: null, ok: false, error: String(err.message || err).slice(0, 300), captured_at: now().toISOString() });
    }
  }
  const okCount = snapshots.filter((s) => s.ok).length;
  if (urls.length) {
    logger.info(`[intercept-brief-seeder] archive.org snapshots: ${okCount}/${urls.length} captured`);
  }
  return { attempted: urls.length, ok: okCount, snapshots };
}

// Wayback date-prefixed URL (https://web.archive.org/web/<ts>/<url>) resolves
// to the nearest capture at/before <ts> — a stable pointer even when the save
// API responds without a content-location header.
function waybackTimestamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller ? controller.signal : undefined,
      headers: { 'user-agent': 'WavesPestControl-ContentEngine/1.0 (+https://www.wavespestcontrol.com)' },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  OPERATOR_INTERCEPT_BUCKET,
  DEFAULT_MANIFEST_PATH,
  loadManifest,
  seedAll,
  isOperatorIntercept,
  buildOperatorOverlay,
  snapshotSources,
  _internals: {
    scoreForBrief,
    serviceForBrief,
    dedupeKeyFor,
    availableAtFor,
    rowForBrief,
    buildBindingInstructions,
    BYLINE_AUTHORS,
    EXPIRES_DAYS_AFTER_AVAILABLE,
    waybackTimestamp,
  },
};
