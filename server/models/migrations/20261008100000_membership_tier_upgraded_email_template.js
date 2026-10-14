'use strict';

/**
 * Seeds ONE new email template, membership.tier_upgraded: "your WaveGuard
 * plan moved up" (owner-approved copy 2026-10-08).
 *
 * Sent by AccountMembershipEmail.sendMembershipTierUpgraded, today only from
 * a confirmed Intelligence Bar update_customer card that raises the tier and
 * changes the billed monthly rate (GATE_IB_TIER_UPGRADE_EMAIL, dark). The
 * customer page keeps using membership.updated, which this does not touch.
 *
 * Every figure is filled by the sender from the pricing constants, never
 * typed here: the tier's recurring discount, the recurring-customer one-time
 * perk, and the per-palm credit. Two slots are whole lines the sender leaves
 * blank when they would be untrue, and the library drops them: the palm
 * credit line (a list item that resolves blank) below the tier that earns the
 * credit, and the rate sentence (a paragraph that resolves blank) when no
 * rate moved. The rate sentence shows a monthly figure only to a customer
 * who is billed monthly.
 *
 * A NEW key, seeded directly (same convention as 20261001200000 and
 * 20260926000103). Idempotent: the version is seeded only when the template
 * has no active version, so a re-run never overwrites an operator's edits.
 * The seed writes one audit_log event (email_template.seeded).
 * down() is a documented NO-OP: once seeded the template is admin-editable,
 * and removing it on rollback would destroy those edits; the sender is dark
 * behind its gate, so an unused template row is inert.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const KEY = 'membership.tier_upgraded';

const TEMPLATE = {
  key: KEY,
  name: 'WaveGuard Tier Upgraded',
  description: 'Tells a member their WaveGuard plan moved up a tier: what the new tier includes (figures filled from the pricing constants) and their rate in their own billing terms. Sent after a confirmed Intelligence Bar customer update that raises the tier and changes the billed monthly rate (GATE_IB_TIER_UPGRADE_EMAIL).',
  subject: 'Your WaveGuard plan is now {{new_membership_tier}}',
  preview: 'Your WaveGuard plan moved up. Here is what it includes.',
  required: ['first_name', 'old_membership_tier', 'new_membership_tier', 'recurring_discount_pct', 'one_time_discount_pct'],
  optional: ['palm_credit_line', 'rate_sentence'],
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}},' },
    { type: 'paragraph', content: 'Good news: your WaveGuard plan moved up from {{old_membership_tier}} to {{new_membership_tier}}.' },
    { type: 'heading', content: 'What {{new_membership_tier}} includes' },
    { type: 'list', items: [
      '{{recurring_discount_pct}}% off each recurring service in your plan (pest control, lawn care, tree & shrub, mosquito, termite bait and rodent bait)',
      "{{one_time_discount_pct}}% off one-time services, like a roach clean-out or a special treatment, because you're a recurring customer",
      '{{palm_credit_line}}',
    ] },
    { type: 'paragraph', content: '{{rate_sentence}}' },
    { type: 'paragraph', content: 'Nothing else changes. Same technician, same schedule.' },
    { type: 'paragraph', content: 'Questions? Just reply to this email.' },
  ],
  fixture: {
    name: 'Bronze to Gold, billed monthly',
    payload: {
      first_name: 'Taylor',
      old_membership_tier: 'Bronze',
      new_membership_tier: 'Gold',
      recurring_discount_pct: '15',
      one_time_discount_pct: '15',
      palm_credit_line: 'A $10 per palm credit each year on palm injections',
      rate_sentence: 'Your monthly rate: $85.00 (was $100.00)',
    },
  },
};

function templateRow(t) {
  const required = [...new Set(t.required)];
  const allowed = [...new Set([...required, ...t.optional])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'membership',
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
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    updated_at: new Date(),
  };
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  let template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template) {
    [template] = await knex('email_templates').insert({ ...templateRow(TEMPLATE), created_at: new Date() }).returning('*');
  }
  if (template.active_version_id) return; // seeded already: never overwrite operator edits
  const latest = await knex('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: Number(latest?.max || 0) + 1,
    status: 'active',
    subject: TEMPLATE.subject,
    preview_text: TEMPLATE.preview,
    blocks: JSON.stringify(TEMPLATE.blocks),
    text_body: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const hasFixture = await knex('email_template_fixtures').where({ template_id: template.id }).first('id');
    if (!hasFixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: TEMPLATE.fixture.name,
        is_default: true,
        payload: JSON.stringify(TEMPLATE.fixture.payload),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
  // audit_log is append-only and written through services/audit-log.js.
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: KEY, versionId: version.id, migration: '20261008100000_membership_tier_upgraded_email_template' },
      trx: knex,
      critical: true,
    });
  }
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports._private = { TEMPLATE, KEY, templateRow };
