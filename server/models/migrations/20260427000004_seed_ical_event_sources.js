/**
 * Seed initial iCal event sources (P3b leg 1). The iCal handler in
 * server/services/event-ingestion.js (added in the same PR) calls
 * node-ical.async.fromURL for these and upserts into events_raw.
 *
 * These are the 3 sources I was able to verify return valid iCal
 * (BEGIN:VCALENDAR + at least 1 VEVENT) at the time of writing:
 *
 *   - Mote Marine Laboratory — Tribe Events Calendar ?ical=1.
 *     1 event at probe time but the events page is active; volume
 *     should grow.
 *   - Anna Maria Island Chamber — Tribe Events Calendar ?ical=1.
 *     9 events at probe time; relevant to the Bradenton + AMI
 *     domains and a strong Weekend Lineup feeder.
 *   - Charlotte Performing Arts Center — Tribe Events Calendar
 *     ?ical=1. 9 events at probe time; covers Punta Gorda /
 *     Charlotte County for the Local Spotlight + Weekend Lineup
 *     templates.
 *
 * Other iCal candidates from the source-research doc (CivicPlus
 * county/city calendars, GrowthZone chamber `/events/cal.ics`,
 * LibCal `?cid={id}.ics`) require specific calendar IDs OR did not
 * resolve to a valid iCal payload at probe time — operator can add
 * them via direct DB insert as IDs become known. The handler is
 * source-key agnostic so any new iCal URL just works.
 *
 * Coverage geo follows the same kebab-case convention as the
 * existing RSS sources from migration 20260427000003.
 */

const ICAL_SOURCES = [
  {
    name: 'Mote Marine Laboratory — Events',
    url: 'https://mote.org/events',
    feed_url: 'https://mote.org/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{sarasota,siesta-key}',
    priority_tier: 3,
  },
  {
    name: 'Anna Maria Island Chamber — Island Events',
    url: 'https://annamariaislandchamber.org/island-events/',
    feed_url: 'https://annamariaislandchamber.org/island-events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{anna-maria,bradenton,manatee}',
    priority_tier: 2,
  },
  {
    name: 'Charlotte Performing Arts Center — Events',
    url: 'https://charlottepac.com/events/',
    feed_url: 'https://charlottepac.com/events/?ical=1',
    feed_type: 'ical',
    coverage_geo: '{punta-gorda,port-charlotte}',
    priority_tier: 2,
  },
];

exports.up = async function (knex) {
  await knex('event_sources').insert(ICAL_SOURCES);
  console.log(
    `[20260427000004] Seeded ${ICAL_SOURCES.length} iCal event_sources (Mote Marine, AMI Chamber, Charlotte PAC)`
  );
};

exports.down = async function (knex) {
  // Idempotent rollback — keys on feed_url which is the table's natural
  // unique key. Won't touch unrelated sources an operator may have
  // added later.
  const feedUrls = ICAL_SOURCES.map((s) => s.feed_url);
  await knex('event_sources').whereIn('feed_url', feedUrls).del();
};
