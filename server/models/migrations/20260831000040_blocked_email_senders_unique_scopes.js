/**
 * Unique block scopes for blocked_email_senders (pre-push r18 P1 on #3648).
 *
 * Two concurrent manualBlockSender calls (or an auto-block racing a manual
 * one) could both miss the existing-row check and insert duplicate rows for
 * the same sender/domain — unblocking one then deletes one Gmail filter and
 * leaves the sender still blocked by the other. The application-level
 * dedupe (r12) closes the common path; these partial unique indexes make
 * the race lose at the database, and the writers treat the unique violation
 * as "already blocked" (rolling back their fresh Gmail filter).
 *
 * Dedupe-first: keeps ONE row per scope — preferring a row that has a
 * recorded Gmail filter, then the earliest created_at, then the smaller id.
 * A losing duplicate that carries its OWN gmail_filter_id would leave that
 * filter active in Gmail but unreachable by every unblock path (pre-push
 * r19 P1) — a migration cannot call the Gmail API, so every losing filter
 * id is preserved in the blocked_email_senders_dedupe_orphans ledger BEFORE
 * the row is deleted; an ops sweep (ops/agents pattern, dry-run first)
 * deletes those filters via the Gmail API and stamps cleaned_at.
 */

const RANKED = (scopeWhere) => `
  SELECT id, email_address, domain, gmail_filter_id FROM (
    SELECT id, email_address, domain, gmail_filter_id, ROW_NUMBER() OVER (
      PARTITION BY ${scopeWhere.partition}
      ORDER BY (gmail_filter_id IS NOT NULL) DESC, created_at ASC, id ASC
    ) AS rn
    FROM blocked_email_senders
    WHERE ${scopeWhere.where}
  ) ranked WHERE ranked.rn > 1
`;

const SCOPES = [
  { partition: 'lower(email_address)', where: 'email_address IS NOT NULL' },
  // Pure domain blocks only — address rows store domain NULL by contract.
  { partition: 'lower(domain)', where: 'domain IS NOT NULL AND email_address IS NULL' },
];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('blocked_email_senders');
  if (!hasTable) return;

  const hasLedger = await knex.schema.hasTable('blocked_email_senders_dedupe_orphans');
  if (!hasLedger) {
    await knex.schema.createTable('blocked_email_senders_dedupe_orphans', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('email_address');
      t.text('domain');
      t.text('gmail_filter_id').notNullable();
      t.text('source_row_id');
      t.timestamp('recorded_at', { useTz: true }).defaultTo(knex.fn.now());
      t.timestamp('cleaned_at', { useTz: true });
    });
  }

  for (const scope of SCOPES) {
    await knex.raw(`
      WITH losers AS (${RANKED(scope)}),
      preserved AS (
        INSERT INTO blocked_email_senders_dedupe_orphans (email_address, domain, gmail_filter_id, source_row_id)
        SELECT email_address, domain, gmail_filter_id, id::text FROM losers WHERE gmail_filter_id IS NOT NULL
      )
      DELETE FROM blocked_email_senders WHERE id IN (SELECT id FROM losers)
    `);
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS blocked_email_senders_email_scope_unique
    ON blocked_email_senders (lower(email_address))
    WHERE email_address IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS blocked_email_senders_domain_scope_unique
    ON blocked_email_senders (lower(domain))
    WHERE domain IS NOT NULL AND email_address IS NULL
  `);
};

// The dedupe is a deliberate NO-OP on rollback (deleted duplicate rows are
// junk this migration exists to remove), and the orphan ledger is RETAINED
// (it records Gmail filters that still need API cleanup — dropping it would
// lose the only pointer to them). Only the indexes are reverted.
exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('blocked_email_senders');
  if (!hasTable) return;
  await knex.raw('DROP INDEX IF EXISTS blocked_email_senders_email_scope_unique');
  await knex.raw('DROP INDEX IF EXISTS blocked_email_senders_domain_scope_unique');
};
