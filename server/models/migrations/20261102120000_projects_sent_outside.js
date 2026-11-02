// projects.sent_outside_portal_* — a signed WDO report the licensee sent by
// some other route than the portal (owner 2026-11-02, "Sent another way").
// A portal send sets projects.sent_at and archives the FDACS PDF; a report
// sent by hand leaves both empty, so the nightly WDO attention sweep flagged
// it forever. These three columns record who marked it, when, and why.
// Additive and nullable, no backfill: NULL = not marked. sent_at is never
// touched, so "sent through the portal" stays a separate fact.
const COLUMNS = ['sent_outside_portal_at', 'sent_outside_portal_by', 'sent_outside_portal_note'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  const has = {};
  for (const name of COLUMNS) has[name] = await knex.schema.hasColumn('projects', name);
  if (COLUMNS.every((name) => has[name])) return;
  await knex.schema.alterTable('projects', (t) => {
    if (!has.sent_outside_portal_at) t.timestamp('sent_outside_portal_at', { useTz: true }).nullable();
    // The admin technician who clicked it (same FK shape as created_by_tech_id).
    if (!has.sent_outside_portal_by) t.uuid('sent_outside_portal_by').nullable().references('id').inTable('technicians');
    if (!has.sent_outside_portal_note) t.text('sent_outside_portal_note').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('projects'))) return;
  const present = [];
  for (const name of COLUMNS) {
    if (await knex.schema.hasColumn('projects', name)) present.push(name);
  }
  if (!present.length) return;
  await knex.schema.alterTable('projects', (t) => {
    for (const name of present) t.dropColumn(name);
  });
};
