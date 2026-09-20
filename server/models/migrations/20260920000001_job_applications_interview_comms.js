/**
 * Recruiting comms — interview self-scheduling columns on job_applications,
 * plus the sms_templates rows the send pipeline renders (GATE_RECRUITING_COMMS,
 * dark by default; see server/config/feature-gates.js).
 *
 * interview_token: minted once (first move to 'interview'), reused after —
 * never rotated in this PR. No expiry column; eligibility is
 * row.status === 'interview' (checked at read/write time by the routes).
 *
 * comms_history: append-only log of every applicant-facing send attempt
 * (sent/blocked/failed/skipped), masked recipient only — see
 * server/services/recruiting-comms.js.
 *
 * sms_templates seeding is INSERT-ONLY: a template_key that already exists
 * is left untouched (an owner may have hand-edited the copy through the
 * templates admin UI before this migration re-runs in some environment
 * order), never overwritten on every deploy. down() mirrors this — it drops
 * only the job_applications columns/constraint this migration added and
 * leaves whatever is in sms_templates alone, since those rows may since
 * carry owner edits or a live send history this migration did not create.
 */

const ROLES = ['technician', 'sales', 'other'];
const STATUSES = ['new', 'reviewed', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

const TEMPLATES = [
  {
    template_key: 'job_application_received',
    name: 'Job Application Received',
    category: 'recruiting',
    body: 'Hi {first_name}, thanks for applying to Waves Pest Control. We read every application and will reach out within 2 business days. Reply STOP to opt out.',
    variables: ['first_name'],
    sort_order: 40,
  },
  {
    template_key: 'job_application_received_es',
    name: 'Job Application Received (Spanish)',
    category: 'recruiting',
    // "Reply STOP to opt out." stays in English — it is the literal
    // carrier/A2P opt-out keyword Twilio listens for, not translated copy.
    body: 'Hola {first_name}, gracias por postularte a Waves Pest Control. Revisamos cada solicitud y te contactaremos en un plazo de 2 dias habiles. Reply STOP to opt out.',
    variables: ['first_name'],
    sort_order: 41,
  },
  {
    template_key: 'job_interview_invite',
    name: 'Job Interview Invite',
    category: 'recruiting',
    body: 'Hi {first_name}, Waves Pest Control would like to interview you. Pick a phone or in-person time that works for you: {interview_url}',
    variables: ['first_name', 'interview_url'],
    sort_order: 42,
  },
  {
    template_key: 'job_interview_invite_es',
    name: 'Job Interview Invite (Spanish)',
    category: 'recruiting',
    body: 'Hola {first_name}, Waves Pest Control quisiera entrevistarte. Elige un horario por telefono o en persona que te convenga: {interview_url}',
    variables: ['first_name', 'interview_url'],
    sort_order: 43,
  },
  {
    template_key: 'job_interview_confirmation',
    name: 'Job Interview Confirmation',
    category: 'recruiting',
    body: "You're set. {interview_mode_line} {interview_when}. Need to change it? Use the same link: {interview_url}",
    variables: ['interview_mode_line', 'interview_when', 'interview_url'],
    sort_order: 44,
  },
  {
    template_key: 'job_interview_confirmation_es',
    name: 'Job Interview Confirmation (Spanish)',
    category: 'recruiting',
    body: 'Listo. {interview_mode_line} {interview_when}. Necesitas cambiarlo? Usa el mismo enlace: {interview_url}',
    variables: ['interview_mode_line', 'interview_when', 'interview_url'],
    sort_order: 45,
  },
];

const COLUMNS = [
  'interview_token', 'interview_token_created_at', 'interview_mode', 'interview_at',
  'interview_end_at', 'interview_booked_at', 'sms_consent', 'comms_history',
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('job_applications')) {
    for (const column of COLUMNS) {
       
      if (await knex.schema.hasColumn('job_applications', column)) continue;
       
      await knex.schema.alterTable('job_applications', (t) => {
        if (column === 'interview_token') t.string('interview_token', 64).nullable().unique();
        if (column === 'interview_token_created_at') t.timestamp('interview_token_created_at', { useTz: true }).nullable();
        if (column === 'interview_mode') t.string('interview_mode', 12).nullable();
        if (column === 'interview_at') t.timestamp('interview_at', { useTz: true }).nullable();
        if (column === 'interview_end_at') t.timestamp('interview_end_at', { useTz: true }).nullable();
        if (column === 'interview_booked_at') t.timestamp('interview_booked_at', { useTz: true }).nullable();
        if (column === 'sms_consent') t.boolean('sms_consent').notNullable().defaultTo(false);
        if (column === 'comms_history') t.jsonb('comms_history').notNullable().defaultTo('[]');
      });
    }

    await knex.raw(`DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'job_applications_interview_mode_check'
            AND conrelid = 'job_applications'::regclass
        ) THEN
          ALTER TABLE job_applications
            ADD CONSTRAINT job_applications_interview_mode_check
            CHECK (interview_mode IS NULL OR interview_mode IN ('phone', 'in_person'));
        END IF;
      END
    $$`);

    const hasIndex = await knex.raw(`
      SELECT 1 FROM pg_indexes WHERE tablename = 'job_applications' AND indexname = 'job_applications_interview_at_index'
    `);
    if (!hasIndex.rows || hasIndex.rows.length === 0) {
      await knex.schema.alterTable('job_applications', (t) => {
        t.index(['interview_at'], 'job_applications_interview_at_index');
      });
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    for (const tpl of TEMPLATES) {

      const existing = await knex('sms_templates').where({ template_key: tpl.template_key }).first();
      // Insert-only: a pre-existing row (owner-edited copy, or a re-run in
      // some environment ordering) is left exactly as it is — never
      // overwritten by the seed on every deploy.
      if (existing) continue;
      await knex('sms_templates').insert({
        template_key: tpl.template_key,
        name: tpl.name,
        category: tpl.category,
        body: tpl.body,
        variables: JSON.stringify(tpl.variables),
        sort_order: tpl.sort_order,
        is_active: true,
      });
    }
  }
};

exports.down = async function down(knex) {
  // sms_templates rows are left in place — this migration only seeds them
  // insert-only (never overwrites), so it does not own them exclusively and
  // must not delete rows that may carry owner edits or live send history.
  // Reverting only undoes the job_applications schema change below.

  if (await knex.schema.hasTable('job_applications')) {
    await knex.raw('ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_interview_mode_check');
    for (const column of COLUMNS) {
       
      if (await knex.schema.hasColumn('job_applications', column)) {
         
        await knex.schema.alterTable('job_applications', (t) => { t.dropColumn(column); });
      }
    }
  }
};

// Exported for reference/tests; not used by the up()/down() control flow directly.
exports._TEMPLATES = TEMPLATES;
exports._COLUMNS = COLUMNS;
exports._ROLES = ROLES;
exports._STATUSES = STATUSES;
exports._quoted = quoted;
