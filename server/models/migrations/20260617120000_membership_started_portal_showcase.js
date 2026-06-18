/**
 * Warm up the membership.started welcome email into a portal showcase.
 *
 * The customer has just signed up for a recurring plan — we have already sold
 * them on the service, so this email now invites them to explore the customer
 * portal and shows what they can do there (visits, billing/autopay, requests,
 * notification preferences, referrals, documents). Direct-explore framing.
 *
 * Publishes a new active version of the existing membership.started template,
 * swapping only the content blocks (and CTA label). Subject, preview, and all
 * template-row metadata / variable contracts set by earlier migrations are
 * preserved. No new variables are introduced — every placeholder used here is
 * already in the template's allowed set. Mirrors the publish/archive mechanics
 * of 20260526000012_deepen_account_portal_email_templates.js.
 */

const TEMPLATE_KEY = 'membership.started';

const NEW_BLOCKS = [
  { type: 'paragraph', content: 'Hello {{first_name}}, your Waves membership is active — welcome aboard!' },
  { type: 'paragraph', content: 'Here is the membership information we have on file.' },
  { type: 'details', rows: [
    { label: 'Plan', value: '{{membership_name}}' },
    { label: 'Status', value: '{{membership_status}}' },
    { label: 'Effective date', value: '{{effective_date}}' },
    { label: 'Rate', value: '{{monthly_rate}}' },
    { label: 'Billing cadence', value: '{{billing_cadence}}' },
    { label: 'Included services', value: '{{included_services}}' },
  ] },
  { type: 'paragraph', content: 'Your customer portal is ready whenever you are. Take a look around — from any device you can:' },
  { type: 'callout', content: 'See upcoming visits and reschedule in a tap · View invoices, pay online, and turn on autopay · Request a re-service or add a service · Choose your notification preferences · Refer friends and earn $25 · Find your service reports, invoices, and agreements' },
  { type: 'cta', label: 'Explore your portal', url_variable: 'customer_portal_url' },
  { type: 'small_note', content: 'Questions about what is included? Reply here and we will review it with you.' },
];

async function publishBlocks(knex, templateKey, blocks) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template) return;

  // Preserve subject/preview from the currently ACTIVE version — not merely the
  // highest version_number, which can be an unapproved draft (the template
  // library supports draft versions). Prefer the template's own
  // active_version_id, falling back to the newest active-status row.
  const active = (template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null)
    || await knex('email_template_versions')
      .where({ template_id: template.id, status: 'active' })
      .orderBy('version_number', 'desc')
      .first();

  // The next version number must clear EVERY existing version, drafts included.
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: active?.subject || 'Your Waves membership is active',
    preview_text: active?.preview_text ?? null,
    blocks: JSON.stringify(blocks),
    text_body: null,
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    status: 'active',
    last_published_at: new Date(),
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  await publishBlocks(knex, TEMPLATE_KEY, NEW_BLOCKS);
};

exports.down = async function down() {
  // Historical template versions are intentionally retained, matching the
  // established account/membership email migrations. To revert, republish a
  // prior version from the email template admin.
};
