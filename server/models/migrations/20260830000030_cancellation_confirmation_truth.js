'use strict';

/**
 * Cancellation confirmation copy — make it true (H0, 2026-08-30).
 *
 * POST /api/requests runs the cancellation processor SYNCHRONOUSLY (owner
 * directive: churn on submit), so the customer's plan is already closed by
 * the time the confirmation text goes out. The seeded copy still said "we
 * received your request and will follow up to confirm" — a promise nobody
 * was going to keep, and the wrong message for an account that is gone.
 *
 * - service_cancellation_confirmation → now sent ONLY when the processor
 *   fully completed: says the plan is cancelled as of today.
 * - service_cancellation_received (NEW) → sent when processing was partial
 *   (in-progress visit, processor error): keeps the "closing it out by hand"
 *   wording, which is the truth in that case.
 * - account.cancellation_received email (SMS-undeliverable fallback, sent in
 *   both cases) → gains an {{outcome_line}} the sender fills from the
 *   processor result, so one template is accurate either way. Rewritten only
 *   when the active version still carries the seeded copy.
 *
 * Body rewrites match the last seeded body (house-voice sweep
 * 20260801000001) or the original; an admin-edited body is left alone.
 */

const CONFIRMATION_KEY = 'service_cancellation_confirmation';
const CONFIRMATION_PRIOR_BODIES = [
  'Hello {first_name}! We got your cancellation request and will follow up to confirm.',
  'Hello {first_name}! We received your cancellation request. Our team will process it and follow up to confirm. Questions? Reply here.',
];
// {effective_date} is the ET date of the request (requests.js): a text held
// past the 8 PM quiet hour goes out the next morning and must not say
// "today".
const CONFIRMATION_BODY =
  'Hello {first_name}! Your Waves plan is cancelled as of {effective_date}. Upcoming visits are off the calendar and autopay is off. Nothing more is charged for future service; a visit already inside its late-cancellation window keeps its scheduled-visit fee. Changed your mind or have a question? Reply here.';
const CONFIRMATION_VARIABLES = ['first_name', 'effective_date'];
const CONFIRMATION_PRIOR_VARIABLES = ['first_name'];

const RECEIVED_TEMPLATE = {
  template_key: 'service_cancellation_received',
  name: 'Cancellation Received (office follow-up)',
  category: 'automations',
  // Outcome-neutral on purpose: this key is chosen when processing did NOT
  // fully complete, so it must not claim billing or visits have stopped.
  body:
    'Hello {first_name}! We got your cancellation request and are closing out your plan by hand. You will hear from us within 1 business day to confirm exactly what has stopped.',
  variables: ['first_name'],
  sort_order: 121,
};

const EMAIL_KEY = 'account.cancellation_received';
// Exact seeded content from 20260701000003 — the rewrite only applies when
// the active version still carries it (operator edits are left alone).
const EMAIL_PRIOR_PREVIEW = 'Our team will follow up to confirm.';
const EMAIL_PRIOR_BLOCKS = [
  { type: 'paragraph', content: 'Hello {{first_name}},' },
  { type: 'paragraph', content: 'We received your cancellation request and sent it to the Waves team. Our team will follow up to confirm the details with you.' },
  { type: 'details', rows: [
    { label: 'Request', value: '{{request_subject}}' },
    { label: 'Submitted', value: '{{submitted_at}}' },
  ] },
  { type: 'paragraph', content: 'If you have questions — or did not make this request — reply to this email or call us at {{company_phone}}.' },
  { type: 'signature', content: 'Thank you, The Waves Team' },
];
const EMAIL_PREVIEW = 'Your cancellation request, and what happens next.';
// {{outcome_line}} is set by account-membership-email.sendCancellationReceived
// from the processor result, so one template stays true in both cases.
const EMAIL_BLOCKS = [
  { type: 'paragraph', content: 'Hello {{first_name}},' },
  { type: 'paragraph', content: 'We received your cancellation request. {{outcome_line}}' },
  { type: 'details', rows: [
    { label: 'Request', value: '{{request_subject}}' },
    { label: 'Submitted', value: '{{submitted_at}}' },
  ] },
  { type: 'paragraph', content: 'Questions — or did not make this request? Reply to this email or call us at {{company_phone}}.' },
  { type: 'signature', content: 'Thank you, The Waves Team' },
];
const EMAIL_NEW_VARIABLE = 'outcome_line';

function sameJson(a, b) {
  try {
    const norm = (v) => JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v);
    return norm(a) === norm(b);
  } catch (err) {
    return false;
  }
}

function parseList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch (err) { return []; }
  }
  return [];
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    if (cols.body) {
      const patch = { body: CONFIRMATION_BODY };
      if (cols.updated_at) patch.updated_at = new Date();
      if (cols.variables) patch.variables = JSON.stringify(CONFIRMATION_VARIABLES);
      await knex('sms_templates')
        .where({ template_key: CONFIRMATION_KEY })
        .whereIn('body', CONFIRMATION_PRIOR_BODIES)
        .update(patch);

      // Variants: getTemplate may pick an active sms_template_variants row for
      // the same key, and any variant still carries the "request received /
      // we'll follow up" meaning. Rewrite the ones that match the seeded
      // copy; RETIRE every other active variant of this outcome-critical key
      // (an A/B body must never undo the truth gate). Retired rows are kept
      // with a metadata marker so they can be recognised and restored.
      if (await knex.schema.hasTable('sms_template_variants')) {
        const vcols = await knex('sms_template_variants').columnInfo();
        if (vcols.body) {
          const vpatch = { body: CONFIRMATION_BODY };
          if (vcols.updated_at) vpatch.updated_at = new Date();
          await knex('sms_template_variants')
            .where({ template_key: CONFIRMATION_KEY })
            .whereIn('body', CONFIRMATION_PRIOR_BODIES)
            .update(vpatch);
          if (vcols.status) {
            const stale = await knex('sms_template_variants')
              .where({ template_key: CONFIRMATION_KEY, status: 'active' })
              .whereNot({ body: CONFIRMATION_BODY })
              .select('id', 'metadata');
            for (const row of stale) {
              let meta = {};
              try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch (err) { meta = {}; }
              const rpatch = { status: 'retired' };
              if (vcols.metadata) rpatch.metadata = JSON.stringify({ ...meta, retired_by: '20260830000030_cancellation_confirmation_truth' });
              if (vcols.updated_at) rpatch.updated_at = new Date();
              await knex('sms_template_variants').where({ id: row.id }).update(rpatch);
            }
          }
        }
      }

      const existing = await knex('sms_templates')
        .where({ template_key: RECEIVED_TEMPLATE.template_key })
        .first('id');
      if (!existing) {
        const row = {
          template_key: RECEIVED_TEMPLATE.template_key,
          name: RECEIVED_TEMPLATE.name,
          body: RECEIVED_TEMPLATE.body,
        };
        if (cols.category) row.category = RECEIVED_TEMPLATE.category;
        if (cols.variables) row.variables = JSON.stringify(RECEIVED_TEMPLATE.variables);
        if (cols.sort_order) row.sort_order = RECEIVED_TEMPLATE.sort_order;
        if (cols.is_active) row.is_active = true;
        if (cols.created_at) row.created_at = new Date();
        if (cols.updated_at) row.updated_at = new Date();
        await knex('sms_templates').insert(row);
      }
    }
  }

  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    const template = await knex('email_templates')
      .where({ template_key: EMAIL_KEY })
      .first('id', 'active_version_id', 'allowed_variables', 'optional_variables');
    const version = template && template.active_version_id
      ? await knex('email_template_versions').where({ id: template.active_version_id }).first('id', 'blocks', 'preview_text')
      : null;
    // Only rewrite the exact seeded copy. Anything else is an operator edit
    // and is left in place (the new variable is still registered so a later
    // hand edit can use it).
    if (version && sameJson(version.blocks, EMAIL_PRIOR_BLOCKS)) {
      await knex('email_template_versions').where({ id: version.id }).update({
        preview_text: EMAIL_PREVIEW,
        blocks: JSON.stringify(EMAIL_BLOCKS),
        published_at: new Date(),
        updated_at: new Date(),
      });
    }
    if (template) {
      const allowed = parseList(template.allowed_variables);
      const optional = parseList(template.optional_variables);
      const patch = { updated_at: new Date() };
      if (!allowed.includes(EMAIL_NEW_VARIABLE)) patch.allowed_variables = JSON.stringify([...allowed, EMAIL_NEW_VARIABLE]);
      if (!optional.includes(EMAIL_NEW_VARIABLE)) patch.optional_variables = JSON.stringify([...optional, EMAIL_NEW_VARIABLE]);
      if (version && sameJson(version.blocks, EMAIL_PRIOR_BLOCKS)) patch.last_published_at = new Date();
      await knex('email_templates').where({ id: template.id }).update(patch);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    if (cols.body) {
      const patch = { body: CONFIRMATION_PRIOR_BODIES[0] };
      if (cols.updated_at) patch.updated_at = new Date();
      if (cols.variables) patch.variables = JSON.stringify(CONFIRMATION_PRIOR_VARIABLES);
      await knex('sms_templates')
        .where({ template_key: CONFIRMATION_KEY, body: CONFIRMATION_BODY })
        .update(patch);
    }
    // Only the row this migration seeded (unchanged body) is removed.
    await knex('sms_templates')
      .where({ template_key: RECEIVED_TEMPLATE.template_key, body: RECEIVED_TEMPLATE.body })
      .del();
    if (await knex.schema.hasTable('sms_template_variants')) {
      const vcols = await knex('sms_template_variants').columnInfo();
      if (vcols.body) {
        const vpatch = { body: CONFIRMATION_PRIOR_BODIES[0] };
        if (vcols.updated_at) vpatch.updated_at = new Date();
        await knex('sms_template_variants')
          .where({ template_key: CONFIRMATION_KEY, body: CONFIRMATION_BODY })
          .update(vpatch);
        if (vcols.status && vcols.metadata) {
          await knex('sms_template_variants')
            .where({ template_key: CONFIRMATION_KEY, status: 'retired' })
            .whereRaw("metadata->>'retired_by' = ?", ['20260830000030_cancellation_confirmation_truth'])
            .update({ status: 'active', ...(vcols.updated_at ? { updated_at: new Date() } : {}) });
        }
      }
    }
  }
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    const template = await knex('email_templates').where({ template_key: EMAIL_KEY }).first('id', 'active_version_id');
    const version = template && template.active_version_id
      ? await knex('email_template_versions').where({ id: template.active_version_id }).first('id', 'blocks')
      : null;
    if (version && sameJson(version.blocks, EMAIL_BLOCKS)) {
      await knex('email_template_versions').where({ id: version.id }).update({
        preview_text: EMAIL_PRIOR_PREVIEW,
        blocks: JSON.stringify(EMAIL_PRIOR_BLOCKS),
        updated_at: new Date(),
      });
    }
  }
};
