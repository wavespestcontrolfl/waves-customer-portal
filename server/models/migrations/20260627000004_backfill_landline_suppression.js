/**
 * Backfill: promote already-known landlines into the SMS suppression list.
 *
 * PR #2160 made landline learning reactive — a Twilio 30006 ("landline or
 * unreachable carrier") delivery bounce now writes a `non_mobile` row to
 * messaging_suppression so EVERY SMS path skips that number. But that only fires
 * on the NEXT bounce. The appointment-reminder path has been caching known
 * landlines in `customers.line_type='landline'` for a while (Twilio Lookup +
 * prior 30006 bounces), and those numbers are still being texted by every
 * non-appointment path (invoice dunning, review requests, …) until they happen
 * to re-bounce.
 *
 * This one-time pass promotes each `customers.line_type='landline'` primary
 * phone into a `non_mobile` suppression row so they're protected immediately,
 * not on a future bounce.
 *
 * Safety:
 *  - Phone is normalized to the SAME E.164 form the send path keys suppression
 *    on (send_customer_message → loadSuppressionState matches on the normalized
 *    recipient), so the rows actually take effect.
 *  - onConflict(phone).ignore() — NEVER clobbers a stronger existing record
 *    (opt_out / wrong_number / manual_dnc / an already-present non_mobile row).
 *  - Idempotent / re-runnable. down() removes only the rows this backfill added.
 */

const SOURCE = 'backfill_line_type_landline';

// Mirror send_customer_message's normalizeRecipient so the suppression key lines
// up with what the send path queries. Returns null (skip) for anything that
// isn't a plausible E.164 — a backfill should never write a junk key.
function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  let e164;
  if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else if (trimmed.startsWith('+')) e164 = `+${digits}`;
  else return null;
  return /^\+\d{7,15}$/.test(e164) ? e164 : null;
}

// Pure transform: customer rows -> deduped suppression insert rows. created_at
// is left to the column default. Exported for unit testing.
function buildSuppressionRows(customerRows) {
  const seen = new Set();
  const rows = [];
  for (const c of customerRows || []) {
    const phone = normalizeE164(c.phone);
    if (!phone || phone.length > 32) continue;     // unparseable or too long for the PK column
    if (seen.has(phone)) continue;                  // multi-property customers share a phone
    seen.add(phone);
    rows.push({ phone, reason: 'non_mobile', source: SOURCE, active: true });
  }
  return rows;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('messaging_suppression'))) return;
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'line_type'))) return;

  const customerRows = await knex('customers')
    .whereRaw('LOWER(line_type) = ?', ['landline'])
    .whereNull('deleted_at')
    .whereNotNull('phone')
    .select('id', 'phone');

  const rows = buildSuppressionRows(customerRows);
  if (!rows.length) {
    // eslint-disable-next-line no-console
    console.log(`[backfill] landline suppression: ${customerRows.length} landline customer(s), 0 insertable phone(s).`);
    return;
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const result = await knex('messaging_suppression')
      .insert(chunk)
      .onConflict('phone')
      .ignore();
    inserted += Array.isArray(result) ? result.length : (result && result.rowCount) || 0;
  }
  // eslint-disable-next-line no-console
  console.log(`[backfill] landline suppression: ${customerRows.length} landline customer(s), ${rows.length} unique phone(s), ${inserted} new suppression row(s).`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('messaging_suppression'))) return;
  // Remove only rows this backfill created; leave organic suppressions intact.
  await knex('messaging_suppression').where({ source: SOURCE, reason: 'non_mobile' }).del();
};

exports._internals = { normalizeE164, buildSuppressionRows, SOURCE };
