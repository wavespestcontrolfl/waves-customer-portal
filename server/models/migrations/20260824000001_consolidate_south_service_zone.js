/**
 * Consolidate the deep-south corridor into the Venice / North Port service
 * zone (south-zone day funnel rollout, PR #3473).
 *
 * The funnel clusters far-south estimate bookings onto existing Venice-zone
 * route days, so "Venice and everything south" must be ONE zone: two rows
 * claiming the same cities makes resolveEstimateZone (unordered .find())
 * nondeterministic. Prod was consolidated by owner-authorized psql on
 * 2026-08-24; this migration carries the same change in code so staging,
 * PR environments, and fresh databases agree — it is idempotent and a
 * no-op where the consolidation has already run.
 *
 *   - Venice / North Port row: gains any of the south cities it doesn't
 *     already carry (Englewood, Port Charlotte, Punta Gorda, Murdock,
 *     Rotonda West, Placida, Boca Grande). Existing entries — including
 *     admin edits — are preserved (read-modify-write, case-insensitive
 *     dedupe).
 *   - Port Charlotte row: loses exactly the cities now owned by the Venice
 *     row (no other admin-added cities are touched). The row itself is
 *     KEPT — its center coords still serve fallbackZoneCenter, and
 *     DEFAULT_FUNNEL_ZONE_SLUGS includes 'port charlotte' so anything
 *     still resolving to it funnels too.
 *
 * down() is a DOCUMENTED NO-OP: a blanket revert would erase exactly the
 * admin edits up() preserves, and prod's consolidation predates this
 * migration — rolling it back must not un-consolidate prod.
 */

const SOUTH_CITIES = [
  'Englewood', 'Port Charlotte', 'Punta Gorda', 'Murdock',
  'Rotonda West', 'Placida', 'Boca Grande',
];

const lc = (v) => String(v || '').trim().toLowerCase();

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_zones'))) return;

  const venice = await knex('service_zones')
    .whereRaw("LOWER(zone_name) LIKE 'venice%'")
    .first('id', 'cities');
  if (venice) {
    const existing = Array.isArray(venice.cities) ? venice.cities : [];
    const have = new Set(existing.map(lc));
    const missing = SOUTH_CITIES.filter((c) => !have.has(lc(c)));
    if (missing.length) {
      await knex('service_zones')
        .where({ id: venice.id })
        .update({ cities: [...existing, ...missing] });
    }
  }

  // Remove only the Venice-owned cities from the legacy Port Charlotte row
  // — anything else an admin added there stays.
  const pc = await knex('service_zones')
    .whereRaw("LOWER(zone_name) = 'port charlotte'")
    .first('id', 'cities');
  if (pc && Array.isArray(pc.cities) && pc.cities.length) {
    const veniceOwned = new Set(SOUTH_CITIES.map(lc));
    const kept = pc.cities.filter((c) => !veniceOwned.has(lc(c)));
    if (kept.length !== pc.cities.length) {
      await knex('service_zones').where({ id: pc.id }).update({ cities: kept });
    }
  }
};

// Documented no-op — see header.
exports.down = async function down() {};
