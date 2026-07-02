'use strict';

/**
 * Estimate follow-up cadence collapse: 5 stages → 3 touches, booleans → timestamps.
 *
 * The old ladder (24h unviewed / 48h viewed / 5d final / 1-3d expiring) sent five
 * flavors of "just checking in". The new ladder is three touches while the quote
 * is live: a questions opener (48-72h after send, viewed/not-viewed copy variants),
 * a day-5 check-in (the slot the offer engine's First-Year Protection Credit will
 * occupy — hence `followup_credit_sent_at`), and a last-day notice (expiry −1d).
 *
 * Timestamps instead of booleans so acceptances can be attributed to touches
 * ("accepted within 48h of the day-5 touch") — impossible retroactively with
 * flags. The deposit-abandoned stage keeps its own cadence but converts to a
 * timestamp too so every stage claim works the same way.
 *
 * Backfill maps old flags onto the new columns so in-flight estimates don't get
 * re-touched through the transition: an estimate that already got the unviewed
 * OR viewed nudge is treated as having had its questions touch, final → day-5,
 * expiring → expiring.
 */

const NEW_COLUMNS = [
  'followup_questions_sent_at',
  'followup_credit_sent_at',
  'followup_expiring_sent_at',
  'followup_deposit_abandoned_sent_at',
];

const BACKFILLS = [
  { from: ['followup_unviewed_sent', 'followup_viewed_sent'], to: 'followup_questions_sent_at' },
  { from: ['followup_final_sent'], to: 'followup_credit_sent_at' },
  { from: ['followup_expiring_sent'], to: 'followup_expiring_sent_at' },
  { from: ['followup_deposit_abandoned_sent'], to: 'followup_deposit_abandoned_sent_at' },
];

const OLD_COLUMNS = [
  'followup_unviewed_sent',
  'followup_viewed_sent',
  'followup_final_sent',
  'followup_expiring_sent',
  'followup_deposit_abandoned_sent',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;

  const toAdd = [];
  for (const col of NEW_COLUMNS) {
    if (!(await knex.schema.hasColumn('estimates', col))) toAdd.push(col);
  }
  if (toAdd.length) {
    await knex.schema.alterTable('estimates', (t) => {
      for (const col of toAdd) t.timestamp(col).nullable();
    });
  }

  for (const { from, to } of BACKFILLS) {
    const present = [];
    for (const col of from) {
      if (await knex.schema.hasColumn('estimates', col)) present.push(col);
    }
    if (!present.length) continue;
    // The exact old send time per stage wasn't recorded (that's the point of
    // this migration) — last_follow_up_at is the closest honest approximation.
    await knex('estimates')
      .where(function () {
        for (const col of present) this.orWhere(col, true);
      })
      .whereNull(to)
      .update({ [to]: knex.raw('COALESCE(last_follow_up_at, CURRENT_TIMESTAMP)') });
  }

  for (const col of OLD_COLUMNS) {
    if (await knex.schema.hasColumn('estimates', col)) {
      await knex.schema.alterTable('estimates', (t) => t.dropColumn(col));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimates'))) return;

  for (const col of OLD_COLUMNS) {
    if (!(await knex.schema.hasColumn('estimates', col))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.boolean(col).defaultTo(false);
      });
    }
  }

  // Reverse the backfill mapping: any new-column timestamp marks every old
  // flag it was derived from (questions → both unviewed and viewed; lossy in
  // that direction, but down() only needs the old cron to not re-send).
  for (const { from, to } of BACKFILLS) {
    if (!(await knex.schema.hasColumn('estimates', to))) continue;
    const updates = {};
    for (const col of from) updates[col] = true;
    await knex('estimates').whereNotNull(to).update(updates);
  }

  for (const col of NEW_COLUMNS) {
    if (await knex.schema.hasColumn('estimates', col)) {
      await knex.schema.alterTable('estimates', (t) => t.dropColumn(col));
    }
  }
};

exports.NEW_COLUMNS = NEW_COLUMNS;
exports.OLD_COLUMNS = OLD_COLUMNS;
exports.BACKFILLS = BACKFILLS;
