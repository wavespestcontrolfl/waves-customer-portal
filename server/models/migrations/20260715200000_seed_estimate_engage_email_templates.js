'use strict';

/**
 * Seed the 7 estimate.engage_* email templates — PR 3 of the engagement-drip
 * lane (PR 1 = #2729 ledger, PR 2 = #2736 engine). These are the templates
 * the engine's rules reference (estimate_followup_rules.template_key,
 * migration 20260714000050); until now the engine failed closed on send
 * because the rows didn't exist.
 *
 * ACTIVATION NOTE: seeding these active does NOT start sending anything —
 * the engine is dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP (unset in
 * prod = shadow mode). These rows only arm the send path for the eventual
 * gate flip.
 *
 * Copy rules (owner-ratified):
 * - Per-category slots ({{category_headline}}/{{category_hook}}/
 *   {{category_benefit}}/{{category_question}}, {{service_label}}) are
 *   filled at send time by estimate-followup-copy.js — the truth-scope
 *   demotion rules (recurring terms ONLY for lanes that claim them on the
 *   estimate page) live there, not here.
 * - No monthly/annual totals restated (residential recurring rule); the
 *   linked estimate page carries all pricing.
 * - Subjects ≤60 chars, static (no variables in subjects). One job, one
 *   primary CTA, no invented numbers.
 * - The "reply to extend" offer is real — the extension flow exists and
 *   the public page carries a self-serve extension request.
 *
 * Same upsert mechanics as 20260714000041 (payment_step_abandoned).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const CATEGORY_VARIABLES = [
  'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
];

const FIXTURE_CATEGORY = {
  service_label: 'pest control',
  category_headline: 'Your pest-free home plan is ready',
  category_hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s.',
  category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
  category_question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
};

const BASE_FIXTURE = {
  first_name: 'Taylor',
  estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
  ...FIXTURE_CATEGORY,
};

const TEMPLATES = [
  {
    key: 'estimate.engage_unopened',
    name: 'Estimate Engagement — Unopened Nudge',
    description: 'Engagement engine (delivery_unopened_24h): the estimate was delivered 24–48h ago and never opened. One gentle resurface with the category headline; goal is the first open. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'category_headline', 'category_hook', 'category_benefit'],
    optional: ['category_question'],
    subject: 'Your Waves estimate is ready when you are',
    preview: 'It’s saved and waiting — take a look whenever suits.',
    blocks: [
      { type: 'heading', content: '{{category_headline}}' },
      { type: 'paragraph', content: 'Hi {{first_name}}, we sent over your {{service_label}} estimate and wanted to make sure it didn’t get buried. It’s saved and waiting whenever you’re ready.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'View my estimate', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'estimate.engage_return_visit',
    name: 'Estimate Engagement — Return Visit',
    description: 'Engagement engine (return_visit_hot): the customer came back for a second look within 48h of the first. Warm, help-forward — leads with the category question. Spacing-exempt by rule design. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'category_question', 'category_benefit'],
    optional: ['category_headline', 'category_hook'],
    subject: 'Welcome back — questions about your estimate?',
    preview: 'Reply to this email and a real person answers in minutes.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for taking another look at your {{service_label}} estimate. If anything’s unclear, we’re happy to help.' },
      { type: 'paragraph', content: '{{category_question}}' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Open my estimate', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'estimate.engage_high_intent',
    name: 'Estimate Engagement — High Intent',
    description: 'Engagement engine (multi_view_high_intent): three or more visits inside 72h — clearly weighing it. Strongest accept CTA in the set, still no pressure numbers. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'category_hook', 'category_benefit'],
    optional: ['category_headline', 'category_question'],
    subject: 'Ready when you are — it takes about a minute',
    preview: 'Your estimate is saved. Accepting takes about a minute.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} estimate is saved and ready whenever you are — accepting takes about a minute, and we handle the rest.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Review and accept', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Still weighing it? Reply with any question — a real person answers.' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'estimate.engage_return_after_dark',
    name: 'Estimate Engagement — Return After Quiet',
    description: 'Engagement engine (dark_then_return): the customer returned after 3+ days of silence. Re-engagement framing — the plan and pricing are unchanged (the engine only sends while the estimate is unexpired). Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'category_hook', 'category_benefit'],
    optional: ['category_headline', 'category_question'],
    subject: 'Your estimate is right where you left it',
    preview: 'Nothing has changed — same plan, same pricing, saved for you.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, good to see you back. Your {{service_label}} estimate is right where you left it — same plan, same pricing.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Pick up where I left off', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'estimate.engage_gone_quiet',
    name: 'Estimate Engagement — Gone Quiet',
    description: 'Engagement engine (viewed_gone_quiet_72h): viewed once, then 72–96h of silence. The gentlest touch in the set — a check-in that leads with the category question. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'category_question', 'category_benefit'],
    optional: ['category_headline', 'category_hook'],
    subject: 'Any questions about your Waves estimate?',
    preview: 'Reply and ask — real answers in minutes.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, just checking in on your {{service_label}} estimate — no rush at all.' },
      { type: 'paragraph', content: '{{category_question}}' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Take another look', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
  },
  {
    key: 'estimate.engage_expiring',
    name: 'Estimate Engagement — Expiring (Engaged)',
    description: 'Engagement engine (expiring_engaged): the estimate expires within 2 days and the customer HAS viewed it. Deadline framing with a genuine extension offer — the reply-to-extend line is backed by the real extension flow. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'expires_date', 'category_benefit'],
    optional: ['category_headline', 'category_hook', 'category_question'],
    subject: 'Heads up — your estimate expires soon',
    preview: 'Your pricing holds until the expiration date on your estimate.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, a quick heads up: your {{service_label}} estimate expires on {{expires_date}}. Until then, your pricing is locked in.' },
      { type: 'paragraph', content: 'Need more time to decide? Just reply — we’re happy to extend it.' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Review my estimate', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
    fixture: { expires_date: 'August 1' },
  },
  {
    key: 'estimate.engage_expiring_unseen',
    name: 'Estimate Engagement — Expiring (Never Viewed)',
    description: 'Engagement engine (expiring_never_viewed): the estimate expires within 2 days and was never opened. Distinct copy from the engaged variant — the ask is one look, with the same genuine extension offer. Dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP.',
    required: ['first_name', 'estimate_url', 'service_label', 'expires_date', 'category_headline', 'category_hook', 'category_benefit'],
    optional: ['category_question'],
    subject: 'Worth a look before it expires',
    preview: 'Your estimate was built from your property — one quick look.',
    blocks: [
      { type: 'heading', content: '{{category_headline}}' },
      { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} estimate expires on {{expires_date}} and it doesn’t look like you’ve had a chance to see it yet — worth one quick look before it does.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      { type: 'paragraph', content: 'Need more time? Just reply — we’re happy to extend it.' },
      { type: 'small_note', content: '{{category_benefit}}' },
      { type: 'cta', label: 'See my estimate', url_variable: 'estimate_url' },
      { type: 'signature', content: '— The Waves Team' },
    ],
    fixture: { expires_date: 'August 1' },
  },
];

function templateRow(t) {
  const allowed = [...new Set([
    ...SHARED_VARIABLES,
    ...CATEGORY_VARIABLES,
    ...(t.required || []),
    ...(t.optional || []),
  ])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: 'estimate',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'account',
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

async function upsertTemplate(knex, t) {
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
  const versionFields = {
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    published_at: new Date(),
    updated_at: new Date(),
  };
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update(versionFields);
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      created_at: new Date(),
      ...versionFields,
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const payload = {
      company_phone: REAL_PHONE,
      company_email: SERVICE_FROM,
      ...BASE_FIXTURE,
      ...(t.fixture || {}),
    };
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      await knex('email_template_fixtures').where({ id: fixture.id }).update({
        payload: JSON.stringify(payload),
        updated_at: new Date(),
      });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Default preview',
        is_default: true,
        payload: JSON.stringify(payload),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates')) {
    // Archive rather than delete — email_messages may reference the rows.
    await knex('email_templates')
      .whereIn('template_key', TEMPLATES.map((t) => t.key))
      .update({ status: 'archived', updated_at: new Date() });
  }
};

// Exported for the seed-pinning test.
exports._TEMPLATES = TEMPLATES;
