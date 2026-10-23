'use strict';

/**
 * ESTIMATE FOLLOW-UP MONTHLY AVERAGE NOTE (owner 2026-10-21, "follow-ups too";
 * GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE, dark). Data only, no schema.
 *
 * The follow-up emails that render the "Estimate" price row can carry the monthly
 * average beside the per-application price. The row itself is the existing
 * {{price_summary}} variable; the one sentence of context ("Averaged over the year.
 * You pay after each application.", plus the bundle / one-time clauses) is the new
 * payload variable {{estimate_average_note}}, filled by the sender only when an
 * average applies. This publishes ONE new active version of each template below with
 * a paragraph block carrying that variable directly after the details block that holds
 * the price row. renderBlocks drops a paragraph whose content renders blank, so with
 * the gate off (or when no average applies) every email renders byte-identical to today:
 *
 *   estimate.unviewed_followup, estimate.viewed_followup,
 *   estimate.followup_final, estimate.expiring_notice
 *
 * Not touched: estimate.extension_notice and estimate.extended (their senders pass no
 * price), the engage_* templates, estimate.deposit_abandoned and
 * estimate.payment_step_abandoned (none render the price row), and estimate.delivery
 * (its context sentence rides in next_step_summary).
 *
 * Same publish pattern as 20261019200000 / 20261019210000: read-modify-write of each live
 * template (admin edits preserved), template row locked first, the new version published
 * by compare-and-swap on the active version, only the version it replaces archived. A
 * template that already references the variable, has no active version, has no details
 * block with the price row, or has a custom plain-text body is left whole and logged,
 * never half-patched. Preview fixtures gain a sample value. `down` is a documented no-op:
 * a blanket revert would erase admin edits made after this published.
 */

const MIGRATION = '20261021010000';
const MARKER = `migration:${MIGRATION}`;

const VARIABLE = 'estimate_average_note';
const NOTE = `{{${VARIABLE}}}`;
const SAMPLE = 'Averaged over the year. You pay after each application.';

const PLANS = [
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'estimate.followup_final',
  'estimate.expiring_notice',
].map((key) => ({ key, variables: [VARIABLE], fixture: { [VARIABLE]: SAMPLE } }));

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

function unique(list) {
  return [...new Set(list)];
}

const referencesVariable = (blocks, name) => JSON.stringify(blocks || []).includes(`{{${name}}}`);
const carriesPriceRow = (block) => block?.type === 'details'
  && (block.rows || []).some((row) => String(row?.value || '').includes('{{price_summary}}'));

// The note goes directly after the details block that holds the price row; null when
// there is none (the template is then left whole).
function insertAverageNote(blocksIn) {
  const at = blocksIn.findIndex(carriesPriceRow);
  if (at < 0) return null;
  const blocks = blocksIn.map((b) => ({ ...b }));
  blocks.splice(at + 1, 0, { type: 'paragraph', content: NOTE });
  return blocks;
}

async function updateFixtures(knex, template, plan) {
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

async function publishPlan(knex, plan) {
  const template = await knex('email_templates').where({ template_key: plan.key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  // Fixtures first: the preview must render the rows whichever way the version
  // publish below goes. Existing values win (admin edits are kept).
  await updateFixtures(knex, template, plan);

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${plan.key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${plan.key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  if (referencesVariable(blocks, VARIABLE)) return 'already';

  const nextBlocks = insertAverageNote(blocks);
  if (!nextBlocks) {
    console.warn(`[${MARKER}] ${plan.key}: no details block carries the price row; template left as-is`);
    return 'skipped';
  }

  const allowed = unique([...json(template.allowed_variables, []), ...plan.variables]);
  const optional = unique([...json(template.optional_variables, []), ...plan.variables]
    .filter((v) => !json(template.required_variables, []).includes(v)));
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
    // Savepoint: the admin editor allocates draft numbers the same way
    // (max + 1, no lock), so a concurrent draft can take this number.
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
      // Widened only together with the swap, so a skipped or raced template is untouched.
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
    for (const plan of PLANS) {
      results[plan.key] = await publishPlan(trx, plan);
    }
    console.log(`[${MARKER}] ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    if (await trx.schema.hasTable('audit_log')) {
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
  // Staff can republish the prior version from the template library.
};

exports._private = { PLANS, insertAverageNote };
