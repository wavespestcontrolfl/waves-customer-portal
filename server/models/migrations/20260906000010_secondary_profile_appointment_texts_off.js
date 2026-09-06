// One-time backfill: every existing SECONDARY profile (an additional
// property / rental on an account — customers.is_primary_profile is not
// true and account_id is set) gets its five appointment texts switched OFF.
//
// Owner ruling 2026-09-06: "all rental texts should be off, only primary for
// now." Going forward createDefaultCustomerRows seeds a secondary profile's
// row this way (server/services/customer-default-rows.js); this migration
// brings the rows minted before that rule into line. appointment_notify_primary
// is deliberately NOT touched (owner ruling 2026-07-24: the account holder
// stays a recipient when a property's texts are on).
//
// Fires ZERO customer communications: pure SQL against notification_prefs.
//
// Reversible the same way 20260725000002 is: `up` records the exact
// customer_ids and the per-row prior values in audit_log, and `down` restores
// only those rows that nobody has touched since (updated_at is NOT restamped
// by `up` — it doubles as the marketing-SMS consent capturedAt, and an
// untouched row keeps its original stamp as the "unchanged since our write"
// marker).
const AUDIT_ACTION = 'migration.secondary_profile_appointment_texts_off';
const AUDIT_ROLLBACK_ACTION = 'migration.secondary_profile_appointment_texts_off_rolled_back';
const COLUMNS = ['appointment_confirmation', 'service_reminder_72h', 'service_reminder_24h', 'tech_en_route', 'tech_arrived'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs')) || !(await knex.schema.hasTable('customers'))) return;
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn('notification_prefs', col))) return;
  }

  // NULL-safe: the recipient/reminder classifiers treat every value other than
  // true as secondary, so a NULL flag on an account-linked row is a rental too.
  const secondaries = await knex('customers')
    .where(function notPrimary() { this.whereNull('is_primary_profile').orWhere('is_primary_profile', false); })
    .whereNotNull('account_id')
    .whereNull('deleted_at')
    .pluck('id');
  if (!secondaries.length) {
    console.log('[20260906000010] no secondary profiles — nothing to backfill');
    return;
  }

  await knex.transaction(async (trx) => {
    // Snapshot BEFORE writing so `down` can restore each row's real prior
    // values (a rental the owner had already tuned by hand must come back
    // exactly, not as all-true).
    const before = await trx('notification_prefs')
      .whereIn('customer_id', secondaries)
      .where(function anyTextStillOn() {
        for (const col of COLUMNS) this.orWhereNot(col, false).orWhereNull(col);
      })
      .select('customer_id', ...COLUMNS)
      // Lock the rows we snapshot so a concurrent preference save cannot land
      // between the SELECT and the UPDATE and be overwritten with a stale
      // audit record (codex P2).
      .forUpdate();
    if (!before.length) {
      console.log('[20260906000010] every secondary profile already had its appointment texts off');
      return;
    }
    // Stamp AFTER the locked snapshot: a preference save that held a row lock
    // when the migration started commits before our SELECT returns, and its
    // updated_at must read as "before the flip" so `down` still restores the
    // row (codex r2 P2).
    const flippedAt = new Date();
    const ids = before.map((r) => r.customer_id);
    const off = Object.fromEntries(COLUMNS.map((c) => [c, false]));
    await trx('notification_prefs').whereIn('customer_id', ids).update(off);

    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ACTION,
      resource_type: 'notification_prefs',
      critical: true,
      trx,
      metadata: {
        reason: 'owner ruling 2026-09-06: secondary-property appointment texts default off',
        updated_count: ids.length,
        flipped_at: flippedAt.toISOString(),
        customer_ids: ids,
        prior_values: before,
      },
    });
    console.log(`[20260906000010] switched appointment texts off for ${ids.length} secondary profile(s)`);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs')) || !(await knex.schema.hasTable('audit_log'))) return;
  const record = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first('id', 'metadata');
  if (!record) {
    console.log('[20260906000010] no audit record — nothing to revert');
    return;
  }
  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
  const prior = Array.isArray(meta.prior_values) ? meta.prior_values : [];
  if (!prior.length) return;

  await knex.transaction(async (trx) => {
    let reverted = 0;
    for (const row of prior) {
      const query = trx('notification_prefs').where({ customer_id: row.customer_id });
      if (meta.flipped_at) {
        query.where(function untouchedSinceBackfill() {
          this.whereNull('updated_at').orWhere('updated_at', '<=', new Date(meta.flipped_at));
        });
      }
      const values = Object.fromEntries(COLUMNS.map((c) => [c, row[c] === undefined ? null : row[c]]));
      reverted += await query.update(values);
    }
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ROLLBACK_ACTION,
      resource_type: 'notification_prefs',
      critical: true,
      trx,
      metadata: { reverted_count: reverted, from_audit_id: record.id },
    });
    console.log(`[20260906000010] reverted ${reverted} row(s)`);
  });
};
