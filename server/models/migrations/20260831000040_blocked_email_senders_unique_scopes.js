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
 * Deleted duplicates whose own gmail_filter_id differed leave that filter
 * orphaned in Gmail (a migration cannot call the Gmail API); the losing
 * filters were already invisible to unblock flows, so this changes nothing
 * about their reachability.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('blocked_email_senders');
  if (!hasTable) return;

  // Address scope: one row per lower(email_address).
  await knex.raw(`
    DELETE FROM blocked_email_senders WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY lower(email_address)
          ORDER BY (gmail_filter_id IS NOT NULL) DESC, created_at ASC, id ASC
        ) AS rn
        FROM blocked_email_senders
        WHERE email_address IS NOT NULL
      ) ranked WHERE ranked.rn > 1
    )
  `);
  // Domain scope: one row per lower(domain) among pure domain blocks
  // (email_address IS NULL — address rows store domain NULL by contract).
  await knex.raw(`
    DELETE FROM blocked_email_senders WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY lower(domain)
          ORDER BY (gmail_filter_id IS NOT NULL) DESC, created_at ASC, id ASC
        ) AS rn
        FROM blocked_email_senders
        WHERE domain IS NOT NULL AND email_address IS NULL
      ) ranked WHERE ranked.rn > 1
    )
  `);

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
// junk this migration exists to remove); only the indexes are reverted.
exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('blocked_email_senders');
  if (!hasTable) return;
  await knex.raw('DROP INDEX IF EXISTS blocked_email_senders_email_scope_unique');
  await knex.raw('DROP INDEX IF EXISTS blocked_email_senders_domain_scope_unique');
};
