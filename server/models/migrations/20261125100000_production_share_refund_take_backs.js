/**
 * Production share, PR 3a: the owner's answer to a refund on a PAID stop (owner ruling 2026-11-25, "A"). The code never measures a
 * refund. It detects one (production-share-refunds.js refundSignalsOf) and asks; the owner sets how much credit the technician's next
 * share week takes back.
 *   source_check_id  the finalized payroll check whose frozen stop row paid the credit (payroll_checks.id)
 *   visit_id         the visit of that stop row (scheduled_services.id; no foreign key: a deleted visit must not block payroll evidence)
 *   signals          the sorted refund signal ids the answer covers (jsonb array of text). A later signal outside them lists the stop again.
 *   cents            the TOTAL credit to take back for that paid stop, 0 up to the credit the check paid (the service enforces the cap)
 *   note             the owner's words, optional
 *   set_by           the admin who set it
 * One row per (source_check_id, visit_id). The weekly ledger reads it (production-share-refunds.js owedTakeBacks): what a later week
 * already took back is the sum of the takeBacks entries of finalized checks for the same source, and the answer minus that is moved.
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE IF NOT EXISTS production_share_refund_take_backs (
    id bigserial PRIMARY KEY,
    source_check_id uuid NOT NULL REFERENCES payroll_checks(id),
    visit_id uuid NOT NULL,
    signals jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT production_share_refund_take_backs_signals_check CHECK (jsonb_typeof(signals) = 'array'),
    cents integer NOT NULL CONSTRAINT production_share_refund_take_backs_cents_check CHECK (cents >= 0),
    note text NULL,
    set_by uuid NULL REFERENCES technicians(id),
    set_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT production_share_refund_take_backs_source_unique UNIQUE (source_check_id, visit_id)
  )`);
};

exports.down = async function down(knex) {
  // An answer is a pay decision on file: rolling back would lose it without a word. The table lock comes BEFORE the row check and is
  // held through the drop (the migration runs in one transaction), so an answer saved between the check and the drop cannot be lost.
  if (await knex.schema.hasTable('production_share_refund_take_backs')) {
    await knex.raw('LOCK TABLE production_share_refund_take_backs IN ACCESS EXCLUSIVE MODE');
    if (await knex('production_share_refund_take_backs').first('id')) {
      throw new Error('production_share_refund_take_backs holds take-backs the owner set. Roll forward; do not drop it.');
    }
  }
  await knex.raw('DROP TABLE IF EXISTS production_share_refund_take_backs');
};
