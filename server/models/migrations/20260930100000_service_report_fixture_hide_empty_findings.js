'use strict';

/**
 * Service report email: hide the "Findings" row when nothing was logged.
 *
 * The sender now passes finding_summary = '' for a visit with no findings, so
 * the template's Findings row drops. The saved preview fixtures of
 * service.report_ready still carried the old sentence, so the admin preview
 * and "Send test" kept showing a row that real sends no longer contain
 * (seeded by 20260526000013, preserved by later fixture merges).
 *
 * Data-only, fixtures only: finding_summary is blanked ONLY where it still
 * equals that exact seeded sentence. Any value staff edited, and the "First
 * lawn report" example ("Lawn score baseline recorded.", a non-empty row),
 * are left alone. Idempotent: a second run finds nothing to change. `down`
 * is a documented no-op.
 */

const MIGRATION = '20260930100000';
const TEMPLATE_KEY = 'service.report_ready';
const SEEDED_EMPTY_SENTENCE = 'No action-required findings were documented.';

function json(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_fixtures'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) {
    console.log(`[migration:${MIGRATION}] ${TEMPLATE_KEY} not found; nothing to do`);
    return;
  }
  const fixtures = await knex('email_template_fixtures').where({ template_id: template.id });
  let changed = 0;
  for (const fixture of fixtures) {
    const payload = json(fixture.payload);
    if (payload.finding_summary !== SEEDED_EMPTY_SENTENCE) continue;
    await knex('email_template_fixtures')
      .where({ id: fixture.id })
      .update({ payload: JSON.stringify({ ...payload, finding_summary: '' }), updated_at: new Date() });
    changed += 1;
  }
  console.log(`[migration:${MIGRATION}] ${TEMPLATE_KEY}: blanked finding_summary in ${changed} of ${fixtures.length} fixture(s)`);
};

exports.down = async function down() {
  // Data-only fixture cleanup: restoring the sentence would re-show a row real
  // sends no longer contain, and could overwrite later staff edits.
};

exports._private = { SEEDED_EMPTY_SENTENCE, TEMPLATE_KEY };
