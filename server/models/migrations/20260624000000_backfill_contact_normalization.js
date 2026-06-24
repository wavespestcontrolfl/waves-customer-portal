/**
 * Backfill: normalize EXISTING customer / lead / customer_account contact fields
 * to the canonical stored format that every ingestion path now writes going
 * forward:
 *   - names + city  → proper case ("charles santiago" → "Charles Santiago")
 *   - street        → title-cased, USPS-abbreviated ("123 main street" → "123 Main St")
 *   - email         → lowercased
 *   - phone         → E.164 ("(727) 421-9951" → "+17274219951")
 *   - state         → 2-letter code ("florida" → "FL")
 *   - zip           → 5-digit
 *
 * Uses the same shared helpers as the write paths (server/utils/intake-normalize)
 * so historical rows match new rows exactly.
 *
 * Safety:
 *   - Only rows whose normalized value actually differs are updated; empty/null
 *     values are left untouched (never coerced).
 *   - customers.email / customers.phone carry UNIQUE constraints. If normalizing
 *     a row's phone/email would collide with another row already holding that
 *     value (a pre-existing duplicate), the row is updated WITHOUT that field and
 *     the collision is logged for manual merge — the migration never aborts.
 *   - Re-running is a no-op (values are already canonical), and columns/tables
 *     missing in an environment are skipped.
 */

const {
  normalizeContactName,
  normalizeContactEmail,
  normalizeContactPhone,
  normalizeContactStreet,
  normalizeContactCity,
  normalizeContactStateField,
  normalizeContactZip,
} = require('../../utils/intake-normalize');

// Column -> normalizer. Column names differ between tables (customers use
// address_line1/state; leads use address and have no state), so each table
// gets its own map.
const CUSTOMER_FIELDS = {
  first_name: normalizeContactName,
  last_name: normalizeContactName,
  email: normalizeContactEmail,
  phone: normalizeContactPhone,
  address_line1: normalizeContactStreet,
  address_line2: normalizeContactStreet,
  city: normalizeContactCity,
  state: normalizeContactStateField,
  zip: normalizeContactZip,
};

const LEAD_FIELDS = {
  first_name: normalizeContactName,
  last_name: normalizeContactName,
  email: normalizeContactEmail,
  phone: normalizeContactPhone,
  // NOTE: leads.address holds a FULL address ("123 Main Street, Port Charlotte,
  // FL 33948"), not just a street line. Running street-line normalization on it
  // would corrupt the state casing ("FL" -> "Fl") and leave the suffix
  // un-abbreviated, so the full-address column is intentionally left untouched.
  city: normalizeContactCity,
  zip: normalizeContactZip,
};

const ACCOUNT_FIELDS = {
  first_name: normalizeContactName,
  last_name: normalizeContactName,
  email: normalizeContactEmail,
  phone: normalizeContactPhone,
};

// Dropped first on a UNIQUE-violation retry so the safe formatting still lands.
const UNIQUE_FIELDS = ['email', 'phone'];

function computeChanges(row, fieldMap) {
  const changes = {};
  for (const [col, fn] of Object.entries(fieldMap)) {
    const before = row[col];
    if (before === null || before === undefined) continue; // never invent values
    const after = fn(before);
    if (after !== before) changes[col] = after;
  }
  return changes;
}

async function backfillTable(knex, table, fieldMap, idCol = 'id') {
  if (!(await knex.schema.hasTable(table))) {
    console.log(`[backfill-contact-normalization] ${table}: skipped (table missing)`);
    return;
  }

  // Keep only columns that actually exist in this environment's schema.
  const activeMap = {};
  for (const col of Object.keys(fieldMap)) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn(table, col)) activeMap[col] = fieldMap[col];
  }
  if (!Object.keys(activeMap).length) return;

  const rows = await knex(table).select([idCol, ...Object.keys(activeMap)]);
  let updated = 0;
  let collisions = 0;

  for (const row of rows) {
    const changes = computeChanges(row, activeMap);
    if (!Object.keys(changes).length) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await knex(table).where(idCol, row[idCol]).update(changes);
      updated += 1;
    } catch (err) {
      // Likely a UNIQUE collision on the reformatted email/phone (a pre-existing
      // duplicate). Retry without the unique fields so names/address still get
      // cleaned, and flag the row for manual review.
      const reduced = { ...changes };
      let droppedUnique = false;
      for (const uf of UNIQUE_FIELDS) {
        if (uf in reduced) { delete reduced[uf]; droppedUnique = true; }
      }
      collisions += 1;
      if (droppedUnique && Object.keys(reduced).length) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await knex(table).where(idCol, row[idCol]).update(reduced);
          updated += 1;
        } catch (_err2) {
          // Leave the row entirely untouched if even the reduced update fails.
        }
      }
      console.warn(
        `[backfill-contact-normalization] ${table} id=${row[idCol]} contact collision ` +
        `(${err.code || err.message}); kept original email/phone for manual merge`,
      );
    }
  }

  console.log(`[backfill-contact-normalization] ${table}: updated=${updated} collisions=${collisions}`);
}

// Run OUTSIDE knex's default per-migration transaction. The whole point of the
// catch/retry below is to tolerate a UNIQUE email/phone violation from a
// pre-existing duplicate — but inside a transaction, Postgres aborts the entire
// transaction on the first failed statement, so the retry (and every later row)
// would fail with "current transaction is aborted". With no wrapping
// transaction each UPDATE is autonomous; a violation fails only that statement.
// Safe because the backfill is idempotent and re-runnable, so a mid-run crash
// simply resumes (knex won't mark the migration done) and re-normalizes
// already-clean rows as no-ops.
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await backfillTable(knex, 'customers', CUSTOMER_FIELDS);
  await backfillTable(knex, 'leads', LEAD_FIELDS);
  await backfillTable(knex, 'customer_accounts', ACCOUNT_FIELDS);
};

exports.down = async function down() {
  // Irreversible: original casing/format is not preserved. No-op rollback.
};
