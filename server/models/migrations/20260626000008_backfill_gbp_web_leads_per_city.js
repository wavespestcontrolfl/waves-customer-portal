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
 * GBP web + calls together per city.
 *
 * GBP detection + city resolution prefer each LEAD's OWN recorded attribution
 * (leads.extracted_data.attribution: leadSource + raw utm) and fall back to the
 * linked customer's first-touch utm_data — because:
 *   - lead-webhook only writes the attribution block onto a lead's extracted_data
 *     on newer submissions (server/routes/lead-webhook.js:577-600); historical
 *     leads (the ones this backfill targets) predate it and carry no lead-level
 *     attribution, so the customer's utm_data — set from that same GBP submission
 *     at customer creation — is the only and correct signal for them.
 *   - lead-webhook never overwrites customers.utm_data on a later submission from
 *     an *existing* customer (server/routes/lead-webhook.js:219-232). So where a
 *     lead DOES carry its own attribution, that is preferred (and takes priority
 *     for the city) over the customer's possibly-stale first touch — which is the
 *     case a customer-only filter would misattribute.
 *   - GBP is matched the same way the live path does, via the shared
 *     isGbpUtmCampaign predicate: utm_source=gbp OR the legacy
 *     utm_source=google & medium=organic & campaign=gbp shape
 *     (server/config/locations.js:132), plus leadSource.source='google_business'
 *     which determineLeadSource sets exactly on a GBP campaign
 *     (server/routes/lead-webhook.js:1060) — so legacy-campaign leads aren't left
 *     behind. City is resolved via the same findGbpLocationByUtmContent the live
 *     code uses, so a lead only moves when its city is unambiguous; otherwise it
 *     is left on the generic row (matching the live "GBP unattributed" fallback).
 *
 * Idempotent + re-runnable: only touches leads still on the generic row. Safe
 * no-op when the rows/columns/config aren't present.
 */

const { findGbpLocationByUtmContent, isGbpUtmCampaign } = require('../../config/locations');

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

  // Every lead still on the generic GBP bucket, with both the lead's own recorded
  // attribution (preferred) and the linked customer's first-touch attribution
  // (fallback for historical leads whose extracted_data predates the block).
  const candidates = await knex('leads as l')
    .leftJoin('customers as c', 'c.id', 'l.customer_id')
    .where('l.lead_source_id', generic.id)
    .select(
      'l.id as lead_id',
      // lead-level (preferred)
      knex.raw("l.extracted_data->'attribution'->'leadSource'->>'source' as ls_source"),
      knex.raw("l.extracted_data->'attribution'->'leadSource'->>'area' as ls_area"),
      knex.raw("l.extracted_data->'attribution'->'utm'->>'source' as l_utm_source"),
      knex.raw("l.extracted_data->'attribution'->'utm'->>'medium' as l_utm_medium"),
      knex.raw("l.extracted_data->'attribution'->'utm'->>'campaign' as l_utm_campaign"),
      knex.raw("l.extracted_data->'attribution'->'utm'->>'content' as l_utm_content"),
      // customer-level (fallback)
      knex.raw("c.utm_data->>'source' as c_utm_source"),
      knex.raw("c.utm_data->>'medium' as c_utm_medium"),
      knex.raw("c.utm_data->>'campaign' as c_utm_campaign"),
      knex.raw("c.utm_data->>'content' as c_utm_content"),
      'c.lead_source_area as c_area',
    );

  let moved = 0;
  let unmapped = 0;
  let notGbp = 0;
  const perCity = {};
  for (const lead of candidates) {
    // Confirm GBP from the lead's OWN attribution first, then the customer's,
    // using the shared predicate (covers utm_source=gbp AND the legacy
    // google/organic/gbp campaign shape).
    const leadGbp = lead.ls_source === 'google_business'
      || isGbpUtmCampaign({ source: lead.l_utm_source, medium: lead.l_utm_medium, campaign: lead.l_utm_campaign });
    const custGbp = isGbpUtmCampaign({ source: lead.c_utm_source, medium: lead.c_utm_medium, campaign: lead.c_utm_campaign });
    if (!leadGbp && !custGbp) { notGbp += 1; continue; } // not a GBP web lead → leave it

    // Resolve the city from the lead's own attribution first (resolved GBP
    // location id, then raw utm_content), then the customer's first-touch tokens.
    const token = lead.ls_area || lead.l_utm_content || lead.c_area || lead.c_utm_content;
    const loc = token ? findGbpLocationByUtmContent(token) : null;
    if (!loc || !loc.googleLocationId) { unmapped += 1; continue; } // city not resolvable → leave it
    const dest = rowByGoogleId.get(String(loc.googleLocationId));
    if (!dest) { unmapped += 1; continue; }
    await knex('leads').where({ id: lead.lead_id }).update({ lead_source_id: dest.id });
    moved += 1;
    perCity[dest.name] = (perCity[dest.name] || 0) + 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[migration 20260626000008] re-attributed ${moved} GBP web lead(s) to per-city rows `
      + `(${unmapped} left: city unresolved, ${notGbp} left: not GBP): ${JSON.stringify(perCity)}`,
  );
};

exports.down = async function down() {
  // No-op: re-attribution is a more-specific (correct) label within the same GBP
  // channel. Reverting would only re-fragment the dashboard's GBP view.
};
