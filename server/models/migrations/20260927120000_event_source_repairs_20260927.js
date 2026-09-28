/**
 * Event-source fleet repair — 2026-09-27 live probe results.
 *
 * The newsletter's best local-events sources were either hard-failing or
 * silently yielding nothing. Every change below was verified against the
 * live endpoint on 2026-09-27 (HTTP status, robots.txt, and — for a
 * repaired source — a sample of real upcoming events) unless noted.
 *
 * DISABLED (3) — no automated path to content exists without evading bot
 * protection, which this repair pass will not do:
 *   - Visit Sarasota County — Events, Visit St. Pete-Clearwater — Events:
 *     both are still a site-wide Cloudflare Managed Challenge — every path
 *     on the domain (including /robots.txt) returns 403/challenge to curl
 *     AND to a declared browser UA, so this is IP/reputation-based, not a
 *     UA filter. The 20260805000001 repair opted both into
 *     scrape_config.proxy='residential' to route around exactly this, but
 *     EVENT_PULL_PROXY_URL was never provisioned in prod (confirmed via
 *     `railway variables` — unset) — so for the entire ~60-run failure
 *     streak these sources have silently fallen back to the same direct
 *     pull that was already failing (resolveProxyConfig's documented
 *     fallback). No official off-domain feed exists for either DMO's
 *     event calendar (checked for a Simpleview widget/RSS export on a
 *     separate, unprotected host — none reachable). Disabling rather than
 *     escalating the evasion (rotating proxies, etc.) per this repair
 *     pass's ground rules.
 *   - Visit Tampa Bay — Events: confirmed still a Simpleview JS shell —
 *     the rendered DOM (fetched live) has no event markup at all; the
 *     listing loads from a token-gated XHR API after hydration, same as
 *     20260622000001 found. That migration disabled it for exactly this
 *     reason, but prod shows it enabled=true today. No migration or
 *     application code path in this repo ever sets event_sources.enabled
 *     back to true for this row (grep across server/routes, server/
 *     services, ops/, and every migration confirms the only writers are
 *     the seed migrations and the disable passes themselves) — it was
 *     re-enabled by an out-of-band prod write this repo has no record of.
 *     Re-disabling; lifting the XHR token is the evasion this pass won't
 *     do, and no official RSS/iCal alternative exists on visittampabay.com.
 *
 * NOT CHANGED: Ringling Museum's 403s are intermittent Cloudflare bot-fight
 * responses. A browser User-Agent would get past them, but that is evasion
 * (owner rule 2026-09-27: official feeds only, never work around a block).
 * The source keeps its current config and still succeeds on some pulls.
 *
 * REPAIRED (config-only):
 *   - City of Clearwater — Events: server-rendered, no JS needed — the
 *     real listing (dated, addressed events under
 *     .list-item-block-date / .list-item-block-desc) lives inside
 *     `.events-list-container`, ~17KB into a 764KB page. The default
 *     <body> grab truncates at 25KB and never reaches it (same failure
 *     mode 20260611000015/20260622000001 found for Lakewood Ranch and
 *     Sarasota Chamber) — every "success" pull was actually extracting
 *     from page chrome. contentSelector pins extraction to the verified
 *     container; the container itself is small, so no maxHtmlChars bump
 *     is needed (30000 for headroom as the event count grows).
 *   - Mote Marine Laboratory — Events: the stored feed_url
 *     (mote.org/events/?ical=1) returns HTTP 200 with an EMPTY body — The
 *     Events Calendar plugin's iCal export needs `eventDisplay=list`
 *     (visible on the page's own "Subscribe" links, e.g. the Google
 *     Calendar / Outlook webcal hrefs); the bare `?ical=1` on the
 *     `/events/` alias serves nothing. The corrected export URL
 *     (`/?post_type=tribe_events&ical=1&eventDisplay=list`) returned 30
 *     VEVENTs live with real 2026 dates.
 *   - Wellen Park — Events: the stored RSS feed
 *     (wellenpark.com/events/feed/) is a WordPress "Events Archive" feed
 *     whose 10 items are all evergreen recurring meetups first published
 *     in 2023, with a stub description ("The post … appeared first on
 *     Wellen Park.") and no event date anywhere in the item — structurally
 *     unable to ever yield under the RSS news-mode requireStart contract.
 *     The site's own /events/ page is a different, real, actively updated
 *     listing (dated Oct/Nov/Dec 2026 events with times and descriptions)
 *     inside `section.featured-events-slider`, ~32KB into an 850KB page —
 *     again past the default truncation window. Switched feed_type to
 *     'scrape' pointed at that page with a pinned contentSelector.
 *   - Sarasota Magazine: the stored feed (/feed) is the GENERAL news feed
 *     (property tax, college rankings, real estate) — legitimately almost
 *     never states an event date, and even the on-topic
 *     /arts-and-entertainment section feed only carries a one-sentence
 *     teaser per item (no dates), so news-mode extraction can never find
 *     a requireStart date in EITHER feed regardless of topic. The
 *     magazine runs a standing "Things to Do in Sarasota This Week"
 *     article at a STABLE URL that is rewritten in place every week and
 *     lists each pick with an explicit day/date/time/venue line (verified
 *     live, e.g. "Thursday, Sept. 24, 7-8 p.m., … Sarasota") — switched
 *     feed_type to 'scrape' pointed at that page (page mode does not
 *     require a stated date the way news-mode articles do).
 *
 * LOWERED PRIORITY (least invasive lever for volume/quality, not a hard
 * filter — event-ingestion.js has no per-source topic/category exclusion
 * config today, and adding one is out of scope for a config-only repair
 * pass): Lakewood Ranch and Manatee Chamber post huge volumes of low-value
 * items (open houses, ribbon cuttings, retail promos, classes) that pass
 * ingestion but almost never clear editorial curation. priority_tier
 * feeds a real, if modest, lever: event-freshness.js's sourceTrustScore
 * (10% of the total editorial score) maps tier 1→100, 2→80, 3→60 — moving
 * both sources to the lowest tier already in use (3) trims their trust
 * contribution and lets a same-tier source win event-dedup.js's
 * duplicate-merge tie-break instead of them. This will not by itself fix
 * the noise ratio (the weight is small); a real fix needs either a
 * per-source content filter in the extraction prompt or curation-side
 * category rules, both left for a follow-up.
 *
 * NOT touched: Bay News 9 — On The Town (RSS, zero-yield only 1 of the
 * last several runs, nonzero the day before — ordinary feed quiet day,
 * not a broken source); Visit Venice FL, Clearwater Marine Aquarium,
 * Sarasota Chamber, Van Wezel, Venice Chamber, Anna Maria Chamber — all
 * yielded on their last run.
 */

const CLEARWATER_FEED_URL = 'https://www.myclearwater.com/Events-and-Meetings';
const MOTE_OLD_FEED_URL = 'https://mote.org/events/?ical=1';
const MOTE_NEW_FEED_URL = 'https://mote.org/?post_type=tribe_events&ical=1&eventDisplay=list';
const WELLEN_OLD_FEED_URL = 'https://wellenpark.com/events/feed/';
const WELLEN_NEW_FEED_URL = 'https://wellenpark.com/events/';
const SARASOTA_MAG_OLD_FEED_URL = 'https://www.sarasotamagazine.com/feed';
const SARASOTA_MAG_NEW_FEED_URL = 'https://www.sarasotamagazine.com/arts-and-entertainment/things-to-do-sarasota';
const LAKEWOOD_RANCH_FEED_URL = 'https://lakewoodranch.com/connect/events-list/';
const MANATEE_CHAMBER_FEED_URL = 'https://business.manateechamber.com/feed/rss/UpcomingEvents.rss';

const DISABLE_FEED_URLS = [
  'https://www.visitsarasota.com/events-festivals',
  'https://www.visitstpeteclearwater.com/events',
  'https://www.visittampabay.com/tampa-events/all-events/',
];

// Merge-patch scrape_config, preserving any operator-edited keys — same
// convention as 20260611000015 / 20260622000001 / 20260805000001.
async function mergeScrapeConfig(knex, feedUrl, patch) {
  await knex.raw(
    `UPDATE event_sources
     SET scrape_config = COALESCE(scrape_config, '{}'::jsonb) || ?::jsonb,
         updated_at = now()
     WHERE feed_url = ?`,
    [JSON.stringify(patch), feedUrl],
  );
}

// Reset the health counters on a row we just repaired so its next pull is
// judged fresh rather than carrying the old failure/zero-yield streak
// into the health alert thresholds.
async function resetHealthCounters(knex, feedUrl) {
  await knex('event_sources')
    .where({ feed_url: feedUrl })
    .update({
      consecutive_failures: 0,
      consecutive_zero_yields: 0,
      last_error: null,
      updated_at: knex.fn.now(),
    });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  // ── Disable the unrecoverable ────────────────────────────────────
  await knex('event_sources')
    .whereIn('feed_url', DISABLE_FEED_URLS)
    .update({ enabled: false, updated_at: knex.fn.now() });

  // ── Clearwater: pin the listing container past the truncation cut ─
  await mergeScrapeConfig(knex, CLEARWATER_FEED_URL, {
    contentSelector: '.events-list-container',
    maxHtmlChars: 30000,
  });
  await resetHealthCounters(knex, CLEARWATER_FEED_URL);

  // ── Mote: fix the broken iCal export URL ──────────────────────────
  await knex('event_sources')
    .where({ feed_url: MOTE_OLD_FEED_URL })
    .update({ feed_url: MOTE_NEW_FEED_URL, updated_at: knex.fn.now() });
  await resetHealthCounters(knex, MOTE_NEW_FEED_URL);

  // ── Wellen Park: swap the dead archive RSS for the real events page ─
  await knex('event_sources')
    .where({ feed_url: WELLEN_OLD_FEED_URL })
    .update({ feed_url: WELLEN_NEW_FEED_URL, feed_type: 'scrape', updated_at: knex.fn.now() });
  await mergeScrapeConfig(knex, WELLEN_NEW_FEED_URL, {
    contentSelector: 'section.featured-events-slider',
    maxHtmlChars: 40000,
  });
  await resetHealthCounters(knex, WELLEN_NEW_FEED_URL);

  // ── Sarasota Magazine: swap the general news feed for the standing
  //    "Things to Do" roundup page ──────────────────────────────────
  await knex('event_sources')
    .where({ feed_url: SARASOTA_MAG_OLD_FEED_URL })
    .update({ feed_url: SARASOTA_MAG_NEW_FEED_URL, feed_type: 'scrape', updated_at: knex.fn.now() });
  await mergeScrapeConfig(knex, SARASOTA_MAG_NEW_FEED_URL, {
    contentSelector: '.c-body',
  });
  await resetHealthCounters(knex, SARASOTA_MAG_NEW_FEED_URL);

  // ── Lower trust/priority for the high-volume, low-value sources ──
  await knex('event_sources')
    .where({ feed_url: LAKEWOOD_RANCH_FEED_URL })
    .update({ priority_tier: 3, updated_at: knex.fn.now() });
  await knex('event_sources')
    .where({ feed_url: MANATEE_CHAMBER_FEED_URL })
    .update({ priority_tier: 3, updated_at: knex.fn.now() });
};

// Documented no-op (waves-db data-correction rule): up() does not record the
// prior state, and blindly reversing it would re-enable Visit Tampa Bay
// (already disabled by 20260622000001) and overwrite operator-set tiers.
exports.down = async function down() {};
