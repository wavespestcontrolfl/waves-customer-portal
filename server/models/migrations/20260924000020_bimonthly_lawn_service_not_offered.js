// Follow-up to 20260924000010 (owner directive 2026-09-24: stop offering
// bi-monthly lawn care). That migration took lawn_care_recurring ("Bi-Monthly
// Lawn Care Service") off the public quote menu, but the row still carried
// customer_visible=true and booking_enabled=true, so it stayed listed on the
// public MCP service catalog (routes/public-mcp.js listServices) and bookable
// by the call agent (call-booking-catalog loadBookableCallServices).
//
// Flip both off. is_active stays true: historic visits and invoices reference
// the row. Same seed-once / state-tracked / no-op-down contract as
// 20260903000020 and 20260924000010: a rerun never re-flips a flag an admin
// turned back on in the Service Library, and down() is a documented no-op
// because a "still false" flag can't be told apart from that admin choice.

const SERVICE_KEY = 'lawn_care_recurring';
const STATE_KEY = 'migration.20260924000020.state';
const FLAGS = ['customer_visible', 'booking_enabled'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const hasState = await knex.schema.hasTable('system_settings');
  let prior = {};
  if (hasState) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { prior = row ? (JSON.parse(row.value).flipped || {}) : {}; } catch { prior = {}; }
  }
  const flipped = { ...prior };
  for (const flag of FLAGS) {
    if (!(await knex.schema.hasColumn('services', flag))) continue;
    const done = new Set(prior[flag] || []);
    const rows = await knex('services').where({ service_key: SERVICE_KEY, [flag]: true }).select('id');
    const ids = rows.map((r) => r.id).filter((id) => !done.has(id));
    if (ids.length) {
      await knex('services').whereIn('id', ids).where({ [flag]: true })
        .update({ [flag]: false, updated_at: knex.fn.now() });
    }
    flipped[flag] = [...new Set([...(prior[flag] || []), ...ids])];
  }
  if (hasState) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ flipped }) });
  }
};

exports.down = async function down() {
  // Documented no-op — see header. Re-enable from the Service Library.
};

exports.SERVICE_KEY = SERVICE_KEY;
exports.FLAGS = FLAGS;
