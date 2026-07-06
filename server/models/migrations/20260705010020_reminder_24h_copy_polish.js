'use strict';

/**
 * Copy polish on the 24h appointment reminder (owner review 2026-07-05):
 *
 *  1. "Your tech will message you when they are about 15 minutes out." is
 *     wrong — we don't message ad hoc, the en-route automation sends a
 *     live tracking link. Say that, channel-neutrally ("we will send
 *     you"): this email is also the fallback when SMS can't be delivered
 *     (landline/no-mobile customers), so "we will text you" would be a
 *     false promise on exactly the sends where email is the only channel.
 *  2. "scheduled for tomorrow." now carries the day, date, and start time
 *     inline via ONE composed optional variable ({{appointment_when}},
 *     e.g. ", Tuesday, July 8, 2026, starting at 8:00 AM") supplied by
 *     the sender. Composed sender-side so a fallback send with no
 *     reconstructable appointment time degrades to the clean original
 *     sentence ("…scheduled for tomorrow.") instead of "tomorrow, , ,
 *     starting at ." — per-field inline variables cannot degrade.
 *  3. Signature tightened to "We look forward to servicing your home.
 *     — The Waves Team".
 *
 * Read-modify-write, admin-edit preserving (same posture as
 * 20260702000012): each block is only rewritten when it still carries the
 * exact shipped copy — an admin-edited block is left alone.
 */

const TEMPLATE_KEY = 'appointment.reminder_24h';

const OLD_TOMORROW = 'This is a reminder that your {{service_type}} appointment with Waves is scheduled for tomorrow.';
const NEW_TOMORROW = 'This is a reminder that your {{service_type}} appointment with Waves is scheduled for tomorrow{{appointment_when}}.';

const OLD_ARRIVAL = 'Expect your technician to arrive within a two-hour window of the scheduled start time. Your tech will message you when they are about 15 minutes out.';
const NEW_ARRIVAL = 'Expect your technician to arrive within a two-hour window of the scheduled start time. When your technician is on the way, we will send you a live tracking link so you can follow along.';

const OLD_SIGNATURE = 'Thank you, The Waves Team';
const NEW_SIGNATURE = 'We look forward to servicing your home.\n— The Waves Team';

const NEW_VARIABLES = ['appointment_when', 'appointment_date'];

const FIXTURE_SAMPLES = { appointment_when: ', Tuesday, July 8, 2026, starting at 8:00 AM', appointment_date: 'July 8, 2026' };

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

const QUESTIONS_NOTE = 'Questions or need help? Reply to this email and our team will be happy to help.';

// Owner layout call 2026-07-06, admin-edit preserving (each step only
// fires when it finds the exact shipped block):
//  - the details card lists Date above Scheduled start (if we show the
//    start time, show the date too),
//  - the signature sits directly under the arrival paragraph,
//  - the questions note moves below the CTAs.
function applyOwnerLayout(blocks) {
  let arr = asArray(blocks).map((b) => b);

  // 1. Date row before 'Scheduled start' in the details block.
  arr = arr.map((b) => {
    if (!b || b.type !== 'details' || !Array.isArray(b.rows)) return b;
    if (b.rows.some((r) => String(r.value || '').includes('appointment_date'))) return b;
    const idx = b.rows.findIndex((r) => String(r.label || '') === 'Scheduled start');
    if (idx === -1) return b;
    const rows = [...b.rows];
    rows.splice(idx, 0, { label: 'Date', value: '{{appointment_date}}' });
    return { ...b, rows };
  });

  // 2. Signature directly after the arrival paragraph.
  const sigIdx = arr.findIndex((b) => b && b.type === 'signature' && b.content === NEW_SIGNATURE);
  const arrivalIdx = arr.findIndex((b) => b && b.content === NEW_ARRIVAL);
  if (sigIdx !== -1 && arrivalIdx !== -1 && sigIdx !== arrivalIdx + 1) {
    const [sig] = arr.splice(sigIdx, 1);
    const insertAt = arr.findIndex((b) => b && b.content === NEW_ARRIVAL) + 1;
    arr.splice(insertAt, 0, sig);
  }

  // 3. Questions note to the end (below the CTAs).
  const qIdx = arr.findIndex((b) => b && b.type === 'small_note' && b.content === QUESTIONS_NOTE);
  if (qIdx !== -1 && qIdx !== arr.length - 1) {
    const [q] = arr.splice(qIdx, 1);
    arr.push(q);
  }

  return arr;
}

async function rewrite(knex, swaps, variableMutator, fixtureMutator, layoutMutator = null) {
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
      if (layoutMutator) blocks = layoutMutator(blocks);
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
    applyOwnerLayout,
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
