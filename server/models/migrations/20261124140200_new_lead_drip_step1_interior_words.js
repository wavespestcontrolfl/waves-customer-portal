'use strict';

/**
 * Step 1 of the new_lead drip (seeded by 20261124140000_new_lead_drip_steps, frozen) said "Inside and outside treatment at each
 * visit". The residential terms (services/estimate-service-details.js; owner 2026-10-22, services/sms-company-facts.js) are
 * an inside spray on the first visit and inside whenever the customer asks, so the bullet now says that.
 *
 * Replaces only that one bullet, in the one seeded row (by its fixed id), and only where the old words are still in the body, so
 * any other edit an administrator made to the email is left alone. Idempotent. down() is a documented no-op (waves-db skill §4).
 */

const STEP_ID = 'c215d7f2-8052-47ac-94ac-e5c049ed2ca2';
const NEW_WORDS = 'Outside treatment at every visit, plus an inside spray on your first visit and whenever you ask';

const SWAPS = [
  { column: 'html_body', before: '<li>Inside and outside treatment at each visit</li>', after: `<li>${NEW_WORDS}</li>` },
  { column: 'text_body', before: '- Inside and outside treatment at each visit', after: `- ${NEW_WORDS}` },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;
  const row = await knex('automation_steps').where({ id: STEP_ID, template_key: 'new_lead' }).first('html_body', 'text_body');
  if (!row) return;
  const patch = {};
  for (const swap of SWAPS) {
    const body = row[swap.column];
    if (typeof body === 'string' && body.includes(swap.before)) patch[swap.column] = body.replace(swap.before, () => swap.after);
  }
  if (!Object.keys(patch).length) return;
  await knex('automation_steps').where({ id: STEP_ID }).update({ ...patch, updated_at: knex.fn.now() });
};

exports.down = async function down() {};
