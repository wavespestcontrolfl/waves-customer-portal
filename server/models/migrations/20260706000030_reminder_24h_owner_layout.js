'use strict';

/**
 * Follow-up to 20260705010020_reminder_24h_copy_polish.
 *
 * The sender-wiring branch originally edited 20260705010020 in place
 * (safe while the whole email stack was unmerged), but that migration
 * shipped and RAN on prod (2026-07-06 10:28Z) in its original form when
 * #2395 merged ahead of this branch — so the in-place edit would never
 * re-run. This migration carries exactly that delta, applied on top of
 * the ran result:
 *
 *  1. Signature gets a real line break: "We look forward to servicing
 *     your home.\n\n— The Waves Team" (ran version emitted it inline).
 *  2. Two new optional variables — {{appointment_date}} and
 *     {{technician_name}} — with fixture samples, consumed by the
 *     details-card rows below (the 24h reminder sender supplies them).
 *  3. Owner layout call 2026-07-06: the details card lists Date above
 *     Scheduled start and Technician after Property, the signature sits
 *     directly under the arrival paragraph, and the questions note moves
 *     below the CTAs.
 *
 * Read-modify-write, admin-edit preserving (same posture as
 * 20260705010020): each step only fires when it finds the exact shipped
 * block — an admin-edited block is left alone.
 */

const TEMPLATE_KEY = 'appointment.reminder_24h';

// What 20260705010020 left on prod, and what the owner wants instead.
const RAN_SIGNATURE = 'We look forward to servicing your home. — The Waves Team';
const NEW_SIGNATURE = 'We look forward to servicing your home.\n\n— The Waves Team';

// Anchor for the signature-placement step (unchanged by this migration).
const NEW_ARRIVAL = 'Expect your technician to arrive within a two-hour window of the scheduled start time. When your technician is on the way, we will send you a live tracking link so you can follow along.';

const NEW_VARIABLES = ['appointment_date', 'technician_name'];

const FIXTURE_SAMPLES = { appointment_date: 'July 8, 2026', technician_name: 'Adam' };

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
    // Technician after Property (assigned tech; the row suppresses when
    // the sender has no assignment to report).
    if (!rows.some((r) => String(r.value || '').includes('technician_name'))) {
      const propIdx = rows.findIndex((r) => String(r.label || '') === 'Property');
      rows.splice(propIdx === -1 ? rows.length : propIdx + 1, 0, { label: 'Technician', value: '{{technician_name}}' });
    }
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
      [RAN_SIGNATURE, NEW_SIGNATURE],
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
      [NEW_SIGNATURE, RAN_SIGNATURE],
    ],
    (list) => asArray(list).filter((v) => !NEW_VARIABLES.includes(v)),
    (payload) => payload,
  );
};
