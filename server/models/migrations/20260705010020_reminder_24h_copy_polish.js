'use strict';

/**
 * Copy polish on the 24h appointment reminder (owner review 2026-07-05):
 *
 *  1. "Your tech will message you when they are about 15 minutes out." is
 *     wrong — we don't message ad hoc, the en-route automation sends a
 *     live tracking link. Say that.
 *  2. "scheduled for tomorrow." now carries the day, date, and start time
 *     inline ("tomorrow, {{appointment_day}}, {{appointment_date}},
 *     starting at {{appointment_time}}") — appointment_day/date are new
 *     allowed variables for this template (the 72h template already has
 *     them; the sender now supplies them for 24h too).
 *  3. Signature tightened to "We look forward to servicing your home.
 *     — The Waves Team".
 *
 * Read-modify-write, admin-edit preserving (same posture as
 * 20260702000012): each block is only rewritten when it still carries the
 * exact shipped copy — an admin-edited block is left alone.
 */

const TEMPLATE_KEY = 'appointment.reminder_24h';

const OLD_TOMORROW = 'This is a reminder that your {{service_type}} appointment with Waves is scheduled for tomorrow.';
const NEW_TOMORROW = 'This is a reminder that your {{service_type}} appointment with Waves is scheduled for tomorrow, {{appointment_day}}, {{appointment_date}}, starting at {{appointment_time}}.';

const OLD_ARRIVAL = 'Expect your technician to arrive within a two-hour window of the scheduled start time. Your tech will message you when they are about 15 minutes out.';
const NEW_ARRIVAL = 'Expect your technician to arrive within a two-hour window of the scheduled start time. When your technician is on the way, we will text you a live tracking link so you can follow along.';

const OLD_SIGNATURE = 'Thank you, The Waves Team';
const NEW_SIGNATURE = 'We look forward to servicing your home. — The Waves Team';

const NEW_VARIABLES = ['appointment_day', 'appointment_date'];

const FIXTURE_SAMPLES = { appointment_day: 'Tuesday', appointment_date: 'July 8, 2026' };

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function withVariables(list, variables) {
  const arr = asArray(list);
  const additions = variables.filter((v) => !arr.includes(v));
  return additions.length ? [...arr, ...additions] : arr;
}

function swapContent(blocks, from, to) {
  return asArray(blocks).map((b) => (
    b && typeof b.content === 'string' && b.content === from
      ? { ...b, content: to }
      : b
  ));
}

async function rewrite(knex, swaps, variableMutator, fixtureMutator) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  const now = new Date();

  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;

  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(variableMutator(template.allowed_variables)),
    optional_variables: JSON.stringify(variableMutator(template.optional_variables)),
    updated_at: now,
  });

  if (template.active_version_id) {
    const version = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first();
    if (version) {
      let blocks = asArray(version.blocks);
      for (const [from, to] of swaps) blocks = swapContent(blocks, from, to);
      await knex('email_template_versions').where({ id: version.id }).update({
        blocks: JSON.stringify(blocks),
        updated_at: now,
      });
    }
  }

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      let payload = fixture.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { payload = null; }
      }
      if (payload && typeof payload === 'object') {
        const next = fixtureMutator(payload);
        if (next) {
          await knex('email_template_fixtures').where({ id: fixture.id }).update({
            payload: JSON.stringify(next),
            updated_at: now,
          });
        }
      }
    }
  }
}

exports.up = async function up(knex) {
  await rewrite(
    knex,
    [
      [OLD_TOMORROW, NEW_TOMORROW],
      [OLD_ARRIVAL, NEW_ARRIVAL],
      [OLD_SIGNATURE, NEW_SIGNATURE],
    ],
    (list) => withVariables(list, NEW_VARIABLES),
    (payload) => {
      const missing = Object.keys(FIXTURE_SAMPLES).filter((k) => !payload[k]);
      return missing.length
        ? { ...payload, ...Object.fromEntries(missing.map((k) => [k, FIXTURE_SAMPLES[k]])) }
        : null;
    },
  );
};

exports.down = async function down(knex) {
  await rewrite(
    knex,
    [
      [NEW_TOMORROW, OLD_TOMORROW],
      [NEW_ARRIVAL, OLD_ARRIVAL],
      [NEW_SIGNATURE, OLD_SIGNATURE],
    ],
    (list) => asArray(list).filter((v) => !NEW_VARIABLES.includes(v)),
    (payload) => payload,
  );
};
