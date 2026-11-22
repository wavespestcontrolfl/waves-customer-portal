/**
 * Referral program Step 2: one handwritten thank-you note to the member for every friend who books (owner
 * 2026-11-20, A1; the note never names the friend). The office writes the notes from a list in Referrals → Queue
 * and marks each one written.
 *
 * referrals:
 *   thank_you_note_at  when the office marked the member's note written (null: not written yet)
 *   thank_you_note_by  the staff login (technicians.id) that marked it
 *
 * Additive and nullable. A referral owes a note only when it carries the Step 2 mark (referrer_reward_reason,
 * services/referral-thank-you-notes.js), so no row from before Step 2 enters the list. down drops the columns.
 */
const TABLE = 'referrals';

const COLUMNS = [
  ['thank_you_note_at', (t) => t.timestamp('thank_you_note_at', { useTz: true })],
  ['thank_you_note_by', (t) => t.uuid('thank_you_note_by')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, name))) await knex.schema.alterTable(TABLE, add);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name] of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, name)) await knex.schema.alterTable(TABLE, (t) => t.dropColumn(name));
  }
};

exports._COLUMNS = COLUMNS.map(([name]) => name);
