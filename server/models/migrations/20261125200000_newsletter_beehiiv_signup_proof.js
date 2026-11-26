/**
 * Record the old Beehiiv sign-ups as the readers' own opt-in proof (owner ruling
 * 2026-11-25, "YES THEY DID": every reader of the old Beehiiv list signed up by
 * themselves).
 *
 * The Waves Pest Insider's "A tool we'd use" block goes only to a reader whose row holds
 * reader_confirmed_at / reader_confirmed_email (migration 20261122190000, and
 * pest-insider/tool-block.js optedIn). Those columns had no backfill, because history
 * cannot tell a reader's click from a trusted add. The owner has now answered that for
 * one group: the rows the Beehiiv import wrote. So this one-time step writes the proof
 * for each import row that still holds that sign-up, and nothing else:
 *   - source is beehiiv_migration or beehiiv_migration_orphan, AND created_at is inside
 *     the import run: the first row at 2026-04-19 11:41:06.249Z, the last at
 *     11:44:55.258Z, and the window is [11:41:06Z, 11:44:56Z). Production read 2026-11-25: all
 *     637 Beehiiv rows were created in that run, and no row of any other source was
 *     created within 10 minutes of it. A source label alone is not evidence: the public
 *     sign-up route stores the caller's source, and a re-signup rewrites it;
 *   - subscribed_at is before the import run: the importer copied each reader's own
 *     Beehiiv sign-up date (migrate-beehiiv-subscribers.js), and in April every other
 *     writer (the public sign-up route, routes/newsletter.js, the column default) set it
 *     to now(). So a web sign-up that carried a Beehiiv source label in the run window
 *     cannot match. Production read 2026-11-25: all 596 candidates carry a sign-up date
 *     from 2024-11-27 to 2026-04-17;
 *   - the row was never written after its insert: updated_at = created_at (the insert
 *     stamps both with the same now()). Every later writer stamps updated_at (an
 *     opt-out, a sunset or its comeback, a trusted resubscribe, and the email fanout
 *     that moves a row to a corrected address), so the address on the row is the
 *     address the reader signed up with. Production read 2026-11-25: 596 of the 597
 *     active import rows match; the one written later gets no proof here;
 *   - status active, confirmed_at set, and no opt-out or comeback stamp
 *     (unsubscribed_at, deactivated_at, resubscribed_at all NULL);
 *   - no proof on the row yet (a reader who already clicked keeps that click).
 * reader_confirmed_at takes the row's confirmed_at (so the send rule's order check holds:
 * an opt-out or a trusted re-activation after it voids it, as for a click), and
 * reader_confirmed_email the row's address, lowercased.
 *
 * Runs once (knex records it). Idempotent anyway: the proof-is-NULL condition skips
 * every row it already wrote. down does nothing: the rows cannot be told apart from a
 * later real click with the same stamps, and clearing a real click would be wrong.
 */
const IMPORT_SOURCES = ['beehiiv_migration', 'beehiiv_migration_orphan'];
// The Beehiiv import run, production (read 2026-11-25): first row 11:41:06.249Z, last row
// 11:44:55.258Z. Start inclusive, end exclusive; both rows fall inside.
const IMPORT_RUN_START = '2026-04-19T11:41:06Z';
const IMPORT_RUN_END = '2026-04-19T11:44:56Z';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('newsletter_subscribers'))) return;
  if (!(await knex.schema.hasColumn('newsletter_subscribers', 'reader_confirmed_at'))) return;
  await knex('newsletter_subscribers')
    .whereIn('source', IMPORT_SOURCES)
    .where('created_at', '>=', IMPORT_RUN_START)
    .where('created_at', '<', IMPORT_RUN_END)
    .where('subscribed_at', '<', IMPORT_RUN_START)
    .where('status', 'active')
    .whereNotNull('confirmed_at')
    .whereNull('unsubscribed_at')
    .whereNull('deactivated_at')
    .whereNull('resubscribed_at')
    .whereNull('reader_confirmed_at')
    .whereRaw('updated_at = created_at')
    .update({
      reader_confirmed_at: knex.ref('confirmed_at'),
      reader_confirmed_email: knex.raw('LOWER(email)'),
    });
};

exports.down = async function down() {};

exports.IMPORT_SOURCES = IMPORT_SOURCES;
exports.IMPORT_RUN_START = IMPORT_RUN_START;
exports.IMPORT_RUN_END = IMPORT_RUN_END;
