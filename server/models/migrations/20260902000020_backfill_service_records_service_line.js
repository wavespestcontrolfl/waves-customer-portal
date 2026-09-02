/**
 * Stamp service_records.service_line where it is NULL (post-service report
 * audit, 2026-09-02).
 *
 * Every runtime reader already falls back to detectServiceLine(service_type)
 * when the column is NULL (report-data, pressure-trend, neighborhood
 * pressure, the lawn write gate), so the row's effective line is what that
 * function returns today. The ONE reader that does not fall back is the
 * neighborhood-pressure SQL aggregate, which buckets a NULL line under the
 * raw label (COALESCE(service_line, service_type)) — that is the skew this
 * closes. The stamp freezes exactly the runtime verdict, changing no report.
 *
 * Writers that left the column NULL (project completion, the pest recap)
 * stamp it going forward in the same change; this covers the backlog.
 *
 * Set-based per distinct label with a CAS on `service_line IS NULL`; the
 * state row ledgers {label → line, ids} so down() clears only rows this
 * migration stamped that still carry that exact value. Idempotent: a re-run
 * finds no NULL rows for labels already stamped.
 */

const { detectServiceLine } = require('../../services/service-report/service-line-configs');

const STATE_KEY = 'migration.20260902000020.state';

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return typeof row.value === 'string' ? JSON.parse(row.value) : row.value; } catch { return null; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasColumn('service_records', 'service_line'))) return;

  const prior = await loadState(knex);
  const state = { stamped: Array.isArray(prior?.stamped) ? prior.stamped : [] };

  const rows = await knex('service_records')
    .whereNull('service_line')
    .whereNotNull('service_type')
    .select('id', 'service_type');

  // Grouped by the RAW stored label so the write can re-check it verbatim.
  const byLabel = new Map();
  for (const r of rows) {
    if (typeof r.service_type !== 'string' || !r.service_type.trim()) continue;
    if (!byLabel.has(r.service_type)) byLabel.set(r.service_type, []);
    byLabel.get(r.service_type).push(r.id);
  }

  for (const [label, ids] of byLabel) {
    const line = detectServiceLine(label.trim());
    if (!line) continue;
    // Ledger only the ids the CAS write actually touched (RETURNING): a row
    // a concurrent writer filled between scan and write is theirs, and
    // down() must never clear it (pre-push codex P1). The label is
    // re-checked too — a relabel between scan and write must not receive
    // the OLD label's line (GH codex r1 P2).
    const updated = await knex('service_records')
      .whereIn('id', ids)
      .where({ service_type: label })
      .whereNull('service_line')
      .update({ service_line: line }, ['id']);
    const stampedIds = (Array.isArray(updated) ? updated : []).map((r) => (r && typeof r === 'object' ? r.id : r)).filter(Boolean);
    if (stampedIds.length) state.stamped.push({ service_type: label, service_line: line, ids: stampedIds });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_records'))) return;
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const state = await loadState(knex);
  if (!state) return; // no ledger — leave data as-is rather than guess
  for (const rec of Array.isArray(state.stamped) ? state.stamped : []) {
    if (!rec || !Array.isArray(rec.ids) || !rec.service_line) continue;
    await knex('service_records')
      .whereIn('id', rec.ids)
      .where({ service_line: rec.service_line })
      .update({ service_line: null });
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
