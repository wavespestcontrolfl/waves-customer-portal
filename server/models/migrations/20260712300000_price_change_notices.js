/**
 * Price-change notice workflow (owner policy 2026-07-12).
 *
 * Waves' recurring service has NO fixed term, so "renewal" notices are
 * retired (GATE_SERVICE_RENEWAL_ENROLL is off). What customers get instead
 * is a formal ADVANCE NOTICE whenever their price changes: a short email +
 * SMS 30-45 days before the first affected charge, each carrying a tokened
 * link to a full notice page (current price, new price, effective date,
 * what stays the same, no action needed, cancel anytime).
 *
 * This migration ships:
 *   1. price_change_notices — one row per customer per change event
 *      (batch_id groups an event), carrying the page token and delivery
 *      state. Delivery records live here + email/sms logs.
 *   2. billing.price_change_notice email template (Email Template Library,
 *      service_operational stream — a billing-terms notice must always
 *      deliver). Short body + CTA button per owner wording; NEVER uses
 *      "renewal" language.
 *   3. price_change_notice SMS template (editable in SMS Templates admin).
 *
 * Idempotent: table guarded by hasTable; the email upsert seeds this copy
 * only when no active version exists — a re-run reactivates but never
 * overwrites an existing version's subject/blocks (operator edits are
 * preserved, per the seeded-row house rule); SMS seed is onConflict-ignore.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const EMAIL_TEMPLATE = {
  key: 'billing.price_change_notice',
  name: 'Price Change Advance Notice',
  description: 'Formal advance notice of a recurring-service price change — short email with a button to the full tokened notice page. Never uses renewal language.',
  category: 'billing',
  subject: 'An update to your recurring service pricing',
  preview: 'Clear advance notice of a price adjustment — no action needed.',
  required: ['first_name', 'current_price', 'new_price', 'effective_date', 'cadence_label', 'price_change_url'],
  optional: ['company_phone', 'company_email'],
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: 'Thank you for trusting Waves Pest Control to protect your home. We want to give you clear advance notice: beginning {{effective_date}}, the price of your recurring service will change from {{current_price}} to {{new_price}} per {{cadence_label}}.' },
    { type: 'details', rows: [
      { label: 'Current price', value: '{{current_price}} / {{cadence_label}}' },
      { label: 'New price', value: '{{new_price}} / {{cadence_label}}' },
      { label: 'Effective date', value: '{{effective_date}}' },
    ] },
    { type: 'paragraph', content: 'Your service frequency and included protection stay exactly the same. No action is needed to continue your service — and as always, Waves does not require a long-term contract, so you can make changes or cancel your recurring service at any time.' },
    { type: 'cta', label: 'View the full notice', url_variable: 'price_change_url' },
    { type: 'small_note', content: 'Questions? Reply to this email or give us a call — we are happy to walk through it.' },
    { type: 'signature', content: 'Thank you for being a valued Waves customer, The Waves Team' },
  ],
};

const SMS_TEMPLATE = {
  template_key: 'price_change_notice',
  name: 'Price Change Advance Notice',
  category: 'billing',
  // GSM-7 only (no em dashes / smart punctuation) and short enough to stay
  // within 2 SMS segments with a rendered date + notice URL — this goes to
  // batches of up to 2,000 customers, so a UCS-2 flip is a real cost spike.
  body: 'Hi {first_name}, a heads-up from Waves: your recurring service price changes on {effective_date}. Details: {price_change_url}\nNo action needed. Reply with questions, or STOP to opt out.',
  description: 'SMS leg of the price-change advance notice; links to the tokened notice page.',
  variables: JSON.stringify(['first_name', 'effective_date', 'price_change_url']),
  is_active: true,
  is_internal: false,
  sort_order: 110,
};

function templateRow(t) {
  const allowed = [...new Set([...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'service',
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
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

async function upsertEmailTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    // Re-run: reactivate only. The version's subject/blocks may carry
    // operator edits — never overwrite them from a seed.
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('price_change_notices'))) {
    await knex.schema.createTable('price_change_notices', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // One batch = one price-change event confirmed by the operator.
      t.uuid('batch_id').notNullable();
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.integer('current_amount_cents').notNullable();
      t.integer('new_amount_cents').notNullable();
      // Display unit for the price ("month" today — monthly_rate is the
      // billed unit; kept as a column so future per-application or quarterly
      // notices don't need a schema change).
      t.string('cadence_label', 40).notNullable().defaultTo('month');
      t.date('effective_date').notNullable();
      t.string('notice_token', 64).notNullable().unique();
      t.string('status', 20).notNullable().defaultTo('draft'); // draft | sent | viewed
      t.boolean('email_sent').notNullable().defaultTo(false);
      t.boolean('sms_sent').notNullable().defaultTo(false);
      t.timestamp('sent_at');
      t.timestamp('first_viewed_at');
      t.integer('view_count').notNullable().defaultTo(0);
      t.uuid('created_by').references('id').inTable('technicians');
      t.jsonb('metadata');
      t.timestamps(true, true);
      t.index('batch_id');
      t.index('customer_id');
      t.index('status');
      // One notice per change EVENT (customer + effective date + amounts) —
      // the DB-level guard behind the send path's onConflict-ignore, so
      // concurrent /send calls can never double-notice a customer.
      t.unique(['customer_id', 'effective_date', 'current_amount_cents', 'new_amount_cents'], { indexName: 'price_change_notices_event_uniq' });
    });
  }

  if (await knex.schema.hasTable('email_templates')) {
    await upsertEmailTemplate(knex, EMAIL_TEMPLATE);
  }

  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').insert(SMS_TEMPLATE).onConflict('template_key').ignore();
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('price_change_notices')) {
    await knex.schema.dropTable('price_change_notices');
  }
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).del();
  }
  // The email template row is left in place on down() — versions may have
  // operator edits; deactivating is safer than deleting.
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').where({ template_key: EMAIL_TEMPLATE.key }).update({ status: 'archived', updated_at: new Date() });
  }
};
