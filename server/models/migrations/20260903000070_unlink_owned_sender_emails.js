/**
 * Unlink emails sent FROM one of our own addresses from the customer record
 * they were matched to (companion to the email-sync owned-sender guard).
 *
 * upsertEmail matched every sender against customers.email. One customer
 * record carries contact@wavespestcontrol.com on file, so every message
 * this mailbox sent to itself (backup-drill failures, digests, control
 * messages) and every outbound copy Gmail lists was stored as that
 * customer's email — prod 2026-09-03 read-only sizing: 2,319 rows since
 * 2025-06 (1,711 un-archived, 55 with an unsettled bell claim) on one
 * customer, and the "email from a customer" bell rang three times for the
 * day's self-alerts. The guard stops new rows; this migration repairs the
 * stored ones.
 *
 * Rule: a row carrying a customer_id whose from_address is an owned address
 * — the same isInternalEmailRecipient predicate the guard and the internal
 * digests use (default owned list + the whole internal domain + the env
 * allowlists), so the migration and the guard can never disagree on what
 * "ours" means — gets customer_id NULL. Nothing else changes: bell claims
 * and settlements, archive state and classification stay as they are (a
 * NULL customer_id already removes the row from the bell sweep, which keys
 * on customer_id). Bells already rung (notifications) are left for the
 * owner to dismiss.
 *
 * Ownership is recorded in a system_settings state row so down() restores
 * exactly what up() cleared, value-guarded (a row an admin has since linked
 * to someone is left as the admin left it). Idempotent: a second up() with
 * the state row present is a no-op.
 */
const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');

const STATE_KEY = 'migration.20260903000070.state';
const CHUNK = 500;

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  await knex('system_settings').where({ key: STATE_KEY }).del();
  await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (!(await knex.schema.hasColumn('emails', 'customer_id'))) return;
  if (await loadState(knex)) return; // already applied

  // Linked rows are few (prod: 2,707 of 35k) — read them all and let the
  // shared predicate decide.
  const linked = await knex('emails').whereNotNull('customer_id').select('id', 'customer_id', 'from_address');
  const byCustomer = new Map();
  for (const row of linked) {
    if (!isInternalEmailRecipient(row.from_address)) continue;
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, []);
    byCustomer.get(row.customer_id).push(row.id);
  }

  const state = { unlinked: {} };
  for (const [customerId, ids] of byCustomer) {
    const cleared = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      // CAS: only rows still carrying the customer we observed; RETURNING
      // records exactly what this write changed.
      const ret = await knex('emails')
        .whereIn('id', ids.slice(i, i + CHUNK))
        .where({ customer_id: customerId })
        .update({ customer_id: null }, ['id']);
      for (const r of ret || []) cleared.push(r && typeof r === 'object' ? r.id : r);
    }
    if (cleared.length) state.unlinked[customerId] = cleared;
  }

  await saveState(knex, state);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  const state = await loadState(knex);
  if (!state) return; // nothing owned → restore nothing

  for (const [customerId, ids] of Object.entries(state.unlinked || {})) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      // Restore ONLY rows still unlinked — a link an admin made since stands.
      await knex('emails')
        .whereIn('id', ids.slice(i, i + CHUNK))
        .whereNull('customer_id')
        .update({ customer_id: customerId });
    }
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
};

exports.STATE_KEY = STATE_KEY;
