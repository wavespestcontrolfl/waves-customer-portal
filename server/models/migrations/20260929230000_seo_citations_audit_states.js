/**
 * Directory-listing (citation) auditor — real status vocabulary.
 *
 * seo_citations.status was a free string (20260401000045) with the comment
 * "active, missing, inconsistent, claimed, unchecked" and no CHECK. The audit
 * never wrote anything but 'unchecked'. The auditor now classifies each
 * listing into exactly five states (services/seo/citation-auditor.js):
 *
 *   unverified     no listing URL recorded, or never checked
 *   verified       fetched; name + phone (+ address when shown) match
 *   mismatched     fetched; a field differs (recorded in status_detail)
 *   fetch-blocked  could not read the page (403/429/5xx, captcha, timeout,
 *                  empty/JS-only body, no NAP in the text). NEVER "missing".
 *   missing        a human recorded "no listing exists". Never set by a fetch.
 *
 * Old value mapping (frozen):
 *   unchecked        -> unverified
 *   inconsistent     -> mismatched
 *   active, claimed  -> unverified   (nothing ever verified these against the
 *                                     directory; the audit re-verifies them)
 *   missing          -> missing      (only a human could set it)
 *   anything else    -> unverified
 * `inconsistent` -> `mismatched` keeps a flag a human raised; status_detail
 * stays NULL for it because no field was ever recorded.
 *
 * Also adds:
 *   location_id    which Google Business Profile location (config/locations.js
 *                  id) this listing should match. NULL = the brand listing,
 *                  compared against the default office NAP. The four seeded
 *                  "Google Business Profile — X" rows are backfilled.
 *   status_detail  jsonb: why the last check landed where it did (reason,
 *                  http status, mismatched fields with the value seen).
 *
 * The location ids are a frozen copy of config/locations.js WAVES_LOCATIONS[].id
 * (stable cross-system keys); the migration requires no service module.
 */

const STATES = ['unverified', 'verified', 'mismatched', 'fetch-blocked', 'missing'];
const CHECK = 'seo_citations_status_check';

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE seo_citations ADD COLUMN IF NOT EXISTS location_id VARCHAR(40)');
  await knex.raw('ALTER TABLE seo_citations ADD COLUMN IF NOT EXISTS status_detail JSONB');

  await knex.raw(`UPDATE seo_citations SET status = 'mismatched' WHERE status = 'inconsistent'`);
  await knex.raw(`UPDATE seo_citations SET status = 'unverified' WHERE status IS NULL OR status NOT IN ('mismatched', 'missing')`);
  await knex.raw(`ALTER TABLE seo_citations ALTER COLUMN status SET DEFAULT 'unverified'`);
  await knex.raw(`ALTER TABLE seo_citations ALTER COLUMN status SET NOT NULL`);

  await knex.raw(`UPDATE seo_citations SET location_id = 'bradenton' WHERE location_id IS NULL AND directory_name ILIKE 'Google Business Profile%LWR'`);
  await knex.raw(`UPDATE seo_citations SET location_id = 'parrish' WHERE location_id IS NULL AND directory_name ILIKE 'Google Business Profile%Parrish'`);
  await knex.raw(`UPDATE seo_citations SET location_id = 'sarasota' WHERE location_id IS NULL AND directory_name ILIKE 'Google Business Profile%Sarasota'`);
  await knex.raw(`UPDATE seo_citations SET location_id = 'venice' WHERE location_id IS NULL AND directory_name ILIKE 'Google Business Profile%Venice'`);

  await knex.raw(`ALTER TABLE seo_citations DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE seo_citations ADD CONSTRAINT ${CHECK} CHECK (status IN (${STATES.map((s) => `'${s}'`).join(', ')}))`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE seo_citations DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`UPDATE seo_citations SET status = 'inconsistent' WHERE status = 'mismatched'`);
  await knex.raw(`UPDATE seo_citations SET status = 'active' WHERE status = 'verified'`);
  await knex.raw(`UPDATE seo_citations SET status = 'unchecked' WHERE status IN ('unverified', 'fetch-blocked')`);
  await knex.raw(`ALTER TABLE seo_citations ALTER COLUMN status DROP NOT NULL`);
  await knex.raw(`ALTER TABLE seo_citations ALTER COLUMN status SET DEFAULT 'unchecked'`);
  await knex.raw('ALTER TABLE seo_citations DROP COLUMN IF EXISTS status_detail');
  await knex.raw('ALTER TABLE seo_citations DROP COLUMN IF EXISTS location_id');
};
