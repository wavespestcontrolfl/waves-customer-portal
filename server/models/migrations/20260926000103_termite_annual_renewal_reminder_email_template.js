'use strict';

// Termite annual plan — renewal-notice ladder, slice 5 ("notice ladder").
// The email leg of the 45/30-day termite-specific renewal notice
// (AccountMembershipEmail.sendTermiteRenewalReminder) — sent as the SMS
// fallback (no phone / SMS blocked) and always as a best-effort companion
// send after a successful SMS, same as membership.renewal_reminder. 15/7
// days out keep using membership.renewal_reminder even for a termite term;
// this key is only ever reached from the 45/30-day termite branch.
//
// Seeded directly (same convention as 20260926000100_billing_receipt_notice_
// email_template.js) rather than folded into the TEMPLATES array in
// 20260521000003_seed_account_membership_email_templates.js — this is a NEW
// key, not a revision of an existing one, so there is no earlier deployed
// shape to preserve or replay.
//
// The last-inspection sentence is a single optional paragraph block whose
// entire content is the `last_inspection_sentence` variable (empty when no
// annual-inspection date is tracked yet — always today, see
// account-membership-email.js) — renderBlocks drops a paragraph block whose
// resolved content is empty, so the sentence disappears cleanly instead of
// rendering "Your last annual inspection: ." with a blank date.
const KEY = 'membership.termite_renewal_reminder';
const SERVICE_FROM = process.env.SERVICE_EMAIL_FROM || 'contact@wavespestcontrol.com';

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions', 'email_template_fixtures']) {
    if (!await knex.schema.hasTable(table)) return;
  }
  if (await knex('email_templates').where({ template_key: KEY }).first('id')) return;

  const [template] = await knex('email_templates').insert({
    template_key: KEY,
    name: 'Termite annual renewal reminder',
    mode: 'service',
    purpose: 'membership',
    description: 'Termite annual plan (Waves Subterranean Termite Protection) 45/30-day renewal notice — discloses the auto-renew charge and the cancel-request link (owner ruling A-13).',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'account',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    status: 'active',
    allowed_variables: JSON.stringify([
      'first_name', 'address', 'new_start', 'new_end', 'renewal_fee', 'renewal_date',
      'cancel_link', 'last_inspection_sentence',
    ]),
    required_variables: JSON.stringify([
      'first_name', 'address', 'new_start', 'new_end', 'renewal_fee', 'renewal_date', 'cancel_link',
    ]),
    optional_variables: JSON.stringify(['last_inspection_sentence']),
    default_cta_label: 'Cancel online',
    default_cta_url_variable: 'cancel_link',
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: 'Your termite protection renews {{renewal_date}}',
    preview_text: 'Your Waves Subterranean Termite Protection renewal is coming up.',
    blocks: JSON.stringify([
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves Subterranean Termite Protection at {{address}} is coming up for renewal.' },
      { type: 'details', rows: [
        { label: 'Coverage period', value: '{{new_start}} – {{new_end}}' },
        { label: 'Renewal fee', value: '{{renewal_fee}}' },
        { label: 'Charged on', value: '{{renewal_date}}' },
      ] },
      { type: 'paragraph', content: 'This plan renews automatically and charges the payment method on file unless you cancel before {{renewal_date}}.' },
      { type: 'paragraph', content: 'Cancel online any time using the button below, or reply to this email.' },
      { type: 'paragraph', content: '{{last_inspection_sentence}}' },
      { type: 'cta', label: 'Cancel online', url_variable: 'cancel_link' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ]),
    published_at: knex.fn.now(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('id');

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: knex.fn.now(),
  });
  await knex('email_template_fixtures').insert({
    template_id: template.id,
    name: 'Termite annual renewal (no prior inspection on file)',
    is_default: true,
    payload: JSON.stringify({
      first_name: 'Stan',
      address: '123 Bayshore Rd, Bradenton, FL 34205',
      new_start: 'January 5, 2027',
      new_end: 'January 5, 2028',
      renewal_fee: '$650.00',
      renewal_date: 'January 5, 2027',
      cancel_link: 'https://portal.wavespestcontrol.com/?tab=plan',
      last_inspection_sentence: '',
    }),
    created_at: new Date(),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: KEY, migration: '20260926000103_termite_annual_renewal_reminder_email_template' },
      trx: knex,
      critical: true,
    });
  }
};

// Template versions may have delivery history or operator edits. Preserve them.
exports.down = async function down() {};
