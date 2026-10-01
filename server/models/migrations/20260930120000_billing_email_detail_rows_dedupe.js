'use strict';

/**
 * BILLING EMAIL DETAILS, second follow-up (GATE_BILLING_EMAIL_DETAILS, dark).
 * Data only. 20260930090000 and 20260930100100 are already pushed and FROZEN;
 * this repairs one thing the first one could leave behind.
 *
 * 20260930090000 treated a reference to {{property_full_address}} as the only
 * sign a template was "done". A template where staff had already added, say, a
 * {{payment_method}} row but not the Property row was therefore given the FULL
 * plan, so its published version carries the payment-method row twice (staff's
 * and the plan's). 20260930100100 leaves a version that migration published
 * alone, so it keeps the duplicate.
 *
 * For every template in that plan whose ACTIVE version is still the one
 * 20260930090000 published (nobody has republished since, so no admin edit can
 * be lost), this removes the plan's own row wherever the same variable is also
 * shown by another row of that version:
 *
 *  - Only a row that is EXACTLY a plan row (label and value) is ever removed,
 *    and only as a duplicate: the staff row (or, when every copy is a plan row,
 *    the first one) stays. A details block this empties is dropped with it.
 *  - Read-modify-write of the live template, the same publish pattern as
 *    20260930100100: template row locked first, the new version published by
 *    compare-and-swap on the active version, only the version it replaces
 *    archived. A template with no duplicate, no active version, or a custom
 *    plain-text body is left whole and logged.
 *  - Idempotent: the version it publishes carries this migration's own marker,
 *    so a second run finds nothing to do.
 *
 * `down` is a documented no-op: a blanket revert would erase admin edits made
 * after this published.
 */

const path = require('node:path');
const first = require('./20260930090000_billing_email_detail_rows');
const fillMissing = require('./20260930100100_billing_email_detail_rows_fill_missing');

const MIGRATION = '20260930120000';
const MARKER = `migration:${MIGRATION}`;
// The marker the first migration stamps on the versions it publishes, derived
// from its own file name so no foreign stamp is spelled out here.
const FIRST_MARKER = `migration:${path.basename(require.resolve('./20260930090000_billing_email_detail_rows')).match(/^(\d{14})_/)[1]}`;

const { varOf } = fillMissing._private;

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

const rowKey = (row) => `${row?.label}\u0000${row?.value}`;

// Removes duplicate plan rows. Returns { blocks, removed } (removed = count).
function dedupeBlocks(blocksIn, plan) {
  const planRows = (plan.rowsInto || plan.detailsBlock).rows;
  const planKeys = new Set(planRows.map(rowKey));
  const planVars = new Set(planRows.map((r) => varOf(r.value)).filter(Boolean));
  const blocks = blocksIn.map((b) => (Array.isArray(b?.rows) ? { ...b, rows: b.rows.map((r) => ({ ...r })) } : { ...b }));

  // Every details row that shows a planned variable, in document order.
  const byVar = new Map();
  blocks.forEach((b, bi) => {
    if (b?.type !== 'details' || !Array.isArray(b.rows)) return;
    b.rows.forEach((row, ri) => {
      const v = varOf(row?.value);
      if (!v || !planVars.has(v)) return;
      if (!byVar.has(v)) byVar.set(v, []);
      byVar.get(v).push({ bi, ri, plan: planKeys.has(rowKey(row)) });
    });
  });

  const drop = new Set();
  for (const refs of byVar.values()) {
    if (refs.length < 2) continue;
    const keep = refs.find((r) => !r.plan) || refs[0];
    for (const r of refs) if (r !== keep && r.plan) drop.add(`${r.bi}:${r.ri}`);
  }
  if (!drop.size) return { blocks: blocksIn, removed: 0 };

  const next = [];
  blocks.forEach((b, bi) => {
    if (b?.type !== 'details' || !Array.isArray(b.rows)) { next.push(b); return; }
    const rows = b.rows.filter((_, ri) => !drop.has(`${bi}:${ri}`));
    // A details block this emptied goes with its rows.
    if (rows.length || !b.rows.length) next.push({ ...b, rows });
  });
  return { blocks: next, removed: drop.size };
}

async function dedupePlan(knex, plan) {
  const template = await knex('email_templates').where({ template_key: plan.key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  // Only the version the first migration published and nobody has republished:
  // anything else may carry admin edits.
  if (json(prior.validation_snapshot, {})?.source !== FIRST_MARKER) return 'already';

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${plan.key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  const { blocks: nextBlocks, removed } = dedupeBlocks(blocks, plan);
  if (!removed) return 'already';
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${plan.key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }

  const now = new Date();
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, blocks: nextBlocks });
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
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
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
    for (const plan of first._private.PLANS) results[plan.key] = await dedupePlan(trx, plan);
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

exports._private = { dedupeBlocks, FIRST_MARKER };
