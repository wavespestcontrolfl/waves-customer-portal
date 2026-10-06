/**
 * decision_reviews.subject_type: narrow the CHECK to the subjects that have a
 * writer and a reviewer today (Codex r1 on #5775).
 *
 * 20261003100000 (pushed, so frozen) widened the CHECK to six new types up
 * front. Only social_post has code behind it: the recorder refuses the other
 * five and the review route cannot read them back, so allowing them only
 * weakened the table's invariant. This cut leaves call_log, sms_log and
 * social_post; a later package widens the CHECK in the migration that ships
 * its writer and its reviewer.
 *
 * No row of a removed type can exist: nothing has ever written one
 * (services/typed-decisions/shadow-recorder.js SUBJECT_TYPES). Both cuts land
 * in the same deploy, and a writer on an older commit of a rolling deploy
 * records call_log and sms_log only, which pass before and after.
 */
const TABLE = 'decision_reviews';
const CHECK = 'decision_reviews_subject_type_check';
const SUBJECT_TYPES = ['call_log', 'sms_log', 'social_post'];
// What 20261003100000 left in place; the down returns to it.
const WIDE = [...SUBJECT_TYPES, 'service_photo', 'visit', 'call_turn', 'lead', 'google_review'];
const inList = (types) => types.map((t) => `'${t}'`).join(', ');

async function setCheck(knex, types) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (subject_type IN (${inList(types)}))`);
}

exports.up = (knex) => setCheck(knex, SUBJECT_TYPES);
// Widening only, so it needs no guard; 20261003100000's own down then decides
// whether the original two-type CHECK can come back.
exports.down = (knex) => setCheck(knex, WIDE);

exports.SUBJECT_TYPES = SUBJECT_TYPES;
