/**
 * decision_reviews.subject_type: the subjects the Clef second wave records
 * against, added in ONE cut (a pushed migration is frozen, and this table has
 * needed many). The original CHECK allowed call_log and sms_log only.
 *
 *   social_post    a social_media_posts row (the technician field photo)
 *   service_photo  a service_photos row (report photos)
 *   visit          a scheduled_services row (access and safety flags)
 *   call_turn      one turn of a voice call (a v5 UUID of call + turn)
 *   lead           a leads row
 *   google_review  a google_reviews row
 *
 * Widening only: every existing row and every writer on an older commit of a
 * rolling deploy still passes. Code records a type only once
 * services/typed-decisions/shadow-recorder.js SUBJECT_TYPES lists it (today
 * social_post); the rest are allowed here so the next packages need no schema.
 */
const TABLE = 'decision_reviews';
const CHECK = 'decision_reviews_subject_type_check';
const ORIGINAL = ['call_log', 'sms_log'];
const SUBJECT_TYPES = [...ORIGINAL, 'social_post', 'service_photo', 'visit', 'call_turn', 'lead', 'google_review'];
const inList = (types) => types.map((t) => `'${t}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (subject_type IN (${inList(SUBJECT_TYPES)}))`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  // Knex runs this in the migration's transaction. The lock comes first, so
  // no writer can add a row of a new type between the check below and the
  // narrower constraint.
  await knex.raw(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
  const other = await knex(TABLE).whereNotIn('subject_type', ORIGINAL).first('id');
  // Refuse rather than delete review evidence to make the rollback fit.
  if (other) {
    throw new Error(`${TABLE} holds rows for a subject type other than ${ORIGINAL.join(', ')}; export or remove them before rolling back the subject types`);
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (subject_type IN (${inList(ORIGINAL)}))`);
};

exports.SUBJECT_TYPES = SUBJECT_TYPES;
