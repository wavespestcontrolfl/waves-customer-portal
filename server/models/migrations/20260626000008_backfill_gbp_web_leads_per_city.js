/**
 * Backfill: re-attribute historical GBP website-form leads from the generic
 * "Google Business Profile" lead_sources row to their per-city "GBP — <city>"
 * row.
 *
 * The dashboard Marketing Attribution panel (/admin/dashboard/leads-by-source)
 * groups leads by lead_sources.name. GBP *calls* land on the per-city
 * "GBP — <city>" rows (matched by the dialed tracking number), and GBP *web*
 * conversions now do too — lead-webhook's determineLeadSource →
 * findGbpLocationByUtmContent → match lead_sources by gbp_location_id. But that
 * per-city match only resolves once gbp_location_id is populated on those rows,
 * so web GBP leads created before that fell through to the generic
 * "Google Business Profile" (website_organic) row. Result: web conversions
 * showed in a separate generic bucket while per-city rows held only calls.
 *
 * New leads already route per-city; this fixes the history so the panel shows
 * GBP web + calls together per city. Mapping is derived from the linked customer
 * (utm_data.source='gbp' confirms GBP web) using the same
 * findGbpLocationByUtmContent the live code uses, so a lead only moves when its
 * city is unambiguous.
 *
 * Idempotent + re-runnable: only considers leads still on the generic row whose
 * customer is GBP web and whose area/content maps to a configured GBP location.
 * Safe no-op when the rows/columns/config aren't present.
 */

const { findGbpLocationByUtmContent } = require('../../config/locations');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;
  if (!(await knex.schema.hasTable('leads'))) return;

  const generic = await knex('lead_sources')
    .where({ name: 'Google Business Profile', source_type: 'website_organic' })
    .first('id');
  if (!generic) return; // nothing to migrate from

  // googleLocationId → per-city "GBP — <city>" lead_sources row
  const cityRows = await knex('lead_sources')
    .where({ source_type: 'gbp' })
    .whereNotNull('gbp_location_id')
    .select('id', 'gbp_location_id', 'name');
  const rowByGoogleId = new Map(cityRows.map((r) => [String(r.gbp_location_id), r]));
  if (rowByGoogleId.size === 0) return; // per-city rows not seeded yet

  // Candidate leads: still on the generic GBP row and linked to a GBP-web customer.
  const candidates = await knex('leads as l')
    .join('customers as c', 'c.id', 'l.customer_id')
    .where('l.lead_source_id', generic.id)
    .whereRaw("lower(c.utm_data->>'source') = 'gbp'")
    .select(
      'l.id as lead_id',
      'c.lead_source_area as area',
      knex.raw("c.utm_data->>'content' as utm_content"),
    );

  let moved = 0;
  const perCity = {};
  for (const lead of candidates) {
    const token = lead.area || lead.utm_content;
    const loc = token ? findGbpLocationByUtmContent(token) : null;
    if (!loc || !loc.googleLocationId) continue; // city not resolvable → leave it
    const dest = rowByGoogleId.get(String(loc.googleLocationId));
    if (!dest) continue;
    await knex('leads').where({ id: lead.lead_id }).update({ lead_source_id: dest.id });
    moved += 1;
    perCity[dest.name] = (perCity[dest.name] || 0) + 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[migration 20260626000008] re-attributed ${moved} GBP web lead(s) to per-city rows: ${JSON.stringify(perCity)}`,
  );
};

exports.down = async function down() {
  // No-op: re-attribution is a more-specific (correct) label within the same GBP
  // channel. Reverting would only re-fragment the dashboard's GBP view.
};
