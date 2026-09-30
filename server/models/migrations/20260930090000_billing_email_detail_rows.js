'use strict';

/**
 * BILLING EMAIL DETAILS (owner-approved 2026-09-29; GATE_BILLING_EMAIL_DETAILS,
 * dark). Data only, no schema.
 *
 * The 2026-09-29 audit of production email_messages found the customer's billing
 * emails missing facts the sender had (or could look up). This publishes ONE new
 * active version of each template below, adding detail rows that are driven by
 * variables only the senders fill, and only under the gate — so with the gate
 * off every email renders exactly as it does today (renderBlocks drops a details
 * row whose value is blank, and a details block with no rows left):
 *
 *   invoice.sent           + Property {{property_full_address}}
 *                          + Payment method on file {{payment_method}}
 *                          (its Service and Service date rows already existed;
 *                          the sender now fills them when the invoice row was
 *                          still blank)
 *   invoice.receipt        + Service date {{service_date}}, Property
 *                          {{property_full_address}} (Service and Payment method
 *                          already existed; the sender now fills them for cash,
 *                          check, ACH and other tenders)
 *   billing.notice         + a details block: Property, Service, Service date
 *   billing.receipt_notice + the same, plus Payment method
 *   estimate.engage_expiring, estimate.engage_expiring_unseen,
 *   estimate.engage_gone_quiet, estimate.engage_high_intent,
 *   estimate.engage_return_after_dark, estimate.engage_return_visit,
 *   estimate.engage_unopened, estimate.payment_step_abandoned,
 *   estimate.deposit_abandoned
 *                          + a Property row {{property_full_address}} under the
 *                          greeting (their payload already carried the address;
 *                          no block showed it — 203 sends in the audit)
 *
 * payment.failed needs no template change: it already renders Attempted, Payment
 * method and Next retry rows that the sender left blank.
 *
 * Read-modify-write of each live template (admin edits are preserved), the
 * customer-copy-audit publish pattern: template row locked first, the new
 * version published by compare-and-swap on the active version, only the version
 * it replaces archived. A template that already carries the rows, has no active
 * version, is missing the block the rows attach to, or has a custom plain-text
 * body (the renderer's generated text would no longer carry the new rows) is left
 * whole and logged, never half-patched: its email simply keeps rendering as it
 * does today. Preview fixtures gain sample values so the admin preview shows the
 * rows before the gate is flipped. `down` is a documented no-op — a blanket
 * revert would erase admin edits made after this published.
 */

const MIGRATION = '20260930090000';
const MARKER = `migration:${MIGRATION}`;

const PROPERTY = '{{property_full_address}}';

const EXAMPLE_ADDRESS = '123 Example Street, Bradenton, FL 34205';

// How each template changes. `rows` attach to the details block whose rows
// include `anchorValue` (after the row labelled `after`, else at the end);
// `block` inserts a whole new details block after the paragraph found by
// `afterParagraph` (else index 1).
const PLANS = [
  {
    key: 'invoice.sent',
    variables: ['property_full_address', 'payment_method', 'service_label', 'service_date'],
    rowsInto: {
      anchorValue: '{{invoice_number}}',
      after: 'Service date',
      rows: [
        { label: 'Property', value: PROPERTY },
        { label: 'Payment method on file', value: '{{payment_method}}' },
      ],
    },
    fixture: { property_full_address: EXAMPLE_ADDRESS, payment_method: 'VISA ···· 4242', service_label: 'Quarterly Pest Control Service', service_date: 'September 29, 2026' },
  },
  {
    key: 'invoice.receipt',
    variables: ['property_full_address', 'payment_method', 'service_label', 'service_date'],
    rowsInto: {
      anchorValue: '{{invoice_number}}',
      after: 'Service',
      rows: [
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: PROPERTY },
      ],
    },
    fixture: { property_full_address: EXAMPLE_ADDRESS, payment_method: 'VISA ···· 4242', service_label: 'Quarterly Pest Control Service', service_date: 'September 29, 2026' },
  },
  {
    key: 'billing.notice',
    variables: ['property_full_address', 'service_label', 'service_date'],
    detailsBlock: {
      afterParagraph: '{{notification_body}}',
      rows: [
        { label: 'Property', value: PROPERTY },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Service date', value: '{{service_date}}' },
      ],
    },
    fixture: { property_full_address: EXAMPLE_ADDRESS, service_label: 'Quarterly Pest Control Service', service_date: 'September 29, 2026' },
  },
  {
    key: 'billing.receipt_notice',
    variables: ['property_full_address', 'service_label', 'service_date', 'payment_method'],
    detailsBlock: {
      afterParagraph: '{{notification_body}}',
      rows: [
        { label: 'Property', value: PROPERTY },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Payment method', value: '{{payment_method}}' },
      ],
    },
    fixture: { property_full_address: EXAMPLE_ADDRESS, service_label: 'Quarterly Pest Control Service', service_date: 'September 29, 2026', payment_method: 'VISA ···· 4242' },
  },
  ...[
    'estimate.engage_expiring',
    'estimate.engage_expiring_unseen',
    'estimate.engage_gone_quiet',
    'estimate.engage_high_intent',
    'estimate.engage_return_after_dark',
    'estimate.engage_return_visit',
    'estimate.engage_unopened',
    'estimate.payment_step_abandoned',
    'estimate.deposit_abandoned',
  ].map((key) => ({
    key,
    variables: ['property_full_address'],
    detailsBlock: { afterParagraph: 'Hi {{first_name}}', rows: [{ label: 'Property', value: PROPERTY }] },
    fixture: { property_full_address: EXAMPLE_ADDRESS },
  })),
];

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

// The details block a plan's rows attach to, or -1 when the template was
// reshaped and the anchor is gone.
function findDetailsBlock(blocks, anchorValue) {
  return blocks.findIndex((b) => b?.type === 'details'
    && Array.isArray(b.rows) && b.rows.some((row) => row?.value === anchorValue));
}

function insertRows(blocksIn, spec) {
  const blocks = blocksIn.map((b) => ({ ...b, ...(Array.isArray(b?.rows) ? { rows: b.rows.map((r) => ({ ...r })) } : {}) }));
  const at = findDetailsBlock(blocks, spec.anchorValue);
  if (at < 0) return null;
  const rows = blocks[at].rows;
  const afterIndex = rows.findIndex((row) => row?.label === spec.after);
  const insertAt = afterIndex >= 0 ? afterIndex + 1 : rows.length;
  rows.splice(insertAt, 0, ...spec.rows.map((r) => ({ ...r })));
  return blocks;
}

function insertDetailsBlock(blocksIn, spec) {
  const blocks = blocksIn.map((b) => ({ ...b }));
  const after = blocks.findIndex((b) => b?.type === 'paragraph' && String(b.content || '').includes(spec.afterParagraph));
  if (after < 0 && spec.afterParagraph.startsWith('Hi ')) {
    // Estimate follow-ups open with a greeting; if an admin reworded it the row
    // still goes right under the first block rather than nowhere.
    blocks.splice(Math.min(1, blocks.length), 0, { type: 'details', rows: spec.rows.map((r) => ({ ...r })) });
    return blocks;
  }
  if (after < 0) return null;
  blocks.splice(after + 1, 0, { type: 'details', rows: spec.rows.map((r) => ({ ...r })) });
  return blocks;
}

function nextBlocksFor(plan, blocks) {
  return plan.rowsInto ? insertRows(blocks, plan.rowsInto) : insertDetailsBlock(blocks, plan.detailsBlock);
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
  if (referencesVariable(blocks, 'property_full_address')) return 'already';

  const nextBlocks = nextBlocksFor(plan, blocks);
  if (!nextBlocks) {
    console.warn(`[${MARKER}] ${plan.key}: expected block not found (template was reshaped); template left as-is`);
    return 'skipped';
  }

  const allowed = unique([...json(template.allowed_variables, []), ...plan.variables]);
  const optional = unique([...json(template.optional_variables, []), ...plan.variables]
    .filter((v) => !json(template.required_variables, []).includes(v)));
  const now = new Date();
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: JSON.stringify(allowed),
    optional_variables: JSON.stringify(optional),
    updated_at: now,
  });

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

exports._private = { PLANS, insertRows, insertDetailsBlock, nextBlocksFor, findDetailsBlock };
