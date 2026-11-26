'use strict';

// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): no promise of termite damage repair
// on new work. The staff script seeded as communication_scripts.upsell_termite (20260401000026) tells the tech to
// say "Protection comes with $500K damage repair guarantee" and calls that guarantee "the closer". No dollar cap
// exists and nothing is insured, so the script now pitches retreatment only, with no dollar figure.
//
// Readers (checked 2026-11-25): GET /api/admin/protocols/scripts (server/routes/admin-protocols.js) reads the table
// and nothing else does. It feeds the Tech Protocols page (client TechProtocolsPage.jsx) and the admin Schedule
// page. No voice agent, SMS prompt, constant or seed file loads the text at runtime.
//
// Guarded per column: script and tone_notes are each rewritten only while they still hold the exact seeded text,
// so an admin edit is kept. An edited row that still holds a repair promise is logged for the office. A re-run
// changes nothing.
//
// down(): documented no-op (owner rule 2026-08-09): these are admin-editable values and the repair promise must not
// come back by accident.

const SCENARIO = 'upsell_termite';
const OLD_SCRIPT = 'Trigger: mud tubes, swarmers, or damaged wood. "I noticed [finding]. Recommend full inspection — 45 min, free for WaveGuard members. Protection comes with $500K damage repair guarantee, transfers with home sale."';
const NEW_SCRIPT = 'Trigger: mud tubes, swarmers, or damaged wood. "I noticed [finding]. Recommend full inspection — 45 min, free for WaveGuard members. If termites are active, we treat and re-treat at no charge if they return during the term. We do not repair termite damage. The coverage transfers with a home sale after a re-inspection."';
const OLD_TONE = 'Educational, not alarmist. Damage guarantee is the closer.';
const NEW_TONE = 'Educational, not alarmist. Never promise damage repair or quote a dollar amount. Coverage is retreatment only: follow the signed agreement.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('communication_scripts'))) return;
  const rows = await knex('communication_scripts').where({ scenario: SCENARIO });
  for (const row of rows) {
    const update = {};
    if (row.script === OLD_SCRIPT) update.script = NEW_SCRIPT;
    if (row.tone_notes === OLD_TONE) update.tone_notes = NEW_TONE;
    if (Object.keys(update).length) {
      await knex('communication_scripts').where({ id: row.id }).update(update);
    }
    // Only text the migration did not write itself: an admin-edited script or tone that still promises repair.
    const kept = [update.script ? '' : row.script, update.tone_notes ? '' : row.tone_notes].join(' ');
    if (/repair|\$\s?\d+\s?k|guarantee/i.test(kept)) {
      console.warn(`[upsell-termite-script] row ${row.id} was edited and still mentions repair, a guarantee or a dollar cap; left as is. Review it in the tech protocols script list.`);
    }
  }
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.SCENARIO = SCENARIO;
exports.OLD_SCRIPT = OLD_SCRIPT;
exports.NEW_SCRIPT = NEW_SCRIPT;
exports.OLD_TONE = OLD_TONE;
exports.NEW_TONE = NEW_TONE;
