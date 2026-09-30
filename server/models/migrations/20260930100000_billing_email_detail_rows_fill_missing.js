'use strict';

/**
 * BILLING EMAIL DETAILS, follow-up (GATE_BILLING_EMAIL_DETAILS, dark). Data
 * only. 20260930090000 is already pushed and FROZEN; this fixes one gap it left.
 *
 * 20260930090000 treated ANY reference to {{property_full_address}} in a
 * template's active version as "already done". A template where staff had added
 * only the Property row therefore never got the plan's other rows (payment
 * method, service date, ...). For every template in that plan this adds ONLY
 * the rows still missing, next to the rows that are already there, and leaves
 * everything else as it is:
 *
 *  - A template whose active version is the one 20260930090000 published is
 *    left alone (that migration did the full job; staff have not republished
 *    since), so on a database where it ran cleanly this is a no-op.
 *  - Otherwise a row counts as present when any details row of the active
 *    version already references the plan row's variable, whatever its label.
 *  - Read-modify-write of the live template (admin edits are preserved), the
 *    customer-copy-audit publish pattern: template row locked first, the new
 *    version published by compare-and-swap on the active version, only the
 *    version it replaces archived, allowed/optional variables widened together
 *    with the swap. A template with nothing to add, no active version, a custom
 *    plain-text body, or no block to attach to is left whole and logged.
 *
 * `down` is a documented no-op: a blanket revert would erase admin edits made
 * after this published.
 */

const first = require('./20260930090000_billing_email_detail_rows');

const MIGRATION = '20260930100000';
const MARKER = `migration:${MIGRATION}`;
const FIRST_MARKER = 'migration:20260930090000';

const varOf = (value) => (String(value || '').match(/\{\{\s*([a-z0-9_]+)\s*\}\}/i) || [])[1] || null;

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

const unique = (list) => [...new Set(list)];

function planRows(plan) {
  return (plan.rowsInto || plan.detailsBlock).rows;
}

function presentVariables(blocks) {
  const present = new Set();
  for (const b of blocks) {
    if (b?.type !== 'details' || !Array.isArray(b.rows)) continue;
    for (const row of b.rows) {
      const v = varOf(row?.value);
      if (v) present.add(v);
    }
  }
  return present;
}

// Adds only `missing` plan rows. Returns the new blocks, or null when there is
// no block to attach them to.
function addMissingRows(blocksIn, plan, missing) {
  const blocks = blocksIn.map((b) => (Array.isArray(b?.rows) ? { ...b, rows: b.rows.map((r) => ({ ...r })) } : { ...b }));
  const all = planRows(plan);
  const planVars = all.map((r) => varOf(r.value));
  let at = plan.rowsInto ? first._private.findDetailsBlock(blocks, plan.rowsInto.anchorValue) : -1;
  if (at < 0) {
    at = blocks.findIndex((b) => b?.type === 'details' && Array.isArray(b.rows)
      && b.rows.some((r) => planVars.includes(varOf(r?.value))));
  }
  if (at < 0) {
    // Nothing of the plan is there at all (the first migration skipped this
    // template): attach the whole missing set the way that migration would have.
    if (!plan.detailsBlock) return null;
    return first._private.insertDetailsBlock(blocks, { ...plan.detailsBlock, rows: missing });
  }
  const rows = blocks[at].rows;
  for (const row of missing) {
    const idx = all.findIndex((r) => varOf(r.value) === varOf(row.value));
    let insertAt = -1;
    for (let i = idx - 1; i >= 0 && insertAt < 0; i -= 1) {
      const found = rows.findIndex((r) => varOf(r?.value) === planVars[i]);
      if (found >= 0) insertAt = found + 1;
    }
    if (insertAt < 0 && plan.rowsInto) {
      const afterIndex = rows.findIndex((r) => r?.label === plan.rowsInto.after);
      insertAt = afterIndex >= 0 ? afterIndex + 1 : rows.length;
    }
    if (insertAt < 0) insertAt = plan.rowsInto ? rows.length : 0;
    rows.splice(insertAt, 0, { ...row });
  }
  return blocks;
}

async function fillFixtures(knex, template, plan) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return;
  const fixtures = await knex('email_template_fixtures').where({ template_id: template.id });
  for (const f of fixtures) {
    const payload = json(f.payload, {});
    const next = { ...payload };
    let changed = false;
    for (const [k, v] of Object.entries(plan.fixture)) {
      if (next[k] === undefined) { next[k] = v; changed = true; }
    }
    if (changed) await knex('email_template_fixtures').where({ id: f.id }).update({ payload: JSON.stringify(next), updated_at: new Date() });
  }
}

async function fillPlan(knex, plan) {
  const template = await knex('email_templates').where({ template_key: plan.key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  // The first migration published this version and nobody has republished it:
  // it already carries every row.
  if (json(prior.validation_snapshot, {})?.source === FIRST_MARKER) return 'already';

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${plan.key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  const present = presentVariables(blocks);
  const missing = planRows(plan).filter((r) => !present.has(varOf(r.value)));
  if (!missing.length) return 'already';
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${plan.key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  const nextBlocks = addMissingRows(blocks, plan, missing);
  if (!nextBlocks) {
    console.warn(`[${MARKER}] ${plan.key}: no block to attach the missing rows to; template left as-is`);
    return 'skipped';
  }

  await fillFixtures(knex, template, plan);

  const required = json(template.required_variables, []);
  const allowed = unique([...json(template.allowed_variables, []), ...plan.variables]);
  const optional = unique([...json(template.optional_variables, []), ...plan.variables]).filter((v) => !required.includes(v));
  const now = new Date();
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor({ ...template, allowed_variables: allowed }, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${plan.key}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(nextBlocks),
        text_body: null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${plan.key}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({
      active_version_id: created.id,
      allowed_variables: JSON.stringify(allowed),
      optional_variables: JSON.stringify(optional),
      last_published_at: now,
      updated_at: now,
    });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return 'published';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    for (const plan of first._private.PLANS) results[plan.key] = await fillPlan(trx, plan);
    console.log(`[${MARKER}] ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    if (Object.values(results).includes('published') && await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only publish: a blanket revert would erase admin edits made after it.
};

exports._private = { addMissingRows, presentVariables, varOf };
