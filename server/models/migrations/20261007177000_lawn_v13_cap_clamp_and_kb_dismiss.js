/**
 * Lawn protocol v13 count caps (Codex round 11 on #6104). Two data corrections.
 *
 * 1. Clamp the protocol-row cap metadata to the cap. 20261007175000 added gates.annualMaxApps and
 *    annual_counter.maxApplications (2) to the staged v13 rows of Celsius, Arena, Certainty and
 *    Blindside only where the key was absent, so a row that already carried a larger figure (3) kept
 *    it and the field screens advertised more than the app enforces. Here a figure above 2 on those
 *    rows becomes 2 (min(existing, 2): it is never raised). Each changed row is audited with the
 *    values it held; down() restores a value only where it is still the clamped 2.
 *
 * 2. The "Celsius WG — Application Limits" knowledge article still recommends Dismiss NXT as an
 *    alternative after the cap ("different MOA, no annual cap concern"). Dismiss is retired
 *    (#6098: use up existing stock on green kyllinga only, do not reorder). That one line (exact
 *    match, so any other edit survives) now says so, the article's knowledge_embeddings chunks are
 *    purged so search re-chunks it, one audit_log event records it, and down() puts the old line back
 *    only while the exact new line is still present.
 */
const staged = require('./20261005120000_lawn_protocol_v13_staged');
const { V13_COUNT_CAPS } = require('../../config/lawn-v13-count-caps');

const CAP = 2;
const NAMES = V13_COUNT_CAPS.map((entry) => entry.name);
const CLAMP_ACTION = 'v13_count_caps_protocol_rows_clamped';

const KB_SLUG = 'celsius-wg-application-limits';
const KB_ACTION = 'knowledge_base.celsius_dismiss_retired';
const KB_ACTION_DOWN = 'knowledge_base.celsius_dismiss_retired_reverted';
const DISMISS = {
  old: '- Dismiss NXT (sulfentrazone + prodiamine) — different MOA, no annual cap concern',
  next: '- Dismiss NXT (sulfentrazone + prodiamine) — retired: do not reorder. Use up existing stock on green kyllinga under 85°F only; it is not an alternative after the Celsius cap',
};

function asObject(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const isAboveCap = (value) => typeof value === 'number' && Number.isFinite(value) && value > CAP;

// ── 1. clamp ────────────────────────────────────────────────────────────────

async function hasClampTables(knex) {
  for (const table of ['lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols', 'lawn_protocol_audit_log']) {
    if (!(await knex.schema.hasTable(table))) return false;
  }
  return true;
}

async function clampUp(knex) {
  if (!(await hasClampTables(knex))) return;
  const rows = await knex('lawn_protocol_products as p')
    .join('lawn_protocol_windows as w', 'p.lawn_protocol_window_id', 'w.id')
    .join('lawn_protocols as l', 'w.lawn_protocol_id', 'l.id')
    .where('l.version', staged.V13_VERSION)
    .whereIn('p.product_name', NAMES)
    .select('p.id', 'p.gates', 'p.annual_counter', 'l.id as protocol_id');
  const byProtocol = new Map();
  for (const row of rows) {
    const gates = asObject(row.gates);
    const counter = asObject(row.annual_counter);
    const changed = { id: row.id };
    const update = {};
    if (isAboveCap(gates.annualMaxApps)) { changed.gate = gates.annualMaxApps; update.gates = JSON.stringify({ ...gates, annualMaxApps: CAP }); }
    if (isAboveCap(counter.maxApplications)) { changed.counter = counter.maxApplications; update.annual_counter = JSON.stringify({ ...counter, maxApplications: CAP }); }
    if (!Object.keys(update).length) continue;
    await knex('lawn_protocol_products').where({ id: row.id }).update({ ...update, updated_at: knex.fn.now() });
    if (!byProtocol.has(row.protocol_id)) byProtocol.set(row.protocol_id, []);
    byProtocol.get(row.protocol_id).push(changed);
  }
  for (const [protocolId, changed] of byProtocol) {
    await knex('lawn_protocol_audit_log').insert({
      lawn_protocol_id: protocolId,
      actor_name: 'migration 20261007177000',
      entity_type: 'protocol',
      entity_id: protocolId,
      action: CLAMP_ACTION,
      changed_fields: JSON.stringify(['products']),
      before_snapshot: JSON.stringify({ rows: changed }),
      after_snapshot: JSON.stringify({ cap: CAP }),
      metadata: JSON.stringify({ migration: '20261007177000_lawn_v13_cap_clamp_and_kb_dismiss' }),
    });
  }
}

async function clampDown(knex) {
  if (!(await hasClampTables(knex))) return;
  for (const audit of await knex('lawn_protocol_audit_log').where({ action: CLAMP_ACTION })) {
    const { rows = [] } = asObject(audit.before_snapshot);
    for (const changed of rows) {
      const row = await knex('lawn_protocol_products').where({ id: changed.id }).first('gates', 'annual_counter');
      if (!row) continue;
      const gates = asObject(row.gates);
      const counter = asObject(row.annual_counter);
      const update = {};
      if (changed.gate !== undefined && gates.annualMaxApps === CAP) { gates.annualMaxApps = changed.gate; update.gates = JSON.stringify(gates); }
      if (changed.counter !== undefined && counter.maxApplications === CAP) { counter.maxApplications = changed.counter; update.annual_counter = JSON.stringify(counter); }
      if (Object.keys(update).length) await knex('lawn_protocol_products').where({ id: changed.id }).update({ ...update, updated_at: knex.fn.now() });
    }
    await knex('lawn_protocol_audit_log').where({ id: audit.id }).del();
  }
}

// ── 2. the Dismiss line ─────────────────────────────────────────────────────

async function kbRewrite(knex, direction) {
  if (!(await knex.schema.hasTable('knowledge_base'))) return;
  const article = await knex('knowledge_base').where({ slug: KB_SLUG }).first();
  if (!article || typeof article.content !== 'string') return;
  const from = direction === 'up' ? DISMISS.old : DISMISS.next;
  const to = direction === 'up' ? DISMISS.next : DISMISS.old;
  // The new line starts with the old one: a line already rewritten is never rewritten twice.
  if (!article.content.includes(from) || (direction === 'up' && article.content.includes(DISMISS.next))) return;
  await knex('knowledge_base').where({ id: article.id }).update({
    content: article.content.replace(from, () => to),
    last_verified_at: new Date(),
    verified_by: direction === 'up' ? 'migration-lawn-v13-celsius-dismiss-retired' : 'migration-lawn-v13-celsius-dismiss-retired-down',
  });
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'kb', source_id: KB_SLUG }).del();
  }
  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: direction === 'up' ? KB_ACTION : KB_ACTION_DOWN,
      resource_type: 'knowledge_base',
      resource_id: String(article.id),
      metadata: { migration: '20261007177000_lawn_v13_cap_clamp_and_kb_dismiss', slug: KB_SLUG, before: from, after: to },
      critical: true,
      trx: knex,
    });
  }
}

exports.up = async function up(knex) {
  await clampUp(knex);
  await kbRewrite(knex, 'up');
};

exports.down = async function down(knex) {
  await kbRewrite(knex, 'down');
  await clampDown(knex);
};

exports._CLAMP_ACTION = CLAMP_ACTION;
exports._KB_SLUG = KB_SLUG;
exports._DISMISS = DISMISS;
exports._KB_ACTION = KB_ACTION;
exports._KB_ACTION_DOWN = KB_ACTION_DOWN;
