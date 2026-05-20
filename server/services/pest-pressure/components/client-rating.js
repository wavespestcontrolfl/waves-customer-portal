/**
 * Client-reported activity rating extractor.
 *
 * Reads service_records.client_pest_rating (0–5, nullable) added in the
 * 20260520000001_pest_pressure_configs migration. Source distinguishes a
 * self-reported value from a value entered on-behalf by the technician.
 *
 * Returns { value, present, source } or { value: null, present: false }
 * when no rating has been captured for this service.
 */

const ALLOWED_SOURCES = new Set(['customer', 'technician']);

async function extractClientRating({ knex, serviceRecordId }) {
  if (!knex || !serviceRecordId) {
    throw new TypeError('extractClientRating: knex and serviceRecordId are required');
  }
  const row = await knex('service_records')
    .where({ id: serviceRecordId })
    .first('client_pest_rating', 'client_pest_rating_source', 'client_pest_rating_at');

  if (!row || row.client_pest_rating === null || row.client_pest_rating === undefined) {
    return { value: null, present: false, source: null };
  }

  const value = Number(row.client_pest_rating);
  if (!Number.isFinite(value) || value < 0 || value > 5) {
    return { value: null, present: false, source: null };
  }

  const source = ALLOWED_SOURCES.has(row.client_pest_rating_source) ? row.client_pest_rating_source : 'customer';

  return {
    value,
    present: true,
    source,
    capturedAt: row.client_pest_rating_at || null,
  };
}

module.exports = { extractClientRating };
