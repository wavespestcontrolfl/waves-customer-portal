/**
 * Add venue event sources — newsletter corridor gap-fill, 2026-09-27.
 *
 * The weekly local-events newsletter's editorial rubric rewards touring
 * headliners, premieres, festivals, pro sports, and one-night specials, but
 * the source list before this migration leaned on city/chamber aggregators
 * (round3, 20260427000004/5) with only a handful of single-venue feeds (Van
 * Wezel, Selby, Ringling, Clearwater Marine Aquarium, Mote). This migration
 * adds 6 direct venue feeds surveyed against ~30 candidates named in the
 * corridor brief (Asolo Rep, Sarasota Opera, Florida Studio Theatre,
 * Sarasota Orchestra, Venice Theatre, Straz Center, Amalie/Benchmark Arena,
 * Raymond James Stadium, The Dalí Museum, Florida Aquarium, Sarasota
 * Paradise, Robarts Arena, Nathan Benderson Park, Tampa Theatre, Jannus
 * Live, and others found along the way).
 *
 * ADDED (all probed live 2026-09-27, robots.txt confirmed open, feed
 * verified with real upcoming VEVENTs / server-rendered listing):
 *
 *   - Benchmark International Arena (Tampa Bay Lightning's arena, Tampa) —
 *     WP Tribe Events iCal. 30 VEVENTs, 12 in the next 30 days / 27 in 60.
 *     Touring headliners (Jonas Brothers, Weezer, Los Tigres del Norte) AND
 *     the Lightning's home schedule in one feed.
 *   - The Dalí Museum (St. Petersburg) — WP Tribe Events iCal. 30 VEVENTs,
 *     14 in 30 days / 22 in 60. Exhibition openings ("Dalí: Disruption +
 *     Devotion" opening celebration), film screenings, curator talks.
 *   - Ruth Eckerd Hall (Clearwater) — custom WP events listing, server-
 *     rendered (verified with a plain curl fetch, no JS execution needed).
 *     ONE feed covers three venues the org operates (Ruth Eckerd Hall, the
 *     Bilheimer Capitol Theatre, The BayCare Sound amphitheater) — page 1
 *     alone had 12 shows Oct 2–11 (Tom Jones, The Avett Brothers, America,
 *     Ziggy Marley & Gov't Mule, Boz Scaggs, Postmodern Jukebox), with a
 *     13-page listing behind it. contentSelector pins the
 *     `.eventList.event_list_grid` container (verified against the live
 *     page — the search-modal template also carries an `event_list` class,
 *     so the more specific two-class selector avoids matching that decoy).
 *   - The Mahaffey Theater (St. Petersburg) — custom WP "Upcoming Shows"
 *     grid, server-rendered. CAAMP, Nurse John, Florida Orchestra opening
 *     night, Beatles/Scheherazade programs Oct 2–17 alone.
 *     contentSelector pins `.vc_grid-container` (Visual Composer grid,
 *     verified against the live page); maxHtmlChars at the handler's 60000
 *     ceiling since the container is large (page-builder bloat, same
 *     category as the Selby/Ringling repair in 20260611000015).
 *   - Venice Performing Arts Center (Venice) — WP Tribe Events iCal. 30
 *     VEVENTs, 4 in 30 days / 10 in 60. Mix of school ensemble concerts
 *     (lower editorial priority, left to the existing scoring/dedup) and
 *     real touring/tribute acts (Alan Jackson, Cher tribute, Beatles vs.
 *     Stones, a John Denver tribute) plus Venice Symphony dates.
 *   - Yuengling Center (USF, Tampa) — WP Tribe Events iCal. 19 VEVENTs, 9 in
 *     30 days / 15 in 60. Dermot Kennedy, TNA Wrestling, Steve Lacy, CeCe
 *     Winans, Victoria Monét, plus USF Women's Volleyball home dates.
 *
 * All six get priority_tier 1 (top tier, per the corridor brief) — a direct
 * venue feed is the most authoritative source for its own events, ranking
 * it above the chamber/city aggregators that also carry the same shows
 * secondhand. This is a deliberate departure from the existing Van
 * Wezel/Selby/Ringling rows, which are tier 2 from an earlier pass; not
 * touched here (out of this migration's scope — data-only INSERT).
 *
 * REJECTED (probed, not added — see the PR/handoff notes for the full
 * list): Asolo Rep, Sarasota Opera, Florida Studio Theatre, Sarasota
 * Orchestra, Venice Theatre (all Tessitura/Vendini ticketing widgets — the
 * event listing itself is a client-side "tn-"/JS component, confirmed on
 * Venice Theatre and Sarasota Opera; no server-rendered or feed path).
 * Straz Center (Incapsula bot wall on every request). Robarts
 * Arena/Sarasota Fairgrounds and Charlotte Harbor Event & Conference Center
 * (same GrowthZone/MicroNet CMS — nav renders server-side, the actual event
 * grid loads via a client-side widgetservice.asmx call). Raymond James
 * Stadium (Squarespace RSS feed exists but has been empty since 2020).
 * Sarasota Paradise, Tampa Bay Rowdies (React/SportsEngine SPA shells, no
 * server-rendered schedule). MidFlorida Credit Union Amphitheatre
 * (Next.js/Ticketmaster SPA — only the single hero event is server-embedded
 * as JSON-LD, the full schedule is client-rendered). Florida Aquarium,
 * MOSI, Bishop Museum of Science and Nature, Manatee Performing Arts
 * Center, Glazer Children's Museum, Tampa Bay History Center, St. Pete
 * Pier (no discoverable iCal/RSS; Manatee PAC and St. Pete Pier are
 * Cloudflare-challenged). Nathan Benderson Park (WP Tribe iCal works, but
 * the feed is dominated by recurring low-value filler — "Sip N' Brew",
 * "Florida Pops" reposted for nearly every date — that doesn't clear this
 * pass's quality bar). Mote SEA (the new aquarium's site isn't live yet).
 * Sarasota Film Festival (annual-only, no feed, would sit dormant most of
 * the year). Amalie Arena is the same building as Benchmark International
 * Arena under a new naming-rights sponsor — one feed, not two.
 */

const NEW_SOURCES = [
  {
    name: 'Benchmark International Arena — Events',
    url: 'https://www.benchmarkintlarena.com/events/',
    feed_url: 'https://www.benchmarkintlarena.com/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{tampa,hillsborough}',
    priority_tier: 1,
  },
  {
    name: 'The Dalí Museum — Events',
    url: 'https://thedali.org/events/',
    feed_url: 'https://thedali.org/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{st-petersburg,pinellas}',
    priority_tier: 1,
  },
  {
    name: 'Venice Performing Arts Center — Events',
    url: 'https://veniceperformingartscenter.com/events/',
    feed_url: 'https://veniceperformingartscenter.com/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{venice,nokomis}',
    priority_tier: 1,
  },
  {
    name: 'Yuengling Center — Events',
    url: 'https://www.yuenglingcenter.com/events/',
    feed_url: 'https://www.yuenglingcenter.com/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{tampa,hillsborough}',
    priority_tier: 1,
  },
  {
    name: 'Ruth Eckerd Hall — Events',
    url: 'https://www.rutheckerdhall.com/events',
    feed_url: 'https://www.rutheckerdhall.com/events',
    feed_type: 'scrape',
    coverage_geo: '{clearwater,pinellas}',
    priority_tier: 1,
    scrape_config: JSON.stringify({
      contentSelector: '.eventList.event_list_grid',
      maxHtmlChars: 60000,
      maxEvents: 20,
    }),
  },
  {
    name: 'The Mahaffey Theater — Shows',
    url: 'https://themahaffey.com/shows/',
    feed_url: 'https://themahaffey.com/shows/',
    feed_type: 'scrape',
    coverage_geo: '{st-petersburg,pinellas}',
    priority_tier: 1,
    scrape_config: JSON.stringify({
      contentSelector: '.vc_grid-container',
      maxHtmlChars: 60000,
      maxEvents: 20,
    }),
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('event_sources'))) return;

  await knex('event_sources').insert(NEW_SOURCES).onConflict('feed_url').ignore();
  console.log(
    `[20260927130000] Seeded ${NEW_SOURCES.length} venue event_sources (Benchmark International Arena, The Dalí Museum, Venice Performing Arts Center, Yuengling Center, Ruth Eckerd Hall, The Mahaffey Theater)`
  );
};

// Documented no-op (waves-db seed rollback rule): up() skips feed_urls that
// already exist, so down() cannot tell which rows it inserted, and deleting
// an event_sources row cascades into events_raw history. Disable a source
// by hand (enabled=false) if one of these needs to come out.
exports.down = async function down() {};
