/**
 * Newsletter unit tests — pure-function regression coverage for the
 * highest-blast-radius helpers. No DB access (Knex .toSQL() inspects
 * generated SQL without executing). No SendGrid calls.
 *
 * Scope:
 *   - buildSubscriberQuery: encodes the segment-filter contract that
 *     Compose's audience picker depends on. A regression here silently
 *     mails the wrong audience.
 *   - EMAIL_RE / escapeHtml from public-newsletter: defenses for the
 *     stored-XSS class of bug fixed in PR §2.1.
 *   - computeNewsletterEventUpdates: the per-event update planner
 *     extracted from the webhook handler. Encodes the §1.1 fix
 *     (per-recipient event matching) and the idempotency guards
 *     (already-delivered events are no-ops). A regression here
 *     silently corrupts campaign analytics or double-applies events.
 */

const { buildSubscriberQuery, excludeGloballySuppressed, narrowServiceLineFilter, sanitizePersonalizationToken } = require('../services/newsletter-sender');
const db = require('../models/db');
const publicRouter = require('../routes/public-newsletter');
const sendgridWebhook = require('../routes/webhooks-sendgrid');
const {
  lockEventFactsFromDb,
  markdownToHtml,
  sanitizeProseFields,
  safeUrl,
  assembleBeehiivNewsletter,
} = require('../services/newsletter-draft');
const { findHallucinatedClaims, validateNewsletterDraft } = require('../services/newsletter-validator');
const { preflightDigest } = require('../services/newsletter-autopilot');
const { computeSendRates, aggregateSendMetrics, ratesFromTotals } = require('../services/newsletter-analytics');
const { gbpFallbackByLocation, normalizeGbpByLocation } = require('../services/content-scheduler');
const { normalizeEventTitle, findDuplicateClusters, rewriteCalendarEventIds } = require('../services/event-duplicates');
const { pickSurvivor, isCleanCrossSourceCluster, isAutoMergeableCluster, computeSurvivorBackfill } = require('../services/event-dedup');
const { isEligibleForFreshDigest, cityToZone, weekLockKey } = require('../services/event-freshness');
const { WAVES_LOCATIONS } = require('../config/locations');
const { getFlagshipType } = require('../config/newsletter-types');
const { EMAIL_RE, escapeHtml } = publicRouter;
const {
  computeNewsletterEventUpdates,
  computeEmailMessageEventUpdates,
  suppressionForEmailEvent,
  automationSuppressionGroupKeyForEvent,
  isFreshTimestamp,
  deliveryEmailMismatchLogMessage,
  canUseDeliveryIdFallback,
  canUseProviderMessageMatch,
  bindNewsletterDeliveryMessageId,
  reconcileNewsletterSendStatus,
  handleNewsletterEvent,
  newsletterSuppressionGroupKeyForEvent,
} = sendgridWebhook;

describe('newsletter buildSubscriberQuery', () => {
  // Knex .toSQL() returns { sql, bindings } from the query builder
  // without opening a DB connection — perfect for shape assertions.
  const shapeOf = (filter) => buildSubscriberQuery(filter).toSQL();

  test('null filter targets every active subscriber', () => {
    const { sql, bindings } = shapeOf(null);
    expect(sql).toMatch(/from "newsletter_subscribers"/);
    expect(sql).toMatch(/"status" = (?:\$1|\?)/);
    expect(bindings).toContain('active');
    expect(sql).not.toMatch(/customer_id/);
    expect(sql).not.toMatch(/source/);
    expect(sql).not.toMatch(/tags/);
  });

  test('always anti-joins the global email_suppressions ledger (bounce/spam/do_not_email)', () => {
    const { sql, bindings } = shapeOf(null);
    expect(sql).toMatch(/not exists/i);
    expect(sql).toMatch(/email_suppressions/);
    expect(bindings).toEqual(expect.arrayContaining(['bounce', 'spam_complaint', 'do_not_email']));
  });

  test('suppression anti-join is present even with a segment filter applied', () => {
    const { sql } = shapeOf({ customersOnly: true });
    expect(sql).toMatch(/email_suppressions/);
    expect(sql).toMatch(/"customer_id" is not null/);
  });

  // The resume/retry path does NOT call buildSubscriberQuery — it reuses this
  // shared helper directly (Codex #1346 P1). Pin that the helper emits the same
  // global-suppression exclusion so resumed sends honor it too.
  test('excludeGloballySuppressed adds the global email_suppressions anti-join', () => {
    const { sql, bindings } = excludeGloballySuppressed(
      db('newsletter_subscribers').where({ status: 'active' }),
    ).toSQL();
    expect(sql).toMatch(/not exists/i);
    expect(sql).toMatch(/email_suppressions/);
    expect(bindings).toEqual(expect.arrayContaining(['bounce', 'spam_complaint', 'do_not_email']));
  });

  test('customersOnly adds customer_id IS NOT NULL', () => {
    const { sql } = shapeOf({ customersOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).not.toMatch(/"customer_id" is null/);
  });

  test('leadsOnly adds customer_id IS NULL', () => {
    const { sql } = shapeOf({ leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is null/);
  });

  // The audience-profiles module + preview script speak { audience: 'customers'
  // | 'leads' }. The send path only runs buildSubscriberQuery (never
  // matchesFilter), so this shape MUST narrow here too — otherwise a saved
  // { audience: 'customers' } segment silently blasts every active subscriber.
  test('audience:customers narrows to customer_id IS NOT NULL (canonical shape)', () => {
    const { sql } = shapeOf({ audience: 'customers' });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).not.toMatch(/"customer_id" is null/);
  });

  test('audience:leads narrows to customer_id IS NULL (canonical shape)', () => {
    const { sql } = shapeOf({ audience: 'leads' });
    expect(sql).toMatch(/"customer_id" is null/);
  });

  test('unknown audience value fails CLOSED (1 = 0), never broadens to all subscribers', () => {
    // Admin routes persist segmentFilter verbatim, so a typo like 'customer'
    // must match nobody (→ EMPTY_SEGMENT guard), not silently drop the filter.
    const { sql } = shapeOf({ audience: 'customer' });
    expect(sql).toMatch(/1 = 0/);
    expect(sql).not.toMatch(/"customer_id" is not null/);
  });

  test('region_zone array binds via whereIn', () => {
    const { sql, bindings } = shapeOf({ region_zone: ['manatee', 'sarasota'] });
    expect(sql).toMatch(/"region_zone" in/);
    expect(bindings).toEqual(expect.arrayContaining(['manatee', 'sarasota']));
    expect(sql).not.toMatch(/1 = 0/);
  });

  test('region_zone single string is coerced to whereIn (not ignored)', () => {
    const { sql, bindings } = shapeOf({ region_zone: 'manatee' });
    expect(sql).toMatch(/"region_zone" in/);
    expect(bindings).toContain('manatee');
    expect(sql).not.toMatch(/1 = 0/);
  });

  test('malformed region_zone (non-string scalar, or array w/ bad element) fails CLOSED', () => {
    expect(shapeOf({ region_zone: 123 }).sql).toMatch(/1 = 0/);
    expect(shapeOf({ region_zone: ['manatee', 123] }).sql).toMatch(/1 = 0/);
    // empty array stays a no-op (no region intent), not a fail-closed.
    expect(shapeOf({ region_zone: [] }).sql).not.toMatch(/1 = 0/);
  });

  test('sources filter binds each value via whereIn', () => {
    const { sql, bindings } = shapeOf({ sources: ['website', 'quote_wizard'] });
    expect(sql).toMatch(/"source" in \((?:\$\d+|\?), (?:\$\d+|\?)\)/);
    expect(bindings).toEqual(expect.arrayContaining(['website', 'quote_wizard']));
  });

  test('empty sources array is a no-op (no whereIn injected)', () => {
    const { sql } = shapeOf({ sources: [] });
    expect(sql).not.toMatch(/"source" in/);
  });

  test('tags filter uses jsonb ?| operator with N bindings', () => {
    const { sql, bindings } = shapeOf({ tags: ['platinum-tier', 'hurricane-prep'] });
    expect(sql).toMatch(/tags \\?\?\| array\[\?,\?\]/);
    expect(bindings).toEqual(expect.arrayContaining(['platinum-tier', 'hurricane-prep']));
  });

  test('combined filters compose all clauses', () => {
    const { sql, bindings } = shapeOf({
      customersOnly: true,
      tags: ['vip'],
      sources: ['admin_manual'],
    });
    expect(sql).toMatch(/"status" = (?:\$1|\?)/);
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"source" in/);
    expect(sql).toMatch(/tags \\?\?\| array/);
    expect(bindings).toEqual(expect.arrayContaining(['active', 'admin_manual', 'vip']));
  });

  test('customersOnly + leadsOnly is a contradiction the query expresses verbatim', () => {
    // The route doesn't reject this — the audit recommended adding a
    // 0-recipient guard at send time (§3.10) and that's where the empty
    // result is caught. The query itself is still well-formed.
    const { sql } = shapeOf({ customersOnly: true, leadsOnly: true });
    expect(sql).toMatch(/"customer_id" is not null/);
    expect(sql).toMatch(/"customer_id" is null/);
  });
});

describe('newsletter narrowServiceLineFilter — fail-closed service-line coercion', () => {
  test('no service-line intent → null (legacy SQL-only path preserved)', () => {
    expect(narrowServiceLineFilter(null)).toBeNull();
    expect(narrowServiceLineFilter({ sources: ['website'] })).toBeNull();
    expect(narrowServiceLineFilter({ missing_service: [] })).toBeNull(); // empty array = no intent
  });

  test('well-formed keys pass through', () => {
    expect(narrowServiceLineFilter({ has_service: ['pest'], missing_service: ['lawn'] }))
      .toEqual({ has_service: ['pest'], missing_service: ['lawn'] });
    expect(narrowServiceLineFilter({ min_line_count: 1, max_line_count: 1 }))
      .toEqual({ min_line_count: 1, max_line_count: 1 });
    expect(narrowServiceLineFilter({ max_line_count: 0 })).toEqual({ max_line_count: 0 }); // 0 is valid
  });

  test('coerces single strings / numeric strings instead of dropping them', () => {
    expect(narrowServiceLineFilter({ missing_service: 'lawn' })).toEqual({ missing_service: ['lawn'] });
    expect(narrowServiceLineFilter({ max_line_count: '1' })).toEqual({ max_line_count: 1 });
  });

  test('intent present but every key malformed → {} (caller must match NOBODY, never everybody)', () => {
    // The footgun: these used to slip past hasServiceLineFilter yet resolve to
    // an empty narrowed filter → selectAudience({}) = all customers.
    expect(narrowServiceLineFilter({ max_line_count: {} })).toEqual({});
    expect(narrowServiceLineFilter({ min_line_count: 'abc' })).toEqual({});
    expect(narrowServiceLineFilter({ missing_service: 123 })).toEqual({});
  });

  test('a malformed element inside a service-line array fails the WHOLE filter closed (no narrow-to-valid-subset)', () => {
    // ['lawn', 123] must NOT resolve to just ['lawn'] — an ambiguous segment
    // can't quietly broaden to the valid subset.
    expect(narrowServiceLineFilter({ missing_service: ['lawn', 123] })).toEqual({});
    expect(narrowServiceLineFilter({ has_service: ['pest', null] })).toEqual({});
    expect(narrowServiceLineFilter({ waveguard_tier: ['Gold', {}] })).toEqual({});
    // ...but a clean multi-element array still passes through.
    expect(narrowServiceLineFilter({ has_service: ['pest', 'lawn'] }))
      .toEqual({ has_service: ['pest', 'lawn'] });
  });

  test('invalid line-counts (negative/fractional/out-of-range) fail the WHOLE filter closed', () => {
    // { min_line_count: -1 } matches every profile (line_count >= -1) — must NOT.
    expect(narrowServiceLineFilter({ min_line_count: -1 })).toEqual({});
    expect(narrowServiceLineFilter({ max_line_count: 1.5 })).toEqual({});
    expect(narrowServiceLineFilter({ max_line_count: 999 })).toEqual({}); // > sellable-line universe
    // A malformed count nukes otherwise-valid keys too (suspect filter → nobody).
    expect(narrowServiceLineFilter({ has_service: ['pest'], min_line_count: -1 })).toEqual({});
  });
});

describe('newsletter sanitizePersonalizationToken — no HTML survives DB substitution', () => {
  test('strips angle brackets / ampersands / slashes (mirrors greeting sanitizer)', () => {
    expect(sanitizePersonalizationToken('<script>alert(1)</script>')).not.toMatch(/[<>&/]/);
    expect(sanitizePersonalizationToken('Bradenton')).toBe('Bradenton');
    expect(sanitizePersonalizationToken("St. Augustine")).toBe('St. Augustine');
    expect(sanitizePersonalizationToken("Lakewood Ranch")).toBe('Lakewood Ranch');
  });

  test('empty / nullish → empty string (caller applies its default label)', () => {
    expect(sanitizePersonalizationToken(null)).toBe('');
    expect(sanitizePersonalizationToken('   ')).toBe('');
  });
});

describe('event cityToZone — kebab/space normalization', () => {
  test('maps space-separated city names', () => {
    expect(cityToZone('Lakewood Ranch')).toBe('manatee');
    expect(cityToZone('north port')).toBe('south_sarasota');
    expect(cityToZone('Sarasota')).toBe('sarasota');
  });

  test('maps kebab-case slugs (scrape prompt + coverage_geo format)', () => {
    expect(cityToZone('lakewood-ranch')).toBe('manatee');
    expect(cityToZone('north-port')).toBe('south_sarasota');
    expect(cityToZone('st-petersburg')).toBe('pinellas');
    expect(cityToZone('punta-gorda')).toBe('south_sarasota');
    expect(cityToZone('siesta-key')).toBe('sarasota');
  });

  test('unknown / empty city returns null', () => {
    expect(cityToZone('Orlando')).toBeNull();
    expect(cityToZone('')).toBeNull();
    expect(cityToZone(null)).toBeNull();
  });
});

describe('event weekLockKey — per-week advisory-lock key', () => {
  test('distinct weeks produce distinct keys (the old per-year-collision bug)', () => {
    const k1 = weekLockKey('2026-05-28');
    const k2 = weekLockKey('2026-06-04');
    const k3 = weekLockKey('2026-01-01');
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });

  test('same week is stable (autopilot + draft-from-plan derive the same key)', () => {
    expect(weekLockKey('2026-05-28')).toBe(weekLockKey('2026-05-28'));
  });

  test('always a non-negative signed-int4 (valid pg advisory-lock key)', () => {
    for (const w of ['2026-05-28', '2025-12-31', '2027-03-10', '', null]) {
      const k = weekLockKey(w);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(2147483647);
    }
  });
});

describe('event ingestion revivalResetFields — past→future re-date clears freshness', () => {
  const { revivalResetFields } = require('../services/event-ingestion');

  test('CASE is gated on OLD effective date past AND NEW effective date future, against the ET-midnight cutoff (not now())', () => {
    const { parseETDateTime, etDateString } = require('../utils/datetime-et');
    const { sql, bindings } = revivalResetFields().normalized_at.toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toMatch(/case when/);
    // OLD side uses the effective date (COALESCE) — not bare start_at — so an
    // in-progress multi-day event (start past, end future) is NOT revived.
    expect(lower).toMatch(/coalesce\(events_raw\.end_at, events_raw\.start_at\) </);
    expect(lower).toMatch(/coalesce\(excluded\.end_at, excluded\.start_at\) >=/);
    // Boundary is the ET-midnight cutoff (same as the expiry sweep) — NOT now() —
    // so an event manually expired earlier *today* is preserved when re-dated forward.
    expect(lower).not.toContain('now()');
    const expected = parseETDateTime(`${etDateString()}T00:00:00`).getTime();
    expect(bindings.length).toBeGreaterThan(0);
    bindings.forEach((b) => expect(new Date(b).getTime()).toBe(expected));
    // Preserves the existing value when the condition is false (manual curation).
    expect(lower).toMatch(/else events_raw\.normalized_at end/);
  });

  test('re-queues via normalized_at + sets the explicit revival marker — never nulls the NOT NULL freshness_status', () => {
    const f = revivalResetFields();
    // freshness_status is NOT NULL in the DB, so the revival must not touch it
    // in the upsert (the normalizer recomputes it instead). It signals revival
    // via normalized_at (re-queue) + freshness_revival_pending (explicit marker
    // the normalizer consumes), plus the curation re-open pair (curated_at /
    // curation_note) — all safe to set in the ON CONFLICT update.
    expect(Object.keys(f).sort()).toEqual(['curated_at', 'curation_note', 'freshness_revival_pending', 'normalized_at']);
  });

  test('revival re-opens auto-curation: curated_at/curation_note clear on the SAME past→future gate', () => {
    for (const col of ['curated_at', 'curation_note']) {
      const { sql } = revivalResetFields()[col].toSQL();
      const lower = sql.toLowerCase();
      expect(lower).toMatch(/case when/);
      expect(lower).toContain('then null');
      // preserves the existing value outside a genuine revival
      expect(lower).toContain(`else events_raw.${col} end`);
    }
  });

  test('revival marker is gated on the SAME past→future ET-midnight condition, defaulting to the existing value', () => {
    const { parseETDateTime, etDateString } = require('../utils/datetime-et');
    const { sql, bindings } = revivalResetFields().freshness_revival_pending.toSQL();
    const lower = sql.toLowerCase();
    expect(lower).toMatch(/case when/);
    expect(lower).toMatch(/coalesce\(events_raw\.end_at, events_raw\.start_at\) </);
    expect(lower).toMatch(/coalesce\(excluded\.end_at, excluded\.start_at\) >=/);
    expect(lower).not.toContain('now()');
    // True only on a genuine past→future re-date; otherwise preserve the column
    // (never NULL — it's NOT NULL in the DB).
    expect(lower).toMatch(/then true else events_raw\.freshness_revival_pending end/);
    const expected = parseETDateTime(`${etDateString()}T00:00:00`).getTime();
    bindings.forEach((b) => expect(new Date(b).getTime()).toBe(expected));
  });
});

describe('event ingestion buildArticleBundle — news-RSS article bundling', () => {
  const { buildArticleBundle } = require('../services/event-ingestion');

  test('labels each article with title/URL/published/content and counts them', () => {
    const { text, bundled } = buildArticleBundle([
      { title: 'Weekend roundup', link: 'https://news.example/a', isoDate: '2026-06-10T12:00:00Z', contentSnippet: 'Concert Saturday at the park.' },
      { title: 'Things to do', link: 'https://news.example/b', pubDate: 'Wed, 10 Jun 2026 08:00:00 GMT', content: 'Art walk Friday night.' },
    ]);
    expect(bundled).toBe(2);
    expect(text).toContain('### Article 1');
    expect(text).toContain('### Article 2');
    expect(text).toContain('Title: Weekend roundup');
    expect(text).toContain('URL: https://news.example/a');
    expect(text).toContain('Published: 2026-06-10T12:00:00Z');
    expect(text).toContain('Content: Art walk Friday night.');
  });

  test('includes an Image line only for items with a safe enclosure URL', () => {
    const withImg = buildArticleBundle([
      { title: 'A', link: 'https://x.co/a', enclosure: { url: 'https://img.example/pic.jpg' }, contentSnippet: 'x' },
    ]);
    expect(withImg.text).toContain('Image: https://img.example/pic.jpg');
    const badImg = buildArticleBundle([
      { title: 'A', link: 'https://x.co/a', enclosure: { url: 'javascript:alert(1)' }, contentSnippet: 'x' },
    ]);
    expect(badImg.text).not.toContain('Image:');
  });

  test('prefers the full content:encoded body over the description teaser', () => {
    const { text } = buildArticleBundle([
      {
        title: 'Roundup',
        link: 'https://x.co/a',
        'content:encodedSnippet': 'Full body: jazz night Saturday 7pm at the Blue Rooster.',
        contentSnippet: 'Click to read our weekend picks…',
      },
    ]);
    expect(text).toContain('jazz night Saturday');
    expect(text).not.toContain('Click to read');
  });

  test('stops adding articles once the bundle budget is spent', () => {
    const big = 'y'.repeat(2500);
    const items = Array.from({ length: 30 }, (_, i) => ({
      title: `Post ${i}`, link: `https://x.co/${i}`, contentSnippet: big,
    }));
    const { text, bundled } = buildArticleBundle(items);
    expect(bundled).toBeLessThan(30);
    expect(text.length).toBeLessThanOrEqual(26000);
  });
});

describe('event ingestion recoverEventObjectsFromTruncatedJson — max_tokens-truncation salvage', () => {
  const { recoverEventObjectsFromTruncatedJson } = require('../services/event-ingestion');

  test('recovers complete event objects when the array is cut off mid-object', () => {
    // Mimics a max_tokens cutoff: outer object + array never close, the
    // last event is truncated mid-string. This is the exact shape that
    // threw "Expected ',' or ']' after array element" for The Gabber.
    const truncated = '{"events":['
      + '{"title":"Boat Parade","startAt":"2026-07-04T18:00:00-04:00","city":"sarasota"},'
      + '{"title":"Jazz Night","startAt":"2026-07-05T19:00:00-04:00","city":"venice"},'
      + '{"title":"Art Wal';
    const events = recoverEventObjectsFromTruncatedJson(truncated);
    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Boat Parade');
    expect(events[1].city).toBe('venice');
  });

  test('does not choke on braces or brackets inside string values', () => {
    const truncated = '{"events":['
      + '{"title":"Sale {50% off} [today]","description":"Brackets ] and { braces"},'
      + '{"title":"Next one half-';
    const events = recoverEventObjectsFromTruncatedJson(truncated);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Sale {50% off} [today]');
  });

  test('returns null when there is no salvageable events array', () => {
    expect(recoverEventObjectsFromTruncatedJson('not json at all')).toBeNull();
    expect(recoverEventObjectsFromTruncatedJson('{"events":[')).toBeNull();
  });
});

describe('event ingestion buildExtractionSystemPrompt — shared extraction prompt', () => {
  const { buildExtractionSystemPrompt } = require('../services/event-ingestion');
  const source = { name: 'Bay News 9 — On The Town', url: 'https://baynews9.com' };

  test('articles mode: publish date is not the event date, undated events skipped, article-URL fallback', () => {
    const p = buildExtractionSystemPrompt(source, 15, 'articles', '2026-06-11');
    expect(p).toContain('local-news RSS feed');
    expect(p).toContain("Published date is NOT the event date");
    expect(p).toContain('If no specific event date is stated, skip that event');
    expect(p).toContain("otherwise use the article's URL");
  });

  test('page mode: keeps the scrape intro and omits the article rules', () => {
    const p = buildExtractionSystemPrompt(source, 15, 'page', '2026-06-11');
    expect(p).toContain('raw HTML scraped');
    expect(p).not.toContain('Published date is NOT the event date');
  });

  test('both modes skip government/administrative items and carry the imageUrl field', () => {
    for (const mode of ['articles', 'page']) {
      const p = buildExtractionSystemPrompt(source, 10, mode, '2026-06-11');
      expect(p).toContain('government/administrative items');
      expect(p).toContain('"imageUrl"');
      expect(p).toContain('Cap output at 10 events');
    }
  });
});

describe('event ingestion normalizeExtractedEvent — validation + auto-approve gate', () => {
  const { normalizeExtractedEvent } = require('../services/event-ingestion');
  const NOW = Date.parse('2026-06-11T12:00:00Z');
  const tier1 = { id: 'src-1', priority_tier: 1, coverage_geo: ['tampa'] };
  const tier2 = { id: 'src-2', priority_tier: 2, coverage_geo: ['sarasota'] };

  test('drops events with no title, too far out, or already past', () => {
    expect(normalizeExtractedEvent(tier1, { title: '  ' }, NOW)).toBeNull();
    expect(normalizeExtractedEvent(tier1, { title: 'Way out', startAt: '2026-12-15T10:00:00-04:00' }, NOW)).toBeNull();
    expect(normalizeExtractedEvent(tier1, { title: 'Old news', startAt: '2026-06-01T10:00:00-04:00' }, NOW)).toBeNull();
  });

  test('requireStart (news mode) drops undated or unparseable-date events; page mode keeps them', () => {
    const undated = { title: 'Ongoing exhibit', startAt: null };
    const garbled = { title: 'Garbled', startAt: 'next Tuesday-ish' };
    expect(normalizeExtractedEvent(tier2, undated, NOW, { requireStart: true })).toBeNull();
    expect(normalizeExtractedEvent(tier2, garbled, NOW, { requireStart: true })).toBeNull();
    // page mode (no opts): undated events are legitimate (ongoing exhibits)
    expect(normalizeExtractedEvent(tier2, undated, NOW)).not.toBeNull();
  });

  test('tier-1 auto-approves ONLY when a real start date was extracted', () => {
    const dated = normalizeExtractedEvent(tier1, { title: 'Festival', startAt: '2026-06-14T10:00:00-04:00' }, NOW);
    expect(dated.autoApprove).toBe(true);
    const undated = normalizeExtractedEvent(tier1, { title: 'Festival', startAt: null }, NOW);
    expect(undated).not.toBeNull();
    expect(undated.autoApprove).toBe(false);
    const tier2Dated = normalizeExtractedEvent(tier2, { title: 'Festival', startAt: '2026-06-14T10:00:00-04:00' }, NOW);
    expect(tier2Dated.autoApprove).toBe(false);
  });

  test('canonicalizes the dedup key and validates URLs', () => {
    const { row } = normalizeExtractedEvent(tier1, {
      title: 'BOAT Parade',
      startAt: '2026-06-14T10:00:00-04:00',
      eventUrl: 'https://x.co/parade',
      imageUrl: 'javascript:alert(1)',
    }, NOW);
    expect(row.external_id).toBe(`boat parade|${new Date('2026-06-14T10:00:00-04:00').toISOString()}|https://x.co/parade`);
    expect(row.image_url).toBeNull();
    expect(row.event_url).toBe('https://x.co/parade');
  });

  test('falls back to source coverage_geo for city and clamps to 128 chars', () => {
    const noCity = normalizeExtractedEvent(tier2, { title: 'A', startAt: '2026-06-14T10:00:00-04:00' }, NOW);
    expect(noCity.row.city).toBe('sarasota');
    const longCity = normalizeExtractedEvent(tier2, { title: 'A', startAt: '2026-06-14T10:00:00-04:00', city: 'x'.repeat(300) }, NOW);
    expect(longCity.row.city).toHaveLength(128);
  });
});

describe('newsletter EMAIL_RE', () => {
  const ok = ['a@b.co', 'first.last@example.com', 'with+tag@gmail.com', 'h@host.io'];
  const bad = [
    '',
    'no-at-sign',
    '@nolocal.com',
    'noTld@host',
    'with space@host.com',
    'two@@host.com',
    'trailing.dot@host.',
  ];

  test.each(ok)('accepts %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(true);
  });

  test.each(bad)('rejects %s', (e) => {
    expect(EMAIL_RE.test(e)).toBe(false);
  });
});

describe('newsletter escapeHtml', () => {
  test('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<img onerror="x">')).toBe('&lt;img onerror=&quot;x&quot;&gt;');
    expect(escapeHtml("it's & <them>")).toBe('it&#39;s &amp; &lt;them&gt;');
  });

  test('returns empty string for null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('passes through plain ascii unchanged', () => {
    expect(escapeHtml('foo@bar.co')).toBe('foo@bar.co');
  });

  test('coerces non-strings before escaping', () => {
    expect(escapeHtml(123)).toBe('123');
  });
});

describe('newsletter computeNewsletterEventUpdates', () => {
  // Fixed clock so timestamp expectations don't drift between assertion
  // and now() inside the function under test.
  const now = new Date('2026-04-29T12:00:00Z');

  // Minimal delivery row shape — only the fields the planner reads.
  const fresh = (overrides = {}) => ({
    id: 'd-1',
    send_id: 's-1',
    subscriber_id: 99,
    delivered_at: null,
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
    complained_at: null,
    unsubscribed_at: null,
    ...overrides,
  });

  describe('delivered', () => {
    test('first event stamps delivered_at + delivered_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'delivered' }, fresh(), now);
      expect(u).toEqual({
        delivery: { status: 'delivered', delivered_at: now, updated_at: now },
        sendIncrement: 'delivered_count',
        reconcileSendStatus: true,
      });
    });
    test('idempotent — already-delivered row is a no-op', () => {
      const u = computeNewsletterEventUpdates({ event: 'delivered' }, fresh({ delivered_at: now }), now);
      expect(u).toBeNull();
    });
  });

  describe('bounce / blocked / dropped', () => {
    test.each(['bounce', 'blocked', 'dropped'])('%s stamps bounce + increments + bounce_count', (eventName) => {
      const u = computeNewsletterEventUpdates(
        { event: eventName, reason: 'mailbox does not exist' },
        fresh(),
        now,
      );
      expect(u.delivery.status).toBe('bounced');
      expect(u.delivery.bounced_at).toBe(now);
      expect(u.delivery.bounce_reason).toBe('mailbox does not exist');
      expect(u.sendIncrement).toBe('bounced_count');
      expect(u.reconcileSendStatus).toBe(true);
      expect(u.subscriberAction).toBe('bounce_increment');
      expect(u.subscriberAt).toBe(now);
    });
    test('truncates very long bounce_reason to 500 chars', () => {
      const long = 'x'.repeat(800);
      const u = computeNewsletterEventUpdates({ event: 'bounce', reason: long }, fresh(), now);
      expect(u.delivery.bounce_reason).toHaveLength(500);
    });
    test('falls back through reason → response → type', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce', response: '550 ...' }, fresh(), now);
      expect(u.delivery.bounce_reason).toBe('550 ...');
      const u2 = computeNewsletterEventUpdates({ event: 'bounce', type: 'hard' }, fresh(), now);
      expect(u2.delivery.bounce_reason).toBe('hard');
    });
    test('skips subscriber action when no subscriber_id (legacy import row)', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce' }, fresh({ subscriber_id: null }), now);
      expect(u.subscriberAction).toBeNull();
    });
    test('idempotent — already-bounced row is a no-op', () => {
      const u = computeNewsletterEventUpdates({ event: 'bounce' }, fresh({ bounced_at: now }), now);
      expect(u).toBeNull();
    });
    test('dropped group unsubscribe marks the subscriber unsubscribed, not bounced', () => {
      const u = computeNewsletterEventUpdates(
        { event: 'dropped', reason: 'Group Unsubscribe' },
        fresh(),
        now,
      );
      expect(u).toEqual({
        delivery: { status: 'unsubscribed', unsubscribed_at: now, updated_at: now },
        sendIncrement: 'unsubscribed_count',
        reconcileSendStatus: true,
        subscriberAction: 'unsubscribe_if_active',
        subscriberAt: now,
      });
    });
    test('dropped provider global unsubscribe marks the subscriber unsubscribed, not bounced', () => {
      const u = computeNewsletterEventUpdates(
        { event: 'dropped', reason: 'Unsubscribed Address' },
        fresh(),
        now,
      );
      expect(u).toEqual({
        delivery: { status: 'unsubscribed', unsubscribed_at: now, updated_at: now },
        sendIncrement: 'unsubscribed_count',
        reconcileSendStatus: true,
        subscriberAction: 'unsubscribe_if_active',
        subscriberAt: now,
      });
    });
    test('dropped provider spam report marks the subscriber complained', () => {
      const u = computeNewsletterEventUpdates(
        { event: 'dropped', reason: 'Spam Reporting Address' },
        fresh(),
        now,
      );
      expect(u).toEqual({
        delivery: { status: 'complained', complained_at: now, updated_at: now },
        sendIncrement: 'complained_count',
        reconcileSendStatus: true,
        subscriberAction: 'force_unsubscribe',
        subscriberAt: now,
      });
    });
  });

  describe('open / click', () => {
    test('open stamps timestamp + opened_count, leaves status alone', () => {
      const u = computeNewsletterEventUpdates({ event: 'open' }, fresh(), now);
      expect(u.delivery).toEqual({ opened_at: now, updated_at: now });
      expect(u.delivery.status).toBeUndefined();
      expect(u.sendIncrement).toBe('opened_count');
      expect(u.reconcileSendStatus).toBe(true);
    });
    test('click stamps timestamp + clicked_count', () => {
      const u = computeNewsletterEventUpdates({ event: 'click' }, fresh(), now);
      expect(u.delivery).toEqual({ clicked_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('clicked_count');
      expect(u.reconcileSendStatus).toBe(true);
    });
    test('open is idempotent', () => {
      expect(computeNewsletterEventUpdates({ event: 'open' }, fresh({ opened_at: now }), now)).toBeNull();
    });
    test('click is idempotent', () => {
      expect(computeNewsletterEventUpdates({ event: 'click' }, fresh({ clicked_at: now }), now)).toBeNull();
    });
  });

  describe('spamreport', () => {
    test('flips delivery to complained AND force-unsubscribes the subscriber', () => {
      const u = computeNewsletterEventUpdates({ event: 'spamreport' }, fresh(), now);
      expect(u.delivery).toEqual({ status: 'complained', complained_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('complained_count');
      expect(u.reconcileSendStatus).toBe(true);
      expect(u.subscriberAction).toBe('force_unsubscribe');
    });
    test('idempotent — already-complained row is a no-op', () => {
      expect(computeNewsletterEventUpdates({ event: 'spamreport' }, fresh({ complained_at: now }), now)).toBeNull();
    });
  });

  describe('unsubscribe / group_unsubscribe', () => {
    test.each(['unsubscribe', 'group_unsubscribe'])('%s stamps unsubscribe + increments + conditional unsub', (e) => {
      const u = computeNewsletterEventUpdates({ event: e }, fresh(), now);
      expect(u.delivery).toEqual({ unsubscribed_at: now, updated_at: now });
      expect(u.sendIncrement).toBe('unsubscribed_count');
      expect(u.subscriberAction).toBe('unsubscribe_if_active');
    });
    test('idempotent — already-unsubscribed delivery row is a no-op', () => {
      expect(computeNewsletterEventUpdates({ event: 'unsubscribe' }, fresh({ unsubscribed_at: now }), now)).toBeNull();
    });
  });

  describe('webhook timestamp freshness', () => {
    test('accepts timestamps inside the replay window', () => {
      expect(isFreshTimestamp('1772380800', Date.parse('2026-03-01T16:02:00Z'))).toBe(true);
    });

    test('rejects stale timestamps outside the replay window', () => {
      expect(isFreshTimestamp('1772380800', Date.parse('2026-03-01T16:10:01Z'))).toBe(false);
    });
  });

  describe('ignored events', () => {
    test.each(['processed', 'deferred', 'group_resubscribe', 'unknown_future_event'])('%s is a no-op', (e) => {
      expect(computeNewsletterEventUpdates({ event: e }, fresh(), now)).toBeNull();
    });

    test.each(['queued', 'failed'])('processed marks %s delivery rows as sent', (status) => {
      expect(computeNewsletterEventUpdates({ event: 'processed' }, fresh({ status }), now)).toEqual({
        delivery: { status: 'sent', sent_at: now, updated_at: now },
        reconcileSendStatus: true,
      });
    });

    test('processed marks token-matched in-flight resume rows as sent', () => {
      expect(computeNewsletterEventUpdates(
        { event: 'processed', send_attempt_token: 'attempt-1' },
        fresh({ status: 'sending', send_attempt_token: 'attempt-1' }),
        now,
      )).toEqual({
        delivery: { status: 'sent', sent_at: now, updated_at: now },
        reconcileSendStatus: true,
      });
    });

    test('processed ignores in-flight resume rows when attempt token is stale', () => {
      expect(computeNewsletterEventUpdates(
        { event: 'processed', send_attempt_token: 'old-attempt' },
        fresh({ status: 'sending', send_attempt_token: 'new-attempt' }),
        now,
      )).toBeNull();
    });

    test('processed stays a no-op after the row is already sent', () => {
      expect(computeNewsletterEventUpdates({ event: 'processed' }, fresh({ status: 'sent' }), now)).toBeNull();
    });
  });
});

describe('email template suppression event mapping', () => {
  test('spam complaints and global unsubscribes create global suppressions', () => {
    expect(suppressionForEmailEvent({ event: 'spamreport' }, 'service_operational')).toEqual({
      suppression_type: 'spam_complaint',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'unsubscribe' }, 'marketing_newsletter')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: null,
    });
  });

  test('group unsubscribe is scoped to the template suppression group', () => {
    expect(suppressionForEmailEvent({ event: 'group_unsubscribe' }, 'service_operational')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: 'service_operational',
    });
  });

  test('hard bounce suppresses but blocked and transient dropped do not', () => {
    expect(suppressionForEmailEvent({ event: 'bounce', type: 'bounce' })).toEqual({
      suppression_type: 'bounce',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'blocked' })).toBeNull();
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Spam Content' })).toBeNull();
  });

  test('provider dropped events from SendGrid suppressions mirror into local suppressions', () => {
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Group Unsubscribe' })).toBeNull();
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Group Unsubscribe' }, 'service_operational')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: 'service_operational',
    });
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Bounced Address' }, 'transactional_required')).toEqual({
      suppression_type: 'bounce',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Invalid' }, 'service_operational')).toEqual({
      suppression_type: 'bounce',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Unsubscribed Address' }, 'service_operational')).toEqual({
      suppression_type: 'unsubscribe',
      group_key: null,
    });
    expect(suppressionForEmailEvent({ event: 'dropped', reason: 'Spam Reporting Address' }, 'marketing_newsletter')).toEqual({
      suppression_type: 'spam_complaint',
      group_key: null,
    });
  });

  test('newsletter group unsubscribe events use the newsletter suppression group', () => {
    expect(newsletterSuppressionGroupKeyForEvent({ event: 'group_unsubscribe' })).toBe('marketing_newsletter');
    expect(newsletterSuppressionGroupKeyForEvent({ event: 'dropped', reason: 'Group Unsubscribe' })).toBe('marketing_newsletter');

    const originalNewsletter = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
    try {
      process.env.SENDGRID_ASM_GROUP_NEWSLETTER = '101';
      expect(newsletterSuppressionGroupKeyForEvent({
        event: 'dropped',
        reason: 'Group Unsubscribe',
        asm_group_id: '101',
      })).toBe('marketing_newsletter');
    } finally {
      if (originalNewsletter === undefined) delete process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
      else process.env.SENDGRID_ASM_GROUP_NEWSLETTER = originalNewsletter;
    }
  });

  test('automation group unsubscribes map SendGrid ASM ids to local preference groups', () => {
    const originalNewsletter = process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
    const originalService = process.env.SENDGRID_ASM_GROUP_SERVICE;
    try {
      process.env.SENDGRID_ASM_GROUP_NEWSLETTER = '101';
      process.env.SENDGRID_ASM_GROUP_SERVICE = '202';

      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: 101,
      })).toBe('marketing_newsletter');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: '202',
      })).toBe('service_operational');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'dropped',
        reason: 'Group Unsubscribe',
        asm_group_id: '202',
      })).toBe('service_operational');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'dropped',
        reason: 'Group Unsubscribe',
        asm_group_id: '101',
      })).toBe('marketing_newsletter');
      expect(automationSuppressionGroupKeyForEvent({
        event: 'dropped',
        reason: 'Group Unsubscribe',
        asm_group_id: '999',
      })).toBeNull();
      expect(automationSuppressionGroupKeyForEvent({
        event: 'group_unsubscribe',
        asm_group_id: '999',
      })).toBeNull();
      expect(automationSuppressionGroupKeyForEvent({
        event: 'unsubscribe',
        asm_group_id: '101',
      })).toBeNull();
    } finally {
      if (originalNewsletter === undefined) delete process.env.SENDGRID_ASM_GROUP_NEWSLETTER;
      else process.env.SENDGRID_ASM_GROUP_NEWSLETTER = originalNewsletter;
      if (originalService === undefined) delete process.env.SENDGRID_ASM_GROUP_SERVICE;
      else process.env.SENDGRID_ASM_GROUP_SERVICE = originalService;
    }
  });
});

describe('sendgrid webhook PII-safe diagnostics', () => {
  test('redacts recipient emails in delivery_id mismatch warnings', () => {
    const msg = deliveryEmailMismatchLogMessage(
      'delivery-1',
      'customer.person@example.com',
      'tampered.person@example.net',
    );
    expect(msg).toContain('cu***@example.com');
    expect(msg).toContain('ta***@example.net');
    expect(msg).not.toContain('customer.person@example.com');
    expect(msg).not.toContain('tampered.person@example.net');
  });
});

describe('sendgrid webhook delivery_id fallback guard', () => {
  test('accepts unbound rows and rejects rows bound to a different provider message id', () => {
    expect(canUseDeliveryIdFallback({ provider_message_id: null }, 'new-msg')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending' }, 'new-msg')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-1')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: null, status: 'sending', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-2')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'new-msg' }, 'new-msg')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg' }, 'new-msg')).toBe(false);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-1')).toBe(true);
    expect(canUseDeliveryIdFallback({ provider_message_id: 'old-msg', send_attempt_token: 'tok-1' }, 'new-msg', 'tok-2')).toBe(false);
  });

  test('provider message fast path honors active attempt tokens', () => {
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old' }, null)).toBe(true);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-new', send_attempt_token: 'tok-1' }, 'tok-1')).toBe(true);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old', send_attempt_token: 'tok-1' }, 'tok-2')).toBe(false);
    expect(canUseProviderMessageMatch({ provider_message_id: 'sg-old', send_attempt_token: 'tok-1' }, null)).toBe(false);
  });

  test('binds provider message id behind an unbound-or-same guard', async () => {
    const nested = {};
    nested.whereNull = jest.fn(() => nested);
    nested.orWhere = jest.fn(() => nested);
    const query = {};
    query.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(nested);
      return query;
    });
    query.update = jest.fn(async () => 1);
    const client = jest.fn(() => query);

    const result = await bindNewsletterDeliveryMessageId(
      { id: 'delivery-1', provider_message_id: null },
      'sg-msg-1',
      null,
      client,
    );

    expect(result.provider_message_id).toBe('sg-msg-1');
    expect(query.where).toHaveBeenCalledWith({ id: 'delivery-1' });
    expect(nested.whereNull).toHaveBeenCalledWith('provider_message_id');
    expect(nested.orWhere).toHaveBeenCalledWith({ provider_message_id: 'sg-msg-1' });
  });

  test('rebinds a stale provider message id when the attempt token matches', async () => {
    const nested = {};
    nested.whereNull = jest.fn(() => nested);
    nested.orWhere = jest.fn(() => nested);
    const query = {};
    query.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(nested);
      return query;
    });
    query.update = jest.fn(async () => 1);
    const client = jest.fn(() => query);

    const result = await bindNewsletterDeliveryMessageId(
      { id: 'delivery-1', provider_message_id: 'sg-old', send_attempt_token: 'tok-1' },
      'sg-new',
      'tok-1',
      client,
    );

    expect(result.provider_message_id).toBe('sg-new');
    expect(nested.orWhere).toHaveBeenCalledWith({ send_attempt_token: 'tok-1' });
    expect(query.where).toHaveBeenCalledWith({ send_attempt_token: 'tok-1' });
  });

  test('re-reads the delivery row when a concurrent message bind wins', async () => {
    const nested = {};
    nested.whereNull = jest.fn(() => nested);
    nested.orWhere = jest.fn(() => nested);
    const updateQuery = {};
    updateQuery.where = jest.fn((arg) => {
      if (typeof arg === 'function') arg(nested);
      return updateQuery;
    });
    updateQuery.update = jest.fn(async () => 0);
    const rereadQuery = {};
    rereadQuery.where = jest.fn(() => rereadQuery);
    rereadQuery.first = jest.fn(async () => ({ id: 'delivery-1', provider_message_id: 'sg-other' }));
    const client = jest.fn()
      .mockReturnValueOnce(updateQuery)
      .mockReturnValueOnce(rereadQuery);

    const result = await bindNewsletterDeliveryMessageId(
      { id: 'delivery-1', provider_message_id: null },
      'sg-msg-1',
      null,
      client,
    );

    expect(result.provider_message_id).toBe('sg-other');
    expect(rereadQuery.where).toHaveBeenCalledWith({ id: 'delivery-1' });
  });

  test('reconcile treats abandoned sending rows as retryable', async () => {
    const deliveryQuery = {};
    deliveryQuery.where = jest.fn(() => deliveryQuery);
    deliveryQuery.whereIn = jest.fn(() => deliveryQuery);
    deliveryQuery.whereNull = jest.fn(() => deliveryQuery);
    deliveryQuery.count = jest.fn(() => deliveryQuery);
    deliveryQuery.first = jest.fn(async () => ({ c: 1 }));
    const client = jest.fn((table) => {
      if (table === 'newsletter_send_deliveries') return deliveryQuery;
      throw new Error(`unexpected table ${table}`);
    });

    await reconcileNewsletterSendStatus('send-1', client);

    expect(deliveryQuery.where).toHaveBeenCalledWith({ send_id: 'send-1' });
    expect(deliveryQuery.whereIn).toHaveBeenCalledWith('status', ['queued', 'failed', 'sending']);
  });
});

describe('sendgrid newsletter suppression ledger writes', () => {
  function queryDouble(firstResult = undefined) {
    const q = {};
    [
      'where',
      'whereRaw',
      'whereNull',
      'whereIn',
      'whereNot',
    ].forEach((method) => {
      q[method] = jest.fn(() => q);
    });
    q.count = jest.fn(() => q);
    q.first = jest.fn(async () => (firstResult === undefined ? null : firstResult));
    q.update = jest.fn(async () => 1);
    q.increment = jest.fn(async () => 1);
    q.insert = jest.fn(async () => 1);
    return q;
  }

  function fakeClient() {
    const calls = {};
    const client = jest.fn((table) => {
      const q = queryDouble(table === 'newsletter_send_deliveries' ? { c: 0 } : undefined);
      calls[table] = calls[table] || [];
      calls[table].push(q);
      return q;
    });
    client.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    return { client, calls };
  }

  test('newsletter dropped Bounced Address writes a global bounce suppression', async () => {
    const { client, calls } = fakeClient();

    await handleNewsletterEvent({
      event: 'dropped',
      reason: 'Bounced Address',
      email: 'Bad.Customer@Example.com',
    }, {
      id: 'delivery-1',
      send_id: 'send-1',
      subscriber_id: 12,
      email: 'bad.customer@example.com',
    }, client);

    const suppressionInsert = calls.email_suppressions
      .find((query) => query.insert.mock.calls.length)
      .insert.mock.calls[0][0];
    expect(suppressionInsert).toEqual(expect.objectContaining({
      email: 'bad.customer@example.com',
      group_key: null,
      suppression_type: 'bounce',
      status: 'active',
      source: 'sendgrid_event_webhook',
    }));
  });

  test('newsletter dropped Group Unsubscribe writes a newsletter-scoped unsubscribe suppression', async () => {
    const { client, calls } = fakeClient();

    await handleNewsletterEvent({
      event: 'dropped',
      reason: 'Group Unsubscribe',
      email: 'sub@example.com',
    }, {
      id: 'delivery-2',
      send_id: 'send-2',
      subscriber_id: 13,
      email: 'sub@example.com',
    }, client);

    const suppressionInsert = calls.email_suppressions
      .find((query) => query.insert.mock.calls.length)
      .insert.mock.calls[0][0];
    const subscriberUpdate = calls.newsletter_subscribers[0].update.mock.calls[0][0];
    expect(suppressionInsert).toEqual(expect.objectContaining({
      email: 'sub@example.com',
      group_key: 'marketing_newsletter',
      suppression_type: 'unsubscribe',
      status: 'active',
      source: 'sendgrid_event_webhook',
    }));
    expect(subscriberUpdate).toEqual(expect.objectContaining({
      status: 'unsubscribed',
      unsubscribed_at: expect.any(Date),
    }));
  });

  test('newsletter dropped Unsubscribed Address writes a global unsubscribe suppression', async () => {
    const { client, calls } = fakeClient();

    await handleNewsletterEvent({
      event: 'dropped',
      reason: 'Unsubscribed Address',
      email: 'global.unsub@example.com',
    }, {
      id: 'delivery-3',
      send_id: 'send-3',
      subscriber_id: 14,
      email: 'global.unsub@example.com',
    }, client);

    const suppressionInsert = calls.email_suppressions
      .find((query) => query.insert.mock.calls.length)
      .insert.mock.calls[0][0];
    const subscriberUpdate = calls.newsletter_subscribers[0].update.mock.calls[0][0];
    expect(suppressionInsert).toEqual(expect.objectContaining({
      email: 'global.unsub@example.com',
      group_key: null,
      suppression_type: 'unsubscribe',
      status: 'active',
      source: 'sendgrid_event_webhook',
    }));
    expect(subscriberUpdate).toEqual(expect.objectContaining({
      status: 'unsubscribed',
      unsubscribed_at: expect.any(Date),
    }));
  });

  test('newsletter dropped Spam Reporting Address writes a global spam suppression', async () => {
    const { client, calls } = fakeClient();

    await handleNewsletterEvent({
      event: 'dropped',
      reason: 'Spam Reporting Address',
      email: 'complaint@example.com',
    }, {
      id: 'delivery-4',
      send_id: 'send-4',
      subscriber_id: 15,
      email: 'complaint@example.com',
    }, client);

    const suppressionInsert = calls.email_suppressions
      .find((query) => query.insert.mock.calls.length)
      .insert.mock.calls[0][0];
    const subscriberUpdate = calls.newsletter_subscribers[0].update.mock.calls[0][0];
    expect(suppressionInsert).toEqual(expect.objectContaining({
      email: 'complaint@example.com',
      group_key: null,
      suppression_type: 'spam_complaint',
      status: 'active',
      source: 'sendgrid_event_webhook',
    }));
    expect(subscriberUpdate).toEqual(expect.objectContaining({
      status: 'unsubscribed',
      unsubscribed_at: expect.any(Date),
    }));
  });
});

describe('email template send history webhook updates', () => {
  const now = new Date('2026-04-29T12:00:00Z');
  const fresh = (overrides = {}) => ({
    delivered_at: null,
    bounced_at: null,
    opened_at: null,
    clicked_at: null,
    complained_at: null,
    ...overrides,
  });

  test('delivered stamps status and delivered_at', () => {
    expect(computeEmailMessageEventUpdates({ event: 'delivered' }, fresh(), now)).toEqual({
      status: 'delivered',
      delivered_at: now,
      updated_at: now,
    });
  });

  test('open and click only stamp engagement timestamps', () => {
    expect(computeEmailMessageEventUpdates({ event: 'open' }, fresh(), now)).toEqual({
      opened_at: now,
      updated_at: now,
    });
    expect(computeEmailMessageEventUpdates({ event: 'click' }, fresh(), now)).toEqual({
      clicked_at: now,
      updated_at: now,
    });
  });

  test('bounce, blocked, and dropped preserve the provider reason', () => {
    const bounced = computeEmailMessageEventUpdates({ event: 'bounce', reason: 'mailbox missing' }, fresh(), now);
    expect(bounced.status).toBe('bounced');
    expect(bounced.bounced_at).toBe(now);
    expect(bounced.error_message).toBe('mailbox missing');

    expect(computeEmailMessageEventUpdates({ event: 'blocked', response: 'rate limited' }, fresh(), now).status).toBe('blocked');
    expect(computeEmailMessageEventUpdates({ event: 'dropped', type: 'suppressed' }, fresh(), now).status).toBe('dropped');
  });

  test('complaints and unsubscribes update customer-facing send history status', () => {
    expect(computeEmailMessageEventUpdates({ event: 'spamreport' }, fresh(), now)).toEqual({
      status: 'spam_report',
      complained_at: now,
      updated_at: now,
    });
    expect(computeEmailMessageEventUpdates({ event: 'unsubscribe' }, fresh(), now)).toEqual({
      status: 'unsubscribed',
      updated_at: now,
    });
  });

  test('idempotent engagement and delivery events are no-ops', () => {
    expect(computeEmailMessageEventUpdates({ event: 'delivered' }, fresh({ delivered_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'open' }, fresh({ opened_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'click' }, fresh({ clicked_at: now }), now)).toBeNull();
    expect(computeEmailMessageEventUpdates({ event: 'spamreport' }, fresh({ complained_at: now }), now)).toBeNull();
  });
});

// ── Factual locking on AI-generated event objects ────────────────────
//
// The flagship draft pipeline asks Claude for commentary keyed by an
// eventId UUID, then re-locks date/venue/address/URL/image from the
// events_raw row at render time. These tests cover the locker's three
// drop paths (missing id, unknown id, duplicate id) and the DB-override
// shape so a regression here can't silently let AI-fabricated dates or
// admission strings reach a customer's inbox.

describe('newsletter Beehiiv-parity render devices', () => {
  const { clockEmojiFor, displayCity, formatLockedLocation, linkifyFirst } = require('../services/newsletter-draft');

  test('clockEmojiFor matches the ET start hour, with half-hour faces', () => {
    expect(clockEmojiFor(new Date('2026-06-12T20:00:00-04:00'))).toBe('🕗'); // 8:00 PM
    expect(clockEmojiFor(new Date('2026-06-12T19:30:00-04:00'))).toBe('🕢'); // 7:30 PM
    expect(clockEmojiFor(new Date('2026-06-13T11:00:00-04:00'))).toBe('🕚'); // 11:00 AM
    expect(clockEmojiFor(new Date('2026-06-13T09:50:00-04:00'))).toBe('🕙'); // 9:50 → rounds to 10
  });

  test('displayCity humanizes stored slugs', () => {
    expect(displayCity('anna-maria')).toBe('Anna Maria');
    expect(displayCity('north port')).toBe('North Port');
    expect(displayCity(null)).toBeNull();
  });

  test('formatLockedLocation never duplicates a city already embedded in the venue string', () => {
    expect(formatLockedLocation({
      venue_name: 'Izzy\'s Place, 12012 Cortez Rd W, Cortez, FL, 34215',
      city: 'cortez',
    })).toBe('Izzy\'s Place, 12012 Cortez Rd W, Cortez, FL, 34215');
    expect(formatLockedLocation({ venue_name: 'Riverwalk Pavilion', city: 'Bradenton' }))
      .toBe('Riverwalk Pavilion, Bradenton');
    expect(formatLockedLocation({ venue_name: null, city: 'anna-maria' })).toBe('Anna Maria');
  });

  test('address survives when the venue only shares a number ("Studio 131" vs "131 N Orange Ave")', () => {
    const { lockEventFactsFromDb } = require('../services/newsletter-draft');
    const { locked } = lockEventFactsFromDb(
      [{ eventId: '33333333-3333-3333-3333-333333333333', title: 'x' }],
      [{
        id: '33333333-3333-3333-3333-333333333333',
        title: 'Show',
        start_at: new Date('2026-06-13T00:00:00Z'),
        venue_name: 'Studio 131',
        venue_address: '131 N Orange Ave, Sarasota, FL',
        city: 'Sarasota',
        event_url: 'https://example.com',
        image_url: null,
      }],
    );
    expect(locked[0].address).toBe('131 N Orange Ave, Sarasota, FL');
    // …but a venue string that embeds the real street IS treated as covering it
    const { locked: covered } = lockEventFactsFromDb(
      [{ eventId: '33333333-3333-3333-3333-333333333333', title: 'x' }],
      [{
        id: '33333333-3333-3333-3333-333333333333',
        title: 'Show',
        start_at: new Date('2026-06-13T00:00:00Z'),
        venue_name: 'Izzy\'s Place, 12012 Cortez Rd W, Cortez, FL, 34215',
        venue_address: '12012 Cortez Rd W, Cortez, FL 34215',
        city: 'cortez',
        event_url: 'https://example.com',
        image_url: null,
      }],
    );
    expect(covered[0].address).toBeNull();
  });

  test('linkifyFirst links only the first case-insensitive occurrence; no match leaves html untouched', () => {
    const html = 'Go see <strong>the show</strong> — Bradenton Blues is back. bradenton blues forever.';
    const out = linkifyFirst(html, 'Bradenton Blues', 'https://example.com/blues');
    expect(out).toContain('<a href="https://example.com/blues"');
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out.indexOf('<a ')).toBeLessThan(out.indexOf('forever'));
    expect(linkifyFirst(html, 'Sarasota Symphony', 'https://x.co')).toBe(html);
  });
});

describe('newsletter assembly — Beehiiv-parity event rendering', () => {
  const { assembleBeehiivNewsletter } = require('../services/newsletter-draft');
  const baseEvent = {
    eventId: 'a0000000-0000-4000-8000-000000000002',
    emoji: '🎸',
    title: 'Freckled Fin Gets Loud',
    sourceTitle: 'Lisa & The All Terrain Band',
    description: 'Lisa & The All Terrain Band are rolling in with big energy.',
    dateStr: 'Friday, June 12',
    timeStr: '8:00 PM',
    clockEmoji: '🕗',
    location: 'Freckled Fin Irish Pub, Holmes Beach',
    address: null,
    eventUrl: 'https://example.com/fin',
    imageUrl: 'https://cdn.example.com/fin.jpg',
    isFree: true,
    scoopLabel: 'Here\'s the scoop:',
    highlights: ['🎶 Crowd-pleaser setlist', '🍀 Irish pub vibes'],
    proTip: 'Pro tip: Get there before 8 for a table.',
    linkText: 'Grab your spot',
    closingLine: 'Lace up — **this one\'s a sweat sesh.**',
  };

  test('renders the full Beehiiv event anatomy without doubled labels or generic anchors', async () => {
    const html = await assembleBeehiivNewsletter({ selectedSubject: 'Test', events: [{ ...baseEvent }] });
    // date | clock time line
    expect(html).toContain('📅 <strong>Friday, June 12</strong> | 🕗 <strong>8:00 PM</strong>');
    // DB-verified FREE badge
    expect(html).toContain('🎟️ <strong>FREE</strong>');
    // rotating anchor text, not "Tickets & Info"
    expect(html).toContain('>Grab your spot</a>');
    expect(html).not.toContain('Tickets &amp; Info');
    // event name inline-linked in the description
    expect(html).toContain('<a href="https://example.com/fin"');
    // rotating scoop label; plain "•" bullets with model emojis stripped
    // (baseEvent highlights deliberately carry leading emojis to prove the
    // strip — and old persisted drafts still have them)
    expect(html).toContain('Here&#39;s the scoop:');
    expect(html).toMatch(/<li[^>]*>• Crowd-pleaser setlist</);
    expect(html).toMatch(/<li[^>]*>• Irish pub vibes</);
    // pro tip label never doubles
    expect(html).toContain('<strong>Pro tip:</strong>');
    expect(html).not.toMatch(/Pro tip:\s*<\/strong>\s*<em>\s*Pro tip/i);
  });

  test('no Giphy key → event image fallback renders; isFree false → no FREE badge', async () => {
    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Test',
      events: [{ ...baseEvent, isFree: false, gifSearchTerm: 'rock band' }],
    });
    expect(html).toContain('https://cdn.example.com/fin.jpg');
    expect(html).not.toContain('🎟️ <strong>FREE</strong>');
  });

  test('closing checklist renders ✔️ items and the sign-off defaults to the Team form', async () => {
    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Test',
      events: [{ ...baseEvent }],
      closingHeading: 'That\'s the scoop, crew',
      closingText: 'Whatever you pick, we support it.',
      closingChecklist: ['Pack a chair', 'Hydrate like it\'s your job'],
    });
    expect(html).toContain('✔️ Pack a chair');
    expect(html).toContain('✔️ Hydrate like it&#39;s your job');
    expect(html).toContain('— The Waves Pest Control Team');
  });

  test('P.S. label never doubles when the model writes the prefix itself; label-only ps renders nothing', async () => {
    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Test',
      events: [{ ...baseEvent }],
      ps: 'P.S. If you loved this, forward it to a friend who owns a tutu. 🤡',
    });
    expect(html).toContain('<strong>P.S.</strong>');
    expect(html).not.toMatch(/P\.S\.<\/strong>\s*<em>\s*p\.?\s?s/i);
    expect(html.match(/P\.S\./g)).toHaveLength(1);

    const labelOnly = await assembleBeehiivNewsletter({
      selectedSubject: 'Test',
      events: [{ ...baseEvent }],
      ps: 'P.S.',
    });
    expect(labelOnly).not.toContain('<strong>P.S.</strong>');
  });
});

describe('newsletter P.S. body + plain-text entity decode helpers', () => {
  const { psBodyText, decodeEscapedEntities } = require('../services/newsletter-draft');

  test('psBodyText strips the leading P.S./PS marker in its common spellings', () => {
    expect(psBodyText('P.S. Forward this to a friend. 🎪')).toBe('Forward this to a friend. 🎪');
    expect(psBodyText('P.S. — blame the clown')).toBe('blame the clown');
    expect(psBodyText('ps: blame the clown')).toBe('blame the clown');
    expect(psBodyText('  p.s. blame the clown')).toBe('blame the clown');
  });

  test('psBodyText leaves prose that merely starts with PS-ish words intact', () => {
    expect(psBodyText('PSA: bring sunscreen')).toBe('PSA: bring sunscreen');
    expect(psBodyText('Psst — over here')).toBe('Psst — over here');
    expect(psBodyText('Forward this to a friend.')).toBe('Forward this to a friend.');
    expect(psBodyText(null)).toBe('');
  });

  test('decodeEscapedEntities is the exact inverse of escapeHtml', () => {
    expect(decodeEscapedEntities('it&#39;s &amp; &lt;them&gt; &quot;hi&quot;')).toBe('it\'s & <them> "hi"');
    expect(decodeEscapedEntities(null)).toBe('');
  });

  test('a double-escaped literal entity round-trips back to literal text, not a character', () => {
    expect(decodeEscapedEntities('wait &amp;#39; what')).toBe('wait &#39; what');
    expect(decodeEscapedEntities('dots &amp;hellip; here')).toBe('dots &hellip; here');
  });
});

describe('newsletter closing-checklist checkmark guard', () => {
  const { checklistItemText } = require('../services/newsletter-draft');

  test('strips a leading model-written checkmark so the renderer marker never doubles', () => {
    expect(checklistItemText('✔️ Sunscreen before the patio, not after')).toBe('Sunscreen before the patio, not after');
    expect(checklistItemText('✔ Hydrate like it\'s your job')).toBe('Hydrate like it\'s your job');
    expect(checklistItemText('✅ Dump standing water after every storm')).toBe('Dump standing water after every storm');
    expect(checklistItemText('  ✓ Foldable chair = permanent trunk resident')).toBe('Foldable chair = permanent trunk resident');
    expect(checklistItemText('✔️ ✔️ already doubled in an old draft')).toBe('already doubled in an old draft');
  });

  test('leaves non-checkmark openers intact — other emoji are content, not markers', () => {
    expect(checklistItemText('🧴 Sunscreen first')).toBe('🧴 Sunscreen first');
    expect(checklistItemText('Don\'t underestimate the funnel cake')).toBe('Don\'t underestimate the funnel cake');
    expect(checklistItemText('Check the radar ✔️ before heading out')).toBe('Check the radar ✔️ before heading out');
    expect(checklistItemText(null)).toBe('');
  });
});

describe('newsletter greeting personalization + render polish', () => {
  const {
    GREETING_NAME_TOKEN,
    greetingWithNameToken,
    greetingNameValueFor,
    stripGreetingNameToken,
    stripPersonalizationTokens,
    plainBulletText,
    assembleBeehiivNewsletter,
  } = require('../services/newsletter-draft');

  test('greetingWithNameToken slots the token inside the sentence, before trailing punctuation', () => {
    expect(greetingWithNameToken('Hey there!')).toBe(`Hey there${GREETING_NAME_TOKEN}!`);
    expect(greetingWithNameToken('What a week?!')).toBe(`What a week${GREETING_NAME_TOKEN}?!`);
    expect(greetingWithNameToken('Hello')).toBe(`Hello${GREETING_NAME_TOKEN}`);
  });

  test('greetingNameValueFor: ", Name" with no HTML metacharacters, apostrophes kept, empty fallback', () => {
    expect(greetingNameValueFor('Adam')).toBe(', Adam');
    expect(greetingNameValueFor("D'Angelo")).toBe(", D'Angelo");
    expect(greetingNameValueFor('  Mary   Jo  ')).toBe(', Mary Jo');
    expect(greetingNameValueFor(null)).toBe('');
    expect(greetingNameValueFor('   ')).toBe('');
    const hostile = greetingNameValueFor('<img src=x onerror=steal()>&"Adam"');
    expect(hostile).not.toMatch(/[<>&"=()]/);
    expect(greetingNameValueFor('x'.repeat(100)).length).toBeLessThanOrEqual(42);
  });

  test('stripGreetingNameToken removes every occurrence (public archive path)', () => {
    const html = `<p>Hey there${GREETING_NAME_TOKEN}!</p><p>bye${GREETING_NAME_TOKEN}</p>`;
    expect(stripGreetingNameToken(html)).toBe('<p>Hey there!</p><p>bye</p>');
  });

  test('stripPersonalizationTokens neutralizes city/grass to defaults — no literal merge tags leak to public surfaces', () => {
    const html = `<p>Hi${GREETING_NAME_TOKEN}, your {{grass-type}} lawn in {{city}} looks great.</p>`;
    const out = stripPersonalizationTokens(html);
    expect(out).toBe('<p>Hi, your St. Augustine lawn in your area looks great.</p>');
    // Every per-recipient token is gone — nothing renders literally in archive/RSS/preview.
    expect(out).not.toMatch(/\{\{(greeting-name|city|grass-type)\}\}/);
  });

  test('plainBulletText strips leading emojis (incl. VS16/ZWJ sequences) and literal markers', () => {
    expect(plainBulletText('🤝 Real-human networking (remember those?)')).toBe('Real-human networking (remember those?)');
    expect(plainBulletText('🗣️ Chamber regulars + curious newcomers')).toBe('Chamber regulars + curious newcomers');
    expect(plainBulletText('• already bulleted')).toBe('already bulleted');
    expect(plainBulletText('– dashed lead')).toBe('dashed lead');
    expect(plainBulletText('Sit-down meal at a Cortez staple')).toBe('Sit-down meal at a Cortez staple');
  });

  test('assembly: 22px greeting carries the name token; divider renders at 64px', async () => {
    const html = await assembleBeehiivNewsletter({
      selectedSubject: 'Test',
      greeting: 'Hey there!',
      events: [{
        eventId: 'a0000000-0000-4000-8000-000000000009',
        emoji: '🎸', title: 'A Show', description: 'Come see it.',
        dateStr: 'Friday, June 12', timeStr: '8:00 PM', clockEmoji: '🕗',
      }],
    });
    expect(html).toContain(`Hey there${GREETING_NAME_TOKEN}!`);
    expect(html).toMatch(/font-size:22px[^>]*>👋/);
    expect(html).toContain('width="64"');
    expect(html).not.toContain('width="100"');
  });

  test('wrapNewsletter local-guide header uses the 2026 logo at 88px', () => {
    const { wrapNewsletter } = require('../services/email-template');
    const html = wrapNewsletter({ body: '<p>x</p>', newsletterType: 'local-weekly-fresh-events' });
    expect(html).toContain('waves-logo-2026.png');
    expect(html).not.toContain('/waves-logo.png');
    expect(html).toContain('width="88"');
  });
});

describe('newsletter lockEventFactsFromDb', () => {
  const id1 = '11111111-1111-1111-1111-111111111111';
  const id2 = '22222222-2222-2222-2222-222222222222';

  const dbRow = (overrides = {}) => ({
    id: id1,
    title: 'Bradenton Blues',
    start_at: new Date('2026-05-30T23:00:00Z'), // Sat May 30 7pm ET
    venue_name: 'Riverwalk Pavilion',
    venue_address: '452 3rd Ave W, Bradenton, FL',
    city: 'Bradenton',
    event_url: 'https://example.com/blues',
    image_url: 'https://cdn.example.com/blues.jpg',
    ...overrides,
  });

  test('overrides AI date/venue/url with DB-sourced strings', () => {
    const aiEvents = [{
      eventId: id1,
      title: 'AI rewrote this',
      date: 'AI HALLUCINATED DATE',
      location: 'AI HALLUCINATED VENUE',
      address: 'AI HALLUCINATED ADDRESS',
      admission: 'Free admission!', // hallucination — DB has no admission
      eventUrl: 'https://malicious.example.com',
      imageUrl: 'https://malicious.example.com/img.jpg',
      description: 'AI-written vibe copy',
    }];
    const { locked, dropped } = lockEventFactsFromDb(aiEvents, [dbRow()]);
    expect(dropped).toEqual([]);
    expect(locked).toHaveLength(1);
    expect(locked[0].address).toBe('452 3rd Ave W, Bradenton, FL');
    expect(locked[0].eventUrl).toBe('https://example.com/blues');
    expect(locked[0].imageUrl).toBe('https://cdn.example.com/blues.jpg');
    expect(locked[0].location).toBe('Riverwalk Pavilion, Bradenton');
    expect(locked[0].admission).toBeNull(); // admission is never trusted from AI
    expect(locked[0].date).toMatch(/Saturday, May 30/);
    expect(locked[0].description).toBe('AI-written vibe copy'); // commentary preserved
  });

  test('drops events with no eventId', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ title: 'Anonymous Event' }],
      [dbRow()],
    );
    expect(locked).toHaveLength(0);
    expect(dropped).toEqual([{ index: 0, reason: 'missing eventId', title: 'Anonymous Event' }]);
  });

  test('drops events whose eventId is not in the approved pool', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ eventId: '99999999-9999-9999-9999-999999999999', title: 'Hallucinated Event' }],
      [dbRow()],
    );
    expect(locked).toHaveLength(0);
    expect(dropped[0].reason).toBe('eventId not in approved list');
  });

  test('drops duplicate eventIds — keeps first, drops the rest', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [
        { eventId: id1, title: 'First mention' },
        { eventId: id1, title: 'Second mention' },
      ],
      [dbRow()],
    );
    expect(locked).toHaveLength(1);
    expect(locked[0].title).toBe('First mention');
    expect(dropped[0].reason).toBe('duplicate eventId in draft');
  });

  test('matches eventIds case-insensitively', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [{ eventId: id1.toUpperCase(), title: 'Uppercase id from model' }],
      [dbRow()],
    );
    expect(dropped).toEqual([]);
    expect(locked).toHaveLength(1);
    expect(locked[0].eventId).toBe(id1);
  });

  test('handles a mix of valid and invalid events', () => {
    const { locked, dropped } = lockEventFactsFromDb(
      [
        { eventId: id1, title: 'Valid' },
        { eventId: 'bogus', title: 'Bad' },
        { eventId: id2, title: 'Also valid' },
      ],
      [dbRow({ id: id1 }), dbRow({ id: id2, title: 'Sunday Market', city: 'Sarasota', venue_name: 'Bayfront Park' })],
    );
    expect(locked.map((e) => e.title)).toEqual(['Valid', 'Also valid']);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('eventId not in approved list');
  });

  test('strips URLs the model slips into commentary prose (Codex P2)', () => {
    const { locked } = lockEventFactsFromDb(
      [{
        eventId: id1,
        title: 'Bradenton Blues',
        description: 'Grab tickets at https://scammy.example.com before they sell out.',
        proTip: 'More info at www.evil.example.com',
        highlights: ['Buy passes here: http://phish.example.com', 'Live music all night'],
        closingLine: 'See the lineup at [the site](https://bad.example.com).',
      }],
      [dbRow()],
    );
    const ev = locked[0];
    // No raw URLs survive in any commentary field
    const blob = [ev.description, ev.proTip, ev.closingLine, ...ev.highlights].join(' ');
    expect(blob).not.toMatch(/https?:\/\//i);
    expect(blob).not.toMatch(/www\./i);
    // Connector + URL strip cleanly (no dangling "at"/"here:")
    expect(ev.description).toBe('Grab tickets before they sell out.');
    // Markdown link keeps its label, drops the URL
    expect(ev.closingLine).toContain('the site');
    // Non-URL commentary is preserved
    expect(ev.highlights).toContain('Live music all night');
    // The DB-locked eventUrl is untouched and authoritative
    expect(ev.eventUrl).toBe('https://example.com/blues');
  });

  test('strips URLs when highlights is a single string, not an array (Codex P2)', () => {
    const { locked } = lockEventFactsFromDb(
      [{ eventId: id1, title: 'Bradenton Blues', highlights: 'Buy tickets at https://fake.example' }],
      [dbRow()],
    );
    const ev = locked[0];
    expect(ev.highlights).not.toMatch(/https?:\/\//i);
    expect(ev.highlights).toBe('Buy tickets');
  });

  test('nulls a URL-only string highlight so no blank bullet renders (Codex P3)', () => {
    const { locked } = lockEventFactsFromDb(
      [{ eventId: id1, title: 'Bradenton Blues', highlights: 'at https://fake.example' }],
      [dbRow()],
    );
    expect(locked[0].highlights).toBeNull();
  });

  test('drops URL-only items from an array of highlights', () => {
    const { locked } = lockEventFactsFromDb(
      [{ eventId: id1, title: 'Bradenton Blues', highlights: ['at https://fake.example', 'Live music all night'] }],
      [dbRow()],
    );
    expect(locked[0].highlights).toEqual(['Live music all night']);
  });
});

// ── Hallucinated-claim hard-block scanner ────────────────────────────
//
// Encodes the contract that voice validation can warn about (advisory)
// vs what newsletter-validator must hard-block (factual/legal risk).
// Anything in this scanner is an error — the send route returns 400
// instead of dispatching.

describe('newsletter findHallucinatedClaims', () => {
  test('blocks dollar amounts in body', () => {
    const errors = findHallucinatedClaims('<p>Tickets are $15 at the door</p>');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('dollar amount'))).toBe(true);
  });

  test('blocks "free admission" / "free tickets" claims', () => {
    expect(findHallucinatedClaims('<p>Free admission for all!</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>Grab your free tickets at the booth</p>').length).toBeGreaterThan(0);
  });

  test('blocks "no cost" / "complimentary" admission language', () => {
    expect(findHallucinatedClaims('<p>complimentary entry for kids</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>free of charge for everyone</p>').length).toBeGreaterThan(0);
  });

  test('blocks inverted "X is free" phrasing (Codex P2)', () => {
    expect(findHallucinatedClaims('<p>Show up — admission is free.</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>tickets are free this year</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>entry is free for members</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>the event is free to attend</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>parking is free downtown</p>').length).toBeGreaterThan(0);
  });

  test('blocks pest-control efficacy and safety guarantee phrases', () => {
    expect(findHallucinatedClaims('<p>guaranteed safe for pets</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>100% effective</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>Our pet-safe formula</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>child-safe spray</p>').length).toBeGreaterThan(0);
    expect(findHallucinatedClaims('<p>EPA-approved blend</p>').length).toBeGreaterThan(0);
  });

  test('dedupes repeated patterns — one error per label', () => {
    const errors = findHallucinatedClaims('<p>$5 here. $10 there. $20 everywhere.</p>');
    expect(errors).toHaveLength(1);
  });

  test('decodes HTML entities before matching (Codex P2)', () => {
    expect(findHallucinatedClaims('<p>Tickets are &#36;15 at the door</p>').length).toBeGreaterThan(0); // numeric &#36;
    expect(findHallucinatedClaims('<p>Cover is &#x24;20</p>').length).toBeGreaterThan(0); // hex &#x24;
    expect(findHallucinatedClaims('<p>Cover is &dollar;20</p>').length).toBeGreaterThan(0); // named &dollar;
    expect(findHallucinatedClaims('<p>admission&nbsp;is&nbsp;free</p>').length).toBeGreaterThan(0); // &nbsp; word-break
    expect(findHallucinatedClaims('<p>Tickets are &amp;#36;15</p>').length).toBeGreaterThan(0); // double-encoded
  });

  test('returns empty for clean body', () => {
    const clean = '<h2>Bradenton Blues</h2><p>Live music on the riverwalk Saturday night — bring a chair.</p>';
    expect(findHallucinatedClaims(clean)).toEqual([]);
  });

  test('returns empty for missing body', () => {
    expect(findHallucinatedClaims('')).toEqual([]);
    expect(findHallucinatedClaims(null)).toEqual([]);
  });

  test('catches a Unicode homoglyph dollar sign (NFKC fold)', () => {
    // Fullwidth '＄' (U+FF04) + fullwidth digits render as "$15" to the reader
    // but are not ASCII '$'. NFKC normalization must fold them so the regex hits.
    expect(findHallucinatedClaims('<p>Tickets are ＄１５ at the door</p>').length).toBeGreaterThan(0);
  });
});

describe('newsletter assembly — HTML injection defense (markdownToHtml escaping)', () => {
  test('escapes a raw anchor tag injected via event copy', () => {
    const out = markdownToHtml('Check this <a href="https://evil.example/phish">free tickets</a> now');
    expect(out).not.toContain('<a ');
    expect(out).toContain('&lt;a href=&quot;https://evil.example/phish&quot;&gt;');
  });

  test('escapes an img onerror payload', () => {
    const out = markdownToHtml('<img src=x onerror="steal()">');
    expect(out).toBe('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
  });

  test('still renders bold/italic markdown after escaping', () => {
    expect(markdownToHtml('**bold** and _italic_')).toBe('<strong>bold</strong> and <em>italic</em>');
    expect(markdownToHtml('**_both_**')).toBe('<strong><em>both</em></strong>');
  });

  test('escapes ampersands and quotes without breaking formatting', () => {
    expect(markdownToHtml('Tom & Jerry say "hi"')).toBe('Tom &amp; Jerry say &quot;hi&quot;');
  });

  test('empty/falsy input returns empty string', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml(null)).toBe('');
  });
});

describe('newsletter safeUrl — href/src validation', () => {
  test('passes http(s) URLs through (quotes escaped)', () => {
    expect(safeUrl('https://www.eventbrite.com/e/123')).toBe('https://www.eventbrite.com/e/123');
  });

  test('rejects javascript: and data: schemes', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>x</script>')).toBeNull();
  });

  test('rejects malformed/empty input', () => {
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });

  test('escapes a double-quote that would break out of the attribute', () => {
    expect(safeUrl('https://x.test/a"onmouseover="evil')).not.toContain('"onmouseover');
  });
});

describe('newsletter sanitizeProseFields — URL strip on free-prose fields', () => {
  test('strips a bare URL the model slipped into the homeowner minute', () => {
    const draft = sanitizeProseFields({ homeownerMinute: 'Book now at https://not-waves.example/deal before it ends.' });
    expect(draft.homeownerMinute).not.toContain('http');
    expect(draft.homeownerMinute).not.toContain('not-waves');
  });

  test('keeps the label of a markdown link but drops the URL across all prose fields', () => {
    const draft = sanitizeProseFields({
      introText: 'Welcome! [click here](https://evil.example) for more',
      closingText: 'Visit www.spam.example today',
      ps: 'P.S. https://x.example',
      signoff: '— The Waves crew',
    });
    expect(draft.introText).toContain('click here');
    expect(draft.introText).not.toContain('evil.example');
    expect(draft.closingText).not.toContain('spam.example');
    expect(draft.ps).not.toContain('http');
    expect(draft.signoff).toBe('— The Waves crew');
  });

  test('leaves non-string fields untouched', () => {
    const draft = sanitizeProseFields({ greeting: null, introText: undefined });
    expect(draft.greeting).toBeNull();
    expect(draft.introText).toBeUndefined();
  });
});

describe('newsletter assembleBeehiivNewsletter — end-to-end injection + URL locking', () => {
  // No GIPHY_API_KEY in the test env, so searchGiphy returns null and assembly
  // is deterministic and network-free.
  test('a malicious event title/description cannot inject live markup, and a bad eventUrl is dropped', async () => {
    const draft = {
      selectedSubject: 'Weekend Lineup',
      greeting: 'Hey there',
      introText: 'Big week ahead.',
      events: [{
        eventId: 'a0000000-0000-4000-8000-000000000001',
        emoji: '🎵',
        title: 'Concert <img src=x onerror="steal()">',
        description: 'Go see it <a href="https://evil.example">here</a>',
        date: 'Saturday, May 31 @ 7:00 PM',
        location: 'The Venue <script>x</script>, Sarasota',
        address: '123 Main St',
        eventUrl: 'javascript:alert(1)',
        imageUrl: null,
      }],
      homeownerMinute: 'Seal your foundation.',
    };
    const html = await assembleBeehiivNewsletter(draft);
    // No live tags from model/ingested fields
    expect(html).not.toContain('onerror="steal()"');
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).not.toContain('<script>x</script>');
    // The dangerous scheme never becomes an href
    expect(html).not.toContain('javascript:alert(1)');
    // Escaped forms ARE present
    expect(html).toContain('&lt;img src=x onerror=&quot;steal()&quot;&gt;');
  });
});

describe('newsletter validateNewsletterDraft — hallucinated claims hard-block', () => {
  const baseSend = {
    subject: 'Weekend Lineup',
    html_body: '<h2>Bradenton Blues</h2><p>Live music Saturday — schedule service via wavespestcontrol.com. Homeowner Minute: prep your lawn.</p>',
    text_body: 'Weekend events',
    preview_text: 'Live music + markets this weekend',
    newsletter_type: 'local-weekly-fresh-events',
  };

  test('clean flagship body has no errors', () => {
    const { errors } = validateNewsletterDraft(baseSend, { recipientCount: 100 });
    expect(errors).toEqual([]);
  });

  test('dollar amount in flagship body produces an error', () => {
    const send = { ...baseSend, html_body: baseSend.html_body + '<p>Tickets $15</p>' };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });

  test('non-flagship type skips the hallucination scan', () => {
    const send = {
      ...baseSend,
      newsletter_type: 'service-promo',
      html_body: '<p>Limited-time offer: $99 setup!</p>',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    // Non-flagship types intentionally allow pricing — service promos quote prices
    expect(errors.filter((e) => e.includes('Hallucinated claim'))).toEqual([]);
  });

  test('dollar amount in the SUBJECT or preview text hard-blocks too — first copy a subscriber sees', () => {
    const subjectSend = { ...baseSend, subject: 'Someone\'s Going to Win $500 for Baking a Pie' };
    expect(
      validateNewsletterDraft(subjectSend, { recipientCount: 100 }).errors
        .some((e) => e.includes('Hallucinated claim')),
    ).toBe(true);
    const previewSend = { ...baseSend, preview_text: 'Free admission all weekend!' };
    expect(
      validateNewsletterDraft(previewSend, { recipientCount: 100 }).errors
        .some((e) => e.includes('Hallucinated claim')),
    ).toBe(true);
  });

  test('hallucinated claim in plain-text fallback is blocked even when HTML is clean (Codex P2)', () => {
    const send = {
      ...baseSend,
      // HTML body is clean; the text-only fallback SendGrid delivers is not
      text_body: 'Bradenton Blues this Saturday. Tickets are $15 at the door.',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });

  test('flagship send with only a text body (no HTML) is still scanned', () => {
    const send = {
      subject: 'Weekend Lineup',
      html_body: null,
      text_body: 'Free admission for everyone this weekend!',
      preview_text: 'Weekend',
      newsletter_type: 'local-weekly-fresh-events',
    };
    const { errors } = validateNewsletterDraft(send, { recipientCount: 100 });
    expect(errors.some((e) => e.includes('Hallucinated claim'))).toBe(true);
  });
});

// ── Autopilot preflight gate ─────────────────────────────────────────
//
// preflightDigest enforces the flagship type's declared quality contract
// before the Thursday auto-draft. Hard-fail (skip) on too few events or
// too few sources; city diversity + image coverage are soft warnings.
// A regression here either ships thin newsletters (gate too loose) or
// silences the autopilot every week (gate too strict).

describe('newsletter preflightDigest', () => {
  // Minimal scored-event shape — only the fields preflight reads.
  const ev = (i, { source = `s${i}`, city = `city${i}`, image = true } = {}) => ({
    id: `e${i}`,
    source_id: source,
    city,
    image_url: image ? `https://img/${i}.jpg` : null,
  });
  const plan = (events) => ({ scored: events });
  // Default thresholds match the flagship config (5 / 2 / 2 / 0.5).

  test('passes a healthy week (6 events, 3 sources, 3 cities, full images)', () => {
    const events = [0, 1, 2, 3, 4, 5].map((i) => ev(i, { source: `s${i % 3}`, city: `c${i % 3}` }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.hardFailures).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.stats.eligibleCount).toBe(6);
    expect(r.stats.sourceCount).toBe(3);
  });

  test('hard-fails when fewer than 5 eligible events', () => {
    const events = [0, 1, 2, 3].map((i) => ev(i, { source: `s${i % 2}` }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(false);
    expect(r.hardFailures.some((f) => /Eligible fresh approved events: 4 \/ required 5/.test(f))).toBe(true);
  });

  test('hard-fails when fewer than 2 distinct sources (single-source week)', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: 'only-one' }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(false);
    expect(r.hardFailures.some((f) => /Source diversity: 1 \/ required 2/.test(f))).toBe(true);
  });

  test('soft-warns on low city diversity but still passes', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: `s${i % 2}`, city: 'sarasota' }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.hardFailures).toEqual([]);
    expect(r.warnings.some((w) => /City diversity: 1 \/ recommended 2/.test(w))).toBe(true);
  });

  test('soft-warns on low image coverage but still passes', () => {
    const events = [0, 1, 2, 3, 4].map((i) => ev(i, { source: `s${i % 2}`, city: `c${i % 3}`, image: i === 0 }));
    const r = preflightDigest(plan(events));
    expect(r.pass).toBe(true);
    expect(r.warnings.some((w) => /Image coverage: 20% \/ recommended 50%/.test(w))).toBe(true);
  });

  test('measures diversity over the top-12 lineup, not the whole pool', () => {
    // 20 events but only from 1 source → still a single-source lineup
    const events = Array.from({ length: 20 }, (_, i) => ev(i, { source: 'mono' }));
    const r = preflightDigest(plan(events));
    expect(r.stats.eligibleCount).toBe(20);
    expect(r.stats.lineupSize).toBe(12);
    expect(r.pass).toBe(false); // source diversity 1 < 2
  });

  test('reads thresholds from the flagship type config', () => {
    const reqs = getFlagshipType().sourceRequirements;
    expect(reqs.minVerifiedFreshEvents).toBe(5);
    expect(reqs.minSourceDiversity).toBe(2);
    const events = [0, 1, 2, 3].map((i) => ev(i, { source: `s${i % 2}` })); // 4 events
    const r = preflightDigest(plan(events), reqs);
    expect(r.thresholds.minVerifiedFreshEvents).toBe(5);
    expect(r.pass).toBe(false); // 4 < config's 5
  });

  test('empty plan hard-fails on both gates', () => {
    const r = preflightDigest(plan([]));
    expect(r.pass).toBe(false);
    expect(r.hardFailures).toHaveLength(2);
  });

  test('dedupes by event id — duplicate ids do not inflate the gate (Codex P2)', () => {
    // [A, B, A, B, A] — 5 entries but only 2 distinct events / 2 sources.
    const a = ev(0, { source: 's0', city: 'c0' });
    const b = ev(1, { source: 's1', city: 'c1' });
    const r = preflightDigest([a, b, a, b, a]);
    expect(r.stats.eligibleCount).toBe(2); // not 5
    expect(r.pass).toBe(false); // 2 distinct < 5 required
    expect(r.hardFailures.some((f) => /Eligible fresh approved events: 2 \/ required 5/.test(f))).toBe(true);
  });
});

// ── Send analytics (derived engagement rates) ────────────────────────
//
// computeSendRates/aggregateSendMetrics derive open/click/bounce/unsub/
// complaint rates from the per-send counters the SendGrid webhook keeps.
// Denominator conventions: delivery/bounce over recipient_count; open/
// click/unsub/complaint over delivered; CTOR = clicked/opened. Zero
// denominators yield null so the UI shows "—" not a misleading 0%.

describe('newsletter computeSendRates', () => {
  test('computes all rates with the documented denominators', () => {
    const r = computeSendRates({
      recipient_count: 1000, delivered_count: 950, opened_count: 380,
      clicked_count: 95, bounced_count: 50, unsubscribed_count: 19, complained_count: 9.5,
    });
    expect(r.deliveryRate).toBeCloseTo(0.95, 5);   // 950/1000
    expect(r.openRate).toBeCloseTo(0.4, 5);        // 380/950
    expect(r.clickRate).toBeCloseTo(0.1, 5);       // 95/950
    expect(r.clickToOpenRate).toBeCloseTo(0.25, 5); // 95/380
    expect(r.bounceRate).toBeCloseTo(0.05, 5);     // 50/1000
    expect(r.unsubscribeRate).toBeCloseTo(0.02, 5); // 19/950
    expect(r.complaintRate).toBeCloseTo(0.01, 5);  // 9.5/950
  });

  test('returns null (not 0) for every rate when nothing was sent', () => {
    const r = computeSendRates({ recipient_count: 0, delivered_count: 0 });
    expect(r.deliveryRate).toBeNull();
    expect(r.openRate).toBeNull();
    expect(r.clickRate).toBeNull();
    expect(r.clickToOpenRate).toBeNull();
    expect(r.bounceRate).toBeNull();
    expect(r.unsubscribeRate).toBeNull();
    expect(r.complaintRate).toBeNull();
  });

  test('open/click rates are null when delivered is 0 even if recipients > 0', () => {
    const r = computeSendRates({ recipient_count: 100, delivered_count: 0, bounced_count: 100 });
    expect(r.deliveryRate).toBe(0);       // 0/100
    expect(r.bounceRate).toBe(1);         // 100/100
    expect(r.openRate).toBeNull();        // 0 delivered
    expect(r.clickToOpenRate).toBeNull(); // 0 opened
  });

  test('tolerates missing counter fields (treats as 0)', () => {
    const r = computeSendRates({ recipient_count: 10, delivered_count: 10 });
    expect(r.deliveryRate).toBe(1);
    expect(r.openRate).toBe(0);  // 0 opened / 10 delivered
  });
});

describe('newsletter aggregateSendMetrics', () => {
  const sent = (o) => ({ status: 'sent', ...o });

  test('pools totals across sent campaigns (weights by volume, not avg of rates)', () => {
    const agg = aggregateSendMetrics([
      sent({ recipient_count: 1000, delivered_count: 1000, opened_count: 100 }), // 10% open
      sent({ recipient_count: 10, delivered_count: 10, opened_count: 10 }),       // 100% open
    ]);
    expect(agg.campaignCount).toBe(2);
    expect(agg.totals.delivered).toBe(1010);
    expect(agg.totals.opened).toBe(110);
    // pooled = 110/1010 ≈ 0.1089, NOT the (10%+100%)/2 = 55% average
    expect(agg.rates.openRate).toBeCloseTo(110 / 1010, 5);
  });

  test('ignores drafts, scheduled, failed, and zero-recipient rows', () => {
    const agg = aggregateSendMetrics([
      sent({ recipient_count: 100, delivered_count: 100, opened_count: 50 }),
      { status: 'draft', recipient_count: 0 },
      { status: 'scheduled', recipient_count: 500 },
      { status: 'failed', recipient_count: 200, delivered_count: 0 },
      sent({ recipient_count: 0 }), // sent but no recipients — excluded
    ]);
    expect(agg.campaignCount).toBe(1);
    expect(agg.totals.recipients).toBe(100);
    expect(agg.rates.openRate).toBeCloseTo(0.5, 5);
  });

  test('empty input yields zero campaigns and null rates', () => {
    const agg = aggregateSendMetrics([]);
    expect(agg.campaignCount).toBe(0);
    expect(agg.totals.recipients).toBe(0);
    expect(agg.rates.openRate).toBeNull();
    expect(agg.rates.deliveryRate).toBeNull();
  });
});

describe('newsletter ratesFromTotals', () => {
  // The History route sums all sent rows in the DB and feeds the totals here,
  // so the aggregate isn't capped by the 500-row page window (Codex P2).
  test('computes pooled rates from a DB-summed totals object', () => {
    const r = ratesFromTotals({
      recipients: 2000, delivered: 1900, opened: 760, clicked: 190,
      bounced: 100, unsubscribed: 38, complained: 19,
    });
    expect(r.deliveryRate).toBeCloseTo(0.95, 5);
    expect(r.openRate).toBeCloseTo(0.4, 5);
    expect(r.clickRate).toBeCloseTo(0.1, 5);
    expect(r.clickToOpenRate).toBeCloseTo(0.25, 5);
    expect(r.bounceRate).toBeCloseTo(0.05, 5);
    expect(r.unsubscribeRate).toBeCloseTo(0.02, 5);
    expect(r.complaintRate).toBeCloseTo(0.01, 5);
  });

  test('all-zero totals yield null rates (no division by zero)', () => {
    const r = ratesFromTotals({});
    expect(r.deliveryRate).toBeNull();
    expect(r.openRate).toBeNull();
  });
});

// ── Per-location GBP social copy ─────────────────────────────────────
//
// Newsletter auto-share posts to 4 Google Business Profile locations. To
// avoid the same generic blast on all 4, generateNewsletterSocialContent
// emits a per-location gbp object; these helpers build/normalize it. The
// social-media loop already consumes customContent.gbp[loc.id].

describe('newsletter GBP per-location social copy', () => {
  const locIds = WAVES_LOCATIONS.map((l) => l.id);

  test('gbpFallbackByLocation covers every Waves location and names the area', () => {
    const fb = gbpFallbackByLocation();
    expect(Object.keys(fb).sort()).toEqual([...locIds].sort());
    for (const loc of WAVES_LOCATIONS) {
      expect(fb[loc.id]).toContain(loc.name); // copy is localized, not generic
      expect(fb[loc.id].length).toBeGreaterThan(0);
    }
  });

  test('normalize keeps model-provided per-location copy and fills the gaps', () => {
    const out = normalizeGbpByLocation({ sarasota: 'Siesta vibes this weekend!', venice: '   ' });
    expect(out.sarasota).toBe('Siesta vibes this weekend!'); // kept
    expect(out.venice).toContain('Venice');                   // blank → fallback
    // every location present
    expect(Object.keys(out).sort()).toEqual([...locIds].sort());
    for (const id of locIds) expect(typeof out[id]).toBe('string');
  });

  test('normalize ignores a legacy single string and localizes all 4', () => {
    const out = normalizeGbpByLocation('one generic blast for everyone');
    for (const loc of WAVES_LOCATIONS) {
      expect(out[loc.id]).toContain(loc.name);
      expect(out[loc.id]).not.toBe('one generic blast for everyone');
    }
  });

  test('normalize handles null/array/garbage by returning full fallback', () => {
    for (const bad of [null, undefined, [], 42, 'x']) {
      const out = normalizeGbpByLocation(bad);
      expect(Object.keys(out).sort()).toEqual([...locIds].sort());
    }
  });

  test('trims whitespace on model-provided captions', () => {
    const out = normalizeGbpByLocation({ parrish: '  Parrish party  ' });
    expect(out.parrish).toBe('Parrish party');
  });
});

// ── Event duplicate detection + merge helpers ────────────────────────
//
// Cross-source dupes (same event scraped from 2 feeds) clutter the queue.
// findDuplicateClusters suggests merges conservatively (same normalized
// title + ET day + city); rewriteCalendarEventIds keeps planned calendars
// pointing at the survivor after a merge.

describe('event-dedup pickSurvivor', () => {
  const ev = (id, o = {}) => ({ id, source_priority_tier: null, image_url: null, event_url: null, pulled_at: null, ...o });

  test('keeps the highest-priority source (lowest priority_tier)', () => {
    const s = pickSurvivor([ev('a', { source_priority_tier: 3 }), ev('b', { source_priority_tier: 1 }), ev('c', { source_priority_tier: 2 })]);
    expect(s.id).toBe('b');
  });

  test('a numbered tier beats a null tier (nulls last)', () => {
    const s = pickSurvivor([ev('a', { source_priority_tier: null, image_url: 'x' }), ev('b', { source_priority_tier: 4 })]);
    expect(s.id).toBe('b');
  });

  test('on equal tier, the more complete row wins (image > url)', () => {
    const s = pickSurvivor([ev('a', { source_priority_tier: 2, event_url: 'u' }), ev('b', { source_priority_tier: 2, image_url: 'i' })]);
    expect(s.id).toBe('b');
  });

  test('on equal tier + completeness, the earliest-pulled row wins', () => {
    const s = pickSurvivor([
      ev('a', { source_priority_tier: 2, pulled_at: '2026-05-10T00:00:00Z' }),
      ev('b', { source_priority_tier: 2, pulled_at: '2026-05-02T00:00:00Z' }),
    ]);
    expect(s.id).toBe('b');
  });

  test('a curated (approved/featured) row beats a higher-priority, more-complete PENDING duplicate', () => {
    const s = pickSurvivor([
      ev('a', { admin_status: 'approved', source_priority_tier: 5 }),
      ev('b', { admin_status: 'pending', source_priority_tier: 1, image_url: 'i', event_url: 'u' }),
    ]);
    expect(s.id).toBe('a'); // never drop the human-curated row from the digest
  });

  test('among equally-curated rows, falls back to priority tier', () => {
    const s = pickSurvivor([
      ev('a', { admin_status: 'approved', source_priority_tier: 3 }),
      ev('b', { admin_status: 'approved', source_priority_tier: 1 }),
    ]);
    expect(s.id).toBe('b');
  });

  test('a featured row beats an approved duplicate from a higher-priority source', () => {
    const s = pickSurvivor([
      ev('a', { admin_status: 'approved', source_priority_tier: 1 }),
      ev('b', { admin_status: 'featured', source_priority_tier: 5 }),
    ]);
    expect(s.id).toBe('b'); // explicit 'featured' curation wins over higher-priority 'approved'
  });
});

describe('event-dedup isCleanCrossSourceCluster', () => {
  const ev = (id, source_id) => ({ id, source_id });

  test('true for one row per source across 2+ sources', () => {
    expect(isCleanCrossSourceCluster([ev('a', 's1'), ev('b', 's2')])).toBe(true);
    expect(isCleanCrossSourceCluster([ev('a', 's1'), ev('b', 's2'), ev('c', 's3')])).toBe(true);
  });

  test('false for a single source (not cross-source)', () => {
    expect(isCleanCrossSourceCluster([ev('a', 's1'), ev('b', 's1')])).toBe(false);
  });

  test('false when any source contributes 2+ rows (e.g. separate showtimes)', () => {
    // s1 has two same-day rows + s2 has one — could be legit distinct sessions,
    // so the whole cluster is left for manual review, never auto-merged.
    expect(isCleanCrossSourceCluster([ev('a', 's1'), ev('b', 's1'), ev('c', 's2')])).toBe(false);
  });

  test('false for empty / single-element input', () => {
    expect(isCleanCrossSourceCluster([])).toBe(false);
    expect(isCleanCrossSourceCluster([ev('a', 's1')])).toBe(false);
  });
});

describe('event-dedup isAutoMergeableCluster', () => {
  const T = '2026-06-10T23:00:00Z';
  const ev = (id, o = {}) => ({ id, source_id: 's1', venue_name: 'Van Wezel', start_at: T, ...o });

  test('true when ≥2 sources agree on venue AND exact start time', () => {
    expect(isAutoMergeableCluster([ev('a', { source_id: 's1' }), ev('b', { source_id: 's2' })])).toBe(true);
  });

  test('false when venues differ (e.g. same-title events at different venues)', () => {
    expect(isAutoMergeableCluster([
      ev('a', { source_id: 's1', venue_name: 'Venue A' }),
      ev('b', { source_id: 's2', venue_name: 'Venue B' }),
    ])).toBe(false);
  });

  test('false when start times differ (e.g. matinee vs evening)', () => {
    expect(isAutoMergeableCluster([
      ev('a', { source_id: 's1', start_at: '2026-06-10T19:00:00Z' }),
      ev('b', { source_id: 's2', start_at: '2026-06-10T23:00:00Z' }),
    ])).toBe(false);
  });

  test('false when any row has a blank/null venue', () => {
    expect(isAutoMergeableCluster([ev('a', { source_id: 's1', venue_name: null }), ev('b', { source_id: 's2' })])).toBe(false);
  });

  test('false when not a clean cross-source cluster (single source)', () => {
    expect(isAutoMergeableCluster([ev('a', { source_id: 's1' }), ev('b', { source_id: 's1' })])).toBe(false);
  });
});

describe('event-dedup computeSurvivorBackfill', () => {
  test('copies event_url onto a survivor that lacks it (keeps the event eligible)', () => {
    const survivor = { id: 'a', event_url: null, image_url: 'i' };
    const losers = [{ id: 'b', event_url: 'https://x/e', image_url: null }];
    expect(computeSurvivorBackfill(survivor, losers)).toEqual({ event_url: 'https://x/e' });
  });

  test('copies both event_url and image_url when both missing', () => {
    const survivor = { id: 'a', event_url: null, image_url: null };
    const losers = [{ id: 'b', event_url: 'https://x/e' }, { id: 'c', image_url: 'https://x/i' }];
    expect(computeSurvivorBackfill(survivor, losers)).toEqual({ event_url: 'https://x/e', image_url: 'https://x/i' });
  });

  test('no backfill when the survivor already has the fields', () => {
    const survivor = { id: 'a', event_url: 'https://s/e', image_url: 'https://s/i' };
    const losers = [{ id: 'b', event_url: 'https://x/e', image_url: 'https://x/i' }];
    expect(computeSurvivorBackfill(survivor, losers)).toEqual({});
  });

  test('no backfill when no loser has the missing field', () => {
    const survivor = { id: 'a', event_url: null, image_url: null };
    const losers = [{ id: 'b', event_url: null, image_url: null }];
    expect(computeSurvivorBackfill(survivor, losers)).toEqual({});
  });
});

describe('event normalizeEventTitle', () => {
  test('strips punctuation, case, and noise words', () => {
    expect(normalizeEventTitle('The Bradenton Blues Festival!')).toBe('bradenton blues festival');
    expect(normalizeEventTitle('Jazz & Wine presents: A Night Out')).toBe('jazz and wine night out');
  });
  test('two feeds with cosmetic differences normalize equal', () => {
    expect(normalizeEventTitle('Sarasota Farmers Market'))
      .toBe(normalizeEventTitle('  sarasota   FARMERS market '));
  });
});

describe('event findDuplicateClusters', () => {
  const ev = (o) => ({ image_url: null, event_url: null, pulled_at: null, ...o });

  test('clusters same title + same ET day + same city from different sources', () => {
    const clusters = findDuplicateClusters([
      ev({ id: 'a', title: 'Blues Fest', start_at: '2026-05-30T23:00:00Z', city: 'Bradenton', source_id: 's1', event_url: 'u' }),
      ev({ id: 'b', title: 'The Blues Fest', start_at: '2026-05-30T20:00:00Z', city: 'bradenton', source_id: 's2', image_url: 'img' }),
      ev({ id: 'c', title: 'Sarasota Market', start_at: '2026-05-31T13:00:00Z', city: 'Sarasota', source_id: 's1' }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events.map((e) => e.id).sort()).toEqual(['a', 'b']);
    // 'b' has an image → suggested primary (more complete)
    expect(clusters[0].suggestedPrimaryId).toBe('b');
  });

  test('does NOT cluster same title on different days', () => {
    const clusters = findDuplicateClusters([
      ev({ id: 'a', title: 'Weekly Market', start_at: '2026-05-30T13:00:00Z', city: 'Venice' }),
      ev({ id: 'b', title: 'Weekly Market', start_at: '2026-06-06T13:00:00Z', city: 'Venice' }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  test('ignores undated or untitled or city-less events (too risky to claim)', () => {
    const clusters = findDuplicateClusters([
      ev({ id: 'a', title: 'Market', start_at: null, city: 'Venice' }),
      ev({ id: 'b', title: 'Market', start_at: '2026-05-30T13:00:00Z', city: '' }),
      ev({ id: 'c', title: '', start_at: '2026-05-30T13:00:00Z', city: 'Venice' }),
    ]);
    expect(clusters).toHaveLength(0);
  });

  test('singletons are not returned', () => {
    expect(findDuplicateClusters([
      ev({ id: 'a', title: 'Solo Event', start_at: '2026-05-30T13:00:00Z', city: 'Venice' }),
    ])).toEqual([]);
  });
});

describe('event rewriteCalendarEventIds', () => {
  test('replaces merged ids with the primary and dedupes', () => {
    expect(rewriteCalendarEventIds(['a', 'b', 'c'], { b: 'a' })).toEqual(['a', 'c']);
  });
  test('collapses when primary already present', () => {
    expect(rewriteCalendarEventIds(['a', 'b'], { b: 'a' })).toEqual(['a']);
  });
  test('returns null when nothing changes (skip the DB write)', () => {
    expect(rewriteCalendarEventIds(['x', 'y'], { b: 'a' })).toBeNull();
    expect(rewriteCalendarEventIds([], { b: 'a' })).toBeNull();
  });
  test('accepts a Map merge map', () => {
    expect(rewriteCalendarEventIds(['a', 'b', 'd'], new Map([['b', 'a'], ['d', 'a']]))).toEqual(['a']);
  });
});

// ── Merged-event durability ──────────────────────────────────────────
//
// A row merged into another event must stay out of newsletters forever,
// even if an admin later re-approves it — calendars were already repointed
// to the survivor. isEligibleForFreshDigest enforces this regardless of
// admin_status (the digest/approved SQL also adds whereNull('merged_into')).

describe('event isEligibleForFreshDigest — merged_into durability', () => {
  // A row that would otherwise be fully eligible.
  const base = () => ({
    admin_status: 'approved',
    event_url: 'https://example.com/e',
    event_type: 'one_time',
    freshness_status: 'fresh_one_time',
    start_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  });

  test('an eligible event passes when not merged', () => {
    expect(isEligibleForFreshDigest({ ...base(), merged_into: null })).toBe(true);
  });

  test('a merged event is ineligible even when re-approved', () => {
    expect(isEligibleForFreshDigest({ ...base(), admin_status: 'approved', merged_into: 'some-primary-uuid' })).toBe(false);
    expect(isEligibleForFreshDigest({ ...base(), admin_status: 'featured', merged_into: 'some-primary-uuid' })).toBe(false);
  });
});

describe('newsletter quiz — config, rendering, tag resolution', () => {
  const quiz = require('../services/newsletter-quiz');
  const { stripPersonalizationTokens } = require('../services/newsletter-draft');
  const TOK = '11111111-2222-3333-4444-555555555555';

  test('hasQuizToken detects both the html and text tokens', () => {
    expect(quiz.hasQuizToken('hello {{quiz}} world')).toBe(true);
    expect(quiz.hasQuizToken('plain {{quiz-text}} part')).toBe(true);
    expect(quiz.hasQuizToken('no token here')).toBe(false);
    expect(quiz.hasQuizToken(null)).toBe(false);
  });

  test('resolveAnswer returns the answer + its interest tags, null for unknowns', () => {
    expect(quiz.resolveAnswer('lawn-headache-v1', 'brown-patch')).toEqual({
      key: 'brown-patch', label: 'Brown patches', tags: ['lawn-interested', 'lawn:brown-patch'],
    });
    expect(quiz.resolveAnswer('lawn-headache-v1', 'not-sure').tags).toEqual(['lawn-interested']);
    expect(quiz.resolveAnswer('lawn-headache-v1', 'nope')).toBeNull();
    expect(quiz.resolveAnswer('no-such-quiz', 'brown-patch')).toBeNull();
  });

  test('every answer carries the broad lawn-interested tag so "any engager" stays targetable', () => {
    for (const a of quiz.getQuiz('lawn-headache-v1').answers) {
      expect(a.tags).toContain('lawn-interested');
    }
  });

  test('renderQuizHtml emits one tokenized answer link per answer', () => {
    const html = quiz.renderQuizHtml({ token: TOK, quizId: 'lawn-headache-v1' });
    const links = html.match(/\/api\/public\/newsletter\/quiz\//g) || [];
    expect(links.length).toBe(4);
    expect(html).toContain(TOK);
    expect(html).toContain('/lawn-headache-v1/brown-patch');
  });

  test('renderQuizHtml falls back to a link-free neutral block when the token is missing/invalid', () => {
    expect(quiz.renderQuizHtml({ token: null }).includes('/quiz/')).toBe(false);
    expect(quiz.renderQuizHtml({ token: 'not-a-uuid' }).includes('/quiz/')).toBe(false);
    // still shows the question so archive/preview readers see content
    expect(quiz.renderQuizHtml({ token: null })).toContain("biggest headache");
  });

  test('renderQuizText lists each answer with its per-recipient URL', () => {
    const txt = quiz.renderQuizText({ token: TOK });
    expect(txt).toContain("What's your lawn's biggest headache?");
    expect((txt.match(/https:\/\//g) || []).length).toBe(4);
  });

  test('quizAnswerUrl URL-encodes its path segments', () => {
    const url = quiz.quizAnswerUrl(TOK, 'lawn-headache-v1', 'brown-patch');
    expect(url).toMatch(/\/quiz\/11111111-2222-3333-4444-555555555555\/lawn-headache-v1\/brown-patch$/);
  });

  test('neutralizeQuizTokens strips both raw tokens (no literal {{quiz}} leaks)', () => {
    const out = quiz.neutralizeQuizTokens('a {{quiz}} b {{quiz-text}} c');
    expect(out).not.toContain('{{quiz}}');
    expect(out).not.toContain('{{quiz-text}}');
  });

  test('stripPersonalizationTokens neutralizes the quiz AND still handles greeting/city/grass', () => {
    const out = stripPersonalizationTokens('Hi{{greeting-name}} in {{city}} ({{grass-type}}) {{quiz}}');
    expect(out).not.toContain('{{quiz}}');
    expect(out).not.toContain('{{greeting-name}}');
    expect(out).not.toContain('{{city}}');
    expect(out).not.toContain('{{grass-type}}');
  });

  test('recordQuizResponse fails closed on a bad token or bad answer without touching the DB', async () => {
    await expect(quiz.recordQuizResponse({ token: 'not-a-uuid', quizId: 'lawn-headache-v1', answerKey: 'weeds' }))
      .resolves.toEqual({ ok: false, reason: 'bad-token' });
    await expect(quiz.recordQuizResponse({ token: TOK, quizId: 'lawn-headache-v1', answerKey: 'nope' }))
      .resolves.toEqual({ ok: false, reason: 'bad-answer' });
  });
});

describe('newsletter quiz — multi-quiz tokens + picker/results helpers (Phase 2b)', () => {
  const quiz = require('../services/newsletter-quiz');
  const T = '11111111-2222-3333-4444-555555555555';

  test('listQuizzes returns lawn/pest/mosquito with answers + tags', () => {
    const ids = quiz.listQuizzes().map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining(['lawn-headache-v1', 'pest-pressure-v1', 'mosquito-v1']));
    const pest = quiz.listQuizzes().find((q) => q.id === 'pest-pressure-v1');
    expect(pest.answers.find((a) => a.key === 'ants').tags).toContain('pest:ants');
  });

  test('parseQuizTokens extracts default + id + text variants, deduped', () => {
    const parsed = quiz.parseQuizTokens('a {{quiz}} b {{quiz:pest-pressure-v1}} c {{quiz-text}} d {{quiz}}');
    expect(parsed).toEqual([
      { raw: '{{quiz}}', isText: false, quizId: 'lawn-headache-v1' },
      { raw: '{{quiz:pest-pressure-v1}}', isText: false, quizId: 'pest-pressure-v1' },
      { raw: '{{quiz-text}}', isText: true, quizId: 'lawn-headache-v1' },
    ]);
  });

  test('hasQuizToken matches id form and rejects near-misses', () => {
    expect(quiz.hasQuizToken('x {{quiz:mosquito-v1}} y')).toBe(true);
    expect(quiz.hasQuizToken('x {{quizfoo}} y')).toBe(false);
    expect(quiz.hasQuizToken('x {{quiz-textfoo}} y')).toBe(false);
  });

  test('buildQuizSubstitutions keys each token with its correct html/text render', () => {
    const subs = quiz.buildQuizSubstitutions('{{quiz:pest-pressure-v1}} {{quiz-text:pest-pressure-v1}}', { token: T });
    expect(Object.keys(subs).sort()).toEqual(['{{quiz-text:pest-pressure-v1}}', '{{quiz:pest-pressure-v1}}']);
    expect(subs['{{quiz:pest-pressure-v1}}']).toContain('/pest-pressure-v1/ants');
    expect(subs['{{quiz:pest-pressure-v1}}']).toContain(T);
    expect(subs['{{quiz-text:pest-pressure-v1}}']).toContain('https://'); // text links
  });

  test('neutralizeQuizTokens handles id tokens and drops unknown quizzes', () => {
    const out = quiz.neutralizeQuizTokens('a {{quiz:mosquito-v1}} b {{quiz:nope}} c');
    expect(out).not.toContain('{{quiz');
    expect(out).toContain('running you off'); // mosquito question rendered
  });

  test('an answer with no tags (mosquito "We\'re good") records but writes no tag', async () => {
    // resolveAnswer present, tags empty → recordQuizResponse short-circuits the
    // tag merge. We only assert the config here (DB path needs a live row).
    expect(quiz.resolveAnswer('mosquito-v1', 'were-good').tags).toEqual([]);
  });
});

describe('newsletter quiz — aggregateQuizResults (results dashboard)', () => {
  const { aggregateQuizResults } = require('../services/newsletter-quiz');

  test('groups by quiz, labels answers, orders by config, computes rate', () => {
    const rows = [
      { quiz_id: 'lawn-headache-v1', quiz_answer: 'weeds', n: '5' },
      { quiz_id: 'lawn-headache-v1', quiz_answer: 'brown-patch', n: 17 },
      { quiz_id: 'lawn-headache-v1', quiz_answer: 'bugs', n: 6 },
    ];
    const out = aggregateQuizResults({ rows, totalRecipients: 100 });
    expect(out.totalResponses).toBe(28);
    expect(out.responseRate).toBe(28);
    expect(out.quizzes).toHaveLength(1);
    const q = out.quizzes[0];
    expect(q.question).toMatch(/biggest headache/);
    expect(q.responses).toBe(28);
    // config order: brown-patch, weeds, bugs, not-sure → brown-patch first
    expect(q.answers.map((a) => a.key)).toEqual(['brown-patch', 'weeds', 'bugs']);
    expect(q.answers[0]).toMatchObject({ key: 'brown-patch', label: 'Brown patches', count: 17 });
  });

  test('empty rows → zero responses, zero rate, no quizzes', () => {
    expect(aggregateQuizResults({ rows: [], totalRecipients: 50 })).toEqual({
      totalRecipients: 50, totalResponses: 0, responseRate: 0, quizzes: [],
    });
  });

  test('handles multiple quizzes and legacy/unknown answer keys (sorted last, raw label)', () => {
    const rows = [
      { quiz_id: 'pest-pressure-v1', quiz_answer: 'ants', n: 3 },
      { quiz_id: 'pest-pressure-v1', quiz_answer: 'legacy-x', n: 1 },
      { quiz_id: 'mosquito-v1', quiz_answer: 'every-night', n: 2 },
    ];
    const out = aggregateQuizResults({ rows, totalRecipients: 0 });
    expect(out.responseRate).toBe(0); // no divide-by-zero
    const pest = out.quizzes.find((q) => q.quizId === 'pest-pressure-v1');
    expect(pest.answers.map((a) => a.key)).toEqual(['ants', 'legacy-x']); // unknown last
    expect(pest.answers.find((a) => a.key === 'legacy-x').label).toBe('legacy-x'); // raw fallback
  });
});
