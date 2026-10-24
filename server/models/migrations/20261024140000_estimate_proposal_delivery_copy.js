'use strict';

/**
 * COMMERCIAL PROPOSAL DELIVERY EMAIL COPY (owner approved 2026-10-24, "approve").
 * Data only, no schema.
 *
 * Publishes ONE new active version of `estimate.proposal_delivery`: the old copy told
 * the customer "there is no online checkout" and promised a call back. The new copy
 * says how to get started (reply or call) and what happens next (start date, then the
 * service agreement to sign). The strings below are the owner's, verbatim:
 *
 *   subject  Your pest control proposal from Waves
 *   preview  Your proposal is attached. Here is how to get started.
 *   blocks   paragraph, details (Service / Property / Price), paragraph, cta
 *            "View your proposal", small_note
 *   the template's default_cta_label also becomes "View your proposal"
 *
 * The next-step sentence itself ({{next_step_summary}}) is filled by the sender
 * (PROPOSAL_NEXT_STEP_SUMMARY in server/routes/admin-estimates.js), and the preview
 * fixture gets the same sentence so the admin preview renders it.
 *
 * Read-modify-write of the live template (the 20261019200000 publish pattern): the
 * template row is locked first, the new version is published by compare-and-swap on
 * the active version, only the version it replaces is archived, and an audit_log row
 * records the result. Admin edits are kept where possible: the subject, the preview
 * and each block are replaced only while they still equal the copy this migration
 * supersedes (the 20260619000000 seed); a field or block an admin changed is kept and
 * logged. A template with a custom plain-text body is left whole and logged (the
 * renderer's generated text would no longer match the blocks), never half-patched. A
 * template whose active copy already is the new copy is a no-op, so a re-run
 * publishes nothing. `down` is a documented no-op: a blanket revert would erase admin
 * edits made after this published.
 */

const MIGRATION = '20261024140000';
const MARKER = `migration:${MIGRATION}`;
const KEY = 'estimate.proposal_delivery';

const OLD = {
  subject: 'Your Waves proposal is ready',
  preview: 'Your formal commercial proposal is attached as a PDF.',
  ctaLabel: 'View proposal details',
  nextStep: 'There is no online checkout for a commercial bid — your Waves account manager will follow up to answer questions and finalize the agreement.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your formal Waves proposal is attached to this email as a PDF.' },
    {
      type: 'details',
      rows: [
        { label: 'Service', value: '{{service_summary}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Proposal estimate', value: '{{price_summary}}' },
      ],
    },
    { type: 'paragraph', content: '{{next_step_summary}}' },
    { type: 'cta', label: 'View proposal details', url_variable: 'estimate_url' },
    { type: 'small_note', content: 'Questions? Reply to this email or call (941) 297-5749 and our team will help.' },
  ],
};

const NEXT_STEP = 'To get started, reply to this email or call us at (941) 297-5749. We will confirm your start date and send your service agreement to sign.';

const NEW = {
  subject: 'Your pest control proposal from Waves',
  preview: 'Your proposal is attached. Here is how to get started.',
  ctaLabel: 'View your proposal',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, thank you for calling Waves Pest Control. Your proposal is attached as a PDF, and you can also open it online.' },
    {
      type: 'details',
      rows: [
        { label: 'Service', value: '{{service_summary}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Price', value: '{{price_summary}}' },
      ],
    },
    { type: 'paragraph', content: '{{next_step_summary}}' },
    { type: 'cta', label: 'View your proposal', url_variable: 'estimate_url' },
    { type: 'small_note', content: 'Questions? Reply to this email or call (941) 297-5749.' },
  ],
};

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Key order is not stable: jsonb hands object keys back sorted, so a block read from
// the database must compare equal to the same block written here in another order.
const canonical = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
  : v));
const same = (a, b) => canonical(a) === canonical(b);

// Pure transform. Each block that still equals the superseded copy becomes the new
// block at the same position; a block an admin changed is kept as it is. Returns
// { blocks, replaced, kept } so the caller can log what it left alone.
function replaceSeededBlocks(blocksIn) {
  let replaced = 0;
  let kept = 0;
  const blocks = blocksIn.map((block) => {
    // The next-step paragraph is the same block in the old and the new copy: nothing to do.
    if (NEW.blocks.some((fresh) => same(fresh, block))) return block;
    const at = OLD.blocks.findIndex((old) => same(old, block));
    if (at >= 0) { replaced += 1; return { ...NEW.blocks[at] }; }
    kept += 1;
    return block;
  });
  return { blocks, replaced, kept };
}

async function updateFixtures(knex, template) {
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return;
  const fixtures = await knex('email_template_fixtures').where({ template_id: template.id });
  for (const f of fixtures) {
    const payload = json(f.payload, {});
    // Only the superseded seed sentence is replaced (or an empty one filled); an
    // admin-edited fixture keeps its text.
    const current = payload.next_step_summary;
    if (current !== undefined && current !== null && current !== '' && current !== OLD.nextStep) continue;
    await knex('email_template_fixtures').where({ id: f.id })
      .update({ payload: JSON.stringify({ ...payload, next_step_summary: NEXT_STEP }), updated_at: new Date() });
  }
}

async function publish(knex) {
  const template = await knex('email_templates').where({ template_key: KEY }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  // Fixture first: the preview must render the new sentence whichever way the
  // version publish below goes.
  await updateFixtures(knex, template);

  const blocksIn = json(prior.blocks, null);
  if (!Array.isArray(blocksIn)) {
    console.warn(`[${MARKER}] ${KEY}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${KEY}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }

  const { blocks, replaced, kept } = replaceSeededBlocks(blocksIn);
  const subject = prior.subject === OLD.subject ? NEW.subject : prior.subject;
  const preview = prior.preview_text === OLD.preview ? NEW.preview : prior.preview_text;
  const ctaLabel = template.default_cta_label === OLD.ctaLabel ? NEW.ctaLabel : template.default_cta_label;
  const changed = replaced > 0 || subject !== prior.subject || preview !== prior.preview_text || ctaLabel !== template.default_cta_label;
  if (!changed) {
    if (kept > 0) console.warn(`[${MARKER}] ${KEY}: active copy was edited by an admin; template left as-is`);
    return 'already';
  }
  if (kept > 0 || subject !== NEW.subject || preview !== NEW.preview) {
    console.warn(`[${MARKER}] ${KEY}: admin-edited parts kept (${kept} block(s)${subject !== NEW.subject ? ', subject' : ''}${preview !== NEW.preview ? ', preview' : ''})`);
  }

  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, subject, preview_text: preview, blocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${KEY}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const now = new Date();
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
        subject,
        preview_text: preview,
        blocks: JSON.stringify(blocks),
        text_body: null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${KEY}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({
      active_version_id: created.id,
      default_cta_label: ctaLabel,
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
    const result = await publish(trx);
    console.log(`[${MARKER}] ${KEY}: ${result}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results: { [KEY]: result } },
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

exports._private = { OLD, NEW, NEXT_STEP, KEY, MARKER, replaceSeededBlocks };
