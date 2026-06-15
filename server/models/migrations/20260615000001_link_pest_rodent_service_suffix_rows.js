/**
 * Link legacy-imported "Pest & Rodent Control Service" rows to the combined
 * catalog entry created by 20260612000031_combined_service_cutover.
 *
 * That cutover matched "Pest & Rodent Control" / "Pest and Rodent Control".
 * The June 2026 rebooking import created the real prod rows with the
 * trailing "Service" suffix, so reminders displayed the combined label while
 * completion-profile resolution stayed generic because service_id remained
 * null.
 */

const MARKER_RE = / ?\[combined_suffix_link_action=[^\]]*\]/;
const MATCHES = ['pest & rodent control service', 'pest and rodent control service'];

function withMarker(notes, action) {
  const base = String(notes || '').replace(MARKER_RE, '').trim();
  return `${base}${base ? ' ' : ''}[combined_suffix_link_action=${action}]`;
}

exports.up = async function up(knex) {
  const combined = await knex('services')
    .where({ service_key: 'pest_rodent_quarterly' })
    .first('id');
  if (!combined) {
    console.warn('[combined-suffix-link] pest_rodent_quarterly catalog row missing — skipping');
    return;
  }

  const rows = await knex('scheduled_services')
    .whereRaw('lower(btrim(service_type)) in (?, ?)', MATCHES)
    .whereNull('service_id')
    .select('id', 'customer_id', 'internal_notes');
  if (!rows.length) {
    console.log('[combined-suffix-link] no suffix-labeled rows needing a link');
    return;
  }

  const customers = new Set(rows.map((row) => row.customer_id).filter(Boolean));
  for (const row of rows) {
    await knex('scheduled_services')
      .where({ id: row.id })
      .update({
        service_id: combined.id,
        internal_notes: withMarker(row.internal_notes, 'linked:-'),
        updated_at: knex.fn.now(),
      });
  }

  console.log(`[combined-suffix-link] linked ${rows.length} row(s) across ${customers.size} customer(s) to pest_rodent_quarterly`);
};

exports.down = async function down(knex) {
  const marked = await knex('scheduled_services')
    .where('internal_notes', 'like', '%[combined_suffix_link_action=linked:%')
    .select('id', 'internal_notes');

  for (const row of marked) {
    const match = String(row.internal_notes || '').match(/\[combined_suffix_link_action=linked:([^\]]*)\]/);
    if (!match) continue;
    const prior = match[1] === '-' ? null : match[1];
    await knex('scheduled_services')
      .where({ id: row.id })
      .update({
        service_id: prior,
        internal_notes: String(row.internal_notes || '').replace(MARKER_RE, '').trim() || null,
        updated_at: knex.fn.now(),
      });
  }

  if (marked.length) console.log(`[combined-suffix-link:down] restored ${marked.length} row(s)`);
};
