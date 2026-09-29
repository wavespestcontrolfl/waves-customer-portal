/**
 * Event-source follow-up to #5112 (20260927120000 / 130000 / 140000),
 * from the 2026-09-28 4 AM ET prod pull. Live-probed 2026-09-28 with curl,
 * no UA spoofing, no headless browser, no bot-wall workaround (owner rule:
 * official feeds only).
 *
 * DISABLED:
 *   - Benchmark International Arena, Yuengling Center (#5112 iCal
 *     sources): every pull since they were added failed "Request failed
 *     with status code 403". Every path on both domains, robots.txt
 *     included, answers 403 from a datacenter address — the same
 *     whole-domain block 20260927120000 found on Visit Sarasota and Visit
 *     St. Pete-Clearwater, which it disabled. The residential-proxy opt-in
 *     (20260805000001) is no help here: EVENT_PULL_PROXY_URL is not set in
 *     prod, and the iCal handler has no proxy path. Re-enable if a gateway
 *     is provisioned and iCal proxying is added and verified.
 *   - City of St. Petersburg (events.stpete.org): a Revize/FullCalendar
 *     widget. The server HTML carries no event markup; events load from an
 *     AJAX URL built at runtime in minified JS. 60 consecutive zero-yield
 *     pulls. No official RSS/iCal feed on the domain.
 *
 * NOT CHANGED (config already correct; see the PR body):
 *   - City of Clearwater: the #5112 selector pin works; page 1 of 10 is all
 *     recurring classes and government meetings, which extraction rightly
 *     skips. Reaching later pages needs the site's postback pager.
 *   - Bay News 9: a quiet feed day (one dated item, already past).
 *   - Mote Marine, Sarasota Magazine, Wellen Park: live feeds carry dated
 *     events; they were simply not reached on 09-28. The in-process,
 *     sequential run went silent at ~08:03Z as deploys from 07:59Z/08:00Z
 *     merges landed. Fixed in code in this same change
 *     (event-ingestion.js: sources the last run never reached go first,
 *     and a bounded extraction timeout).
 */

const DISABLE_FEED_URLS = [
  'https://www.benchmarkintlarena.com/events/?ical=1',
  'https://www.yuenglingcenter.com/events/?ical=1',
  'https://events.stpete.org/',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources')
    .whereIn('feed_url', DISABLE_FEED_URLS)
    .update({ enabled: false, updated_at: knex.fn.now() });
};

// Documented no-op (waves-db data-correction rule): up() does not record
// prior state, so down() cannot tell a source this disabled from one an
// operator had already disabled.
exports.down = async function down() {};
