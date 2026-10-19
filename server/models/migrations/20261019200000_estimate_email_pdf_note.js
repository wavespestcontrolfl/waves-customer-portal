'use strict';

/**
 * ESTIMATE PDF COPY NOTE (owner ask 2026-10-19; GATE_ESTIMATE_EMAIL_PDF, dark).
 * Data only, no schema.
 *
 * "Attach a pdf version of the estimates to all outgoing emails for customers who
 * can't open the estimate." When the gate is on, the open-estimate emails carry the
 * estimate as a PDF attachment, and one line under the button tells the customer so
 * ("Can't open the link? A PDF copy of this estimate is attached ..."). The line is
 * the payload variable {{estimate_pdf_note}}, filled by the senders only when the PDF
 * is really attached. This publishes ONE new active version of each template below
 * with a small_note block carrying that variable directly after the first (non-link)
 * button. renderBlocks drops a small_note whose content renders blank, so with the
 * gate off, or when the PDF could not be built, every email renders byte-identical
 * to today:
 *
 *   estimate.delivery, estimate.unviewed_followup, estimate.viewed_followup,
 *   estimate.followup_final, estimate.expiring_notice, estimate.engage_unopened,
 *   estimate.engage_gone_quiet, estimate.engage_expiring,
 *   estimate.engage_expiring_unseen, estimate.engage_high_intent,
 *   estimate.engage_return_visit, estimate.engage_return_after_dark,
 *   estimate.extended, estimate.extension_notice
 *
 * Never touched: estimate.proposal_delivery (the commercial proposal already carries
 * its PDF), estimate.deposit_abandoned, estimate.payment_step_abandoned and the
 * accepted_* mails (money or accepted estimates, not open ones).
 *
 * Read-modify-write of each live template (admin edits are preserved), the
 * billing-email-details publish pattern (20260930090000): template row locked first,
 * the new version published by compare-and-swap on the active version, only the
 * version it replaces archived. A template that already references the variable, has
 * no active version, or has a custom plain-text body (the renderer's generated text
 * would no longer carry the line) is left whole and logged, never half-patched: its
 * email keeps rendering as it does today. Preview fixtures gain a sample value so the
 * admin preview shows the line. `down` is a documented no-op: a blanket revert would
 * erase admin edits made after this published.
 */

const MIGRATION = '20261019200000';
const MARKER = `migration:${MIGRATION}`;

const NOTE = '{{estimate_pdf_note}}';

const DELIVERY_NOTE = "Can't open the link? A PDF copy of this estimate is attached. To go ahead, reply to this email or call (941) 297-5749 and we'll set your first visit.";
const FOLLOW_UP_NOTE = "Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 to get started.";

const PLANS = [
  { key: 'estimate.delivery', fixture: { estimate_pdf_note: DELIVERY_NOTE } },
  ...[
    'estimate.unviewed_followup',
    'estimate.viewed_followup',
    'estimate.followup_final',
    'estimate.expiring_notice',
    'estimate.engage_unopened',
    'estimate.engage_gone_quiet',
    'estimate.engage_expiring',
    'estimate.engage_expiring_unseen',
    'estimate.engage_high_intent',
    'estimate.engage_return_visit',
    'estimate.engage_return_after_dark',
    'estimate.extended',
    'estimate.extension_notice',
  ].map((key) => ({ key, fixture: { estimate_pdf_note: FOLLOW_UP_NOTE } })),
].map((plan) => ({ ...plan, variables: ['estimate_pdf_note'] }));

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

// The note goes directly after the first non-link button (a "link" variant is a
// quiet text link, like the gone-quiet consultation offer), else after the first
// button of any kind, else at the end of the email.
function insertPdfNote(blocksIn) {
  const blocks = blocksIn.map((b) => ({ ...b }));
  let at = blocks.findIndex((b) => b?.type === 'cta' && b.variant !== 'link');
  if (at < 0) at = blocks.findIndex((b) => b?.type === 'cta');
  const note = { type: 'small_note', content: NOTE };
  if (at < 0) blocks.push(note);
  else blocks.splice(at + 1, 0, note);
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
  if (referencesVariable(blocks, 'estimate_pdf_note')) return 'already';

  const nextBlocks = insertPdfNote(blocks);

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

exports._private = { PLANS, insertPdfNote };
