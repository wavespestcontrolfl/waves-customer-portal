/**
 * Archive the retired pest_rodent_quarterly SERVICES row in every
 * environment. 20260712600000 retired the combined service (flags cleared,
 * completion profile deactivated) but only prod's catalog row was archived
 * (an earlier admin action) — migration-seeded environments kept the row
 * ACTIVE, so the B0 completion-lane contract test sees an active service
 * with an inactive profile and fails CI (main red at 3bc8ba3902).
 *
 * Self-healed: absent → skip; already archived (prod) → no-op; else
 * archive with a marker for exact rollback.
 */

const KEY = 'pest_rodent_quarterly';
const MARKER_RE = / ?\[pest_rodent_catalog_archive=[^\]]*\]/;

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[pest_rodent_catalog_archive=${action}]`;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: KEY }).first();
  if (!row) {
    console.warn(`[prq-archive] services.${KEY} ABSENT — skipping`);
    return;
  }
  if (row.is_active === false && row.is_archived === true) {
    console.log(`[prq-archive] services.${KEY} already archived — no-op`);
    return;
  }
  await knex('services')
    .where({ service_key: KEY })
    .update({
      is_active: false,
      is_archived: true,
      internal_notes: withMarker(row.internal_notes, `updated:${row.is_active ? 'a' : '-'}${row.is_archived ? 'r' : '-'}`),
      updated_at: knex.fn.now(),
    });
  console.log(`[prq-archive] services.${KEY}: archived (prior recorded)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services').where({ service_key: KEY }).first();
  const match = String(row?.internal_notes || '').match(/\[pest_rodent_catalog_archive=updated:(.)(.)\]/);
  if (!match) return;
  await knex('services')
    .where({ service_key: KEY })
    .update({
      is_active: match[1] === 'a',
      is_archived: match[2] === 'r',
      internal_notes: String(row.internal_notes || '').replace(MARKER_RE, '').trim() || null,
      updated_at: knex.fn.now(),
    });
  console.log(`[prq-archive:down] services.${KEY} restored`);
};
