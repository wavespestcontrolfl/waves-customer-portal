'use strict';

/**
 * Estimate email content refresh — per-category copy slots + glass voice.
 *
 * The estimate PAGE speaks per-category (estimate-glass-copy.js packs);
 * until now the estimate EMAILS said "your Waves estimate" no matter what
 * was quoted. This republishes the four estimate-drip email templates with
 * category slots filled by estimate-followup-copy.js at send time:
 *
 *   service_label      — "pest control", "lawn care", ... (subjects, body)
 *   category_headline  — glass-pack hero ("Your pest-free home plan is ready")
 *   category_hook      — the built-from-YOUR-property trust line
 *   category_benefit   — terms line, truth-scoped per category (recurring
 *                        lanes get callbacks/90-day/no-contract; rodent,
 *                        termite, commercial, bundle, unknown get the
 *                        terms-neutral line — same rule as the glass packs)
 *   category_question  — ask-chips-style prompt (questions touch)
 *
 * Every sender (follow-up engine estimateEmailPayload, admin-estimates
 * delivery payload) always provides all five, and the renderer drops
 * blocks whose content resolves empty, so previews/manual sends without
 * the vars degrade to shorter emails instead of broken ones.
 *
 * Copy stays inside the claims the estimate page already makes — no new
 * guarantees, numbers, or founding-story claims. Subjects stay <= 60 chars
 * for the longest service_label ("mosquito protection"). Templates render
 * through the glass service wrapper (wrapServiceEmail) like all library
 * mail — no layout change here, content only.
 *
 * estimate.deposit_abandoned is deliberately untouched: its 2026-07-06
 * copy is deadline-specific and already strong.
 *
 * Same publish mechanics as 20260526000008 (new active version, prior
 * versions archived — the admin template UI can restore any of them, which
 * is also the rollback path; down() is a documented no-op).
 */

const TEMPLATES = [
  {
    key: 'estimate.delivery',
    required: ['first_name', 'estimate_url'],
    optional: [
      'price_summary', 'service_summary', 'property_address', 'next_step_summary',
      'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
    ],
    subject: 'Your Waves {{service_label}} estimate is ready',
    preview: 'Priced from your actual property — plan, pricing, and first-visit options inside.',
    blocks: [
      { type: 'heading', content: '{{category_headline}}' },
      { type: 'paragraph', content: 'Hi {{first_name}}, your customized Waves estimate is ready for review.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimated price', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'Inside you can see the full breakdown, compare the available options, and pick the plan or visit that fits your home.' },
      { type: 'callout', content: '{{category_benefit}}' },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'View my estimate', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Questions, timing concerns, or changes to the property details? Reply here and a real person will help before you accept.' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      price_summary: '$89/mo',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      next_step_summary: 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.',
      service_label: 'pest control',
      category_headline: 'Your pest-free home plan is ready',
      category_hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s average.',
      category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
      category_question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
    },
  },
  {
    key: 'estimate.unviewed_followup',
    required: ['first_name', 'estimate_url'],
    optional: [
      'service_summary', 'property_address', 'price_summary',
      'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
    ],
    subject: 'Your Waves {{service_label}} estimate is ready to review',
    preview: 'A quick note in case the estimate link got buried.',
    blocks: [
      { type: 'heading', content: '{{category_headline}}' },
      { type: 'paragraph', content: 'Hi {{first_name}}, just making sure your Waves estimate made it to you.' },
      { type: 'paragraph', content: '{{category_hook}}' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'callout', content: '{{category_benefit}}' },
      { type: 'cta', label: 'View my estimate', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'If anything looks off — or you want us to adjust the recommendation — reply here and a real person will sort it out.' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      service_summary: 'Lawn Care',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$94/mo',
      service_label: 'lawn care',
      category_headline: 'Your greener-lawn game plan is ready',
      category_hook: 'Your price was built from your lawn — size, turf type, and current condition — nothing generic.',
      category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
      category_question: 'Wondering when you’ll see results, or what happens with weeds? Reply and ask — real answers in minutes.',
    },
  },
  {
    key: 'estimate.viewed_followup',
    required: ['first_name', 'estimate_url'],
    optional: [
      'service_summary', 'property_address', 'price_summary',
      'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
    ],
    subject: 'Questions about your Waves {{service_label}} estimate?',
    preview: 'Straight answers on coverage, pricing, and scheduling — just reply.',
    blocks: [
      { type: 'heading', content: 'Still deciding? Ask us anything.' },
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for taking a look at your Waves estimate.' },
      { type: 'paragraph', content: '{{category_question}}' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'If you are comparing companies, the things worth checking are what is included, how often we service the property, and what happens if there is a problem between visits.' },
      { type: 'callout', content: '{{category_benefit}}' },
      { type: 'cta', label: 'Review my estimate', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Property details changed? Reply here and we will adjust the estimate before you decide.' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
      service_label: 'pest control',
      category_headline: 'Your pest-free home plan is ready',
      category_hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s average.',
      category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
      category_question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
    },
  },
  {
    key: 'estimate.expiring_notice',
    required: ['first_name', 'estimate_url', 'expires_at'],
    optional: [
      'service_summary', 'property_address', 'price_summary',
      'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
    ],
    subject: 'Your Waves estimate expires {{expires_at}}',
    preview: 'Your locked price ends {{expires_at}} — approving takes about two minutes.',
    blocks: [
      { type: 'heading', content: 'Last day for your locked price' },
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves {{service_label}} estimate is locked until {{expires_at}} — after that we have to re-quote from scratch, and pricing or availability can change.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
          { label: 'Price locked until', value: '{{expires_at}}' },
        ],
      },
      { type: 'callout', content: '{{category_benefit}}' },
      { type: 'paragraph', content: 'Approving online takes about two minutes, and you pick your first visit right after.' },
      { type: 'cta', label: 'Lock in my price', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Need more time or want something adjusted? Reply here before the estimate expires and we will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      expires_at: 'June 12',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
      service_label: 'pest control',
      category_headline: 'Your pest-free home plan is ready',
      category_hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s average.',
      category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
      category_question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
    },
  },
];

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

// Same republish mechanics as 20260526000008: update the variable lists on
// the template row, publish a new active version, archive prior actives,
// refresh the default fixture. Row identity (key, stream, wrapper, from)
// is untouched — these templates already exist in prod.
async function publishTemplateVersion(knex, t) {
  const template = await knex('email_templates').where({ template_key: t.key }).first();
  if (!template) return; // fresh envs seed via the earlier migrations first

  const allowed = [...new Set([...(t.required || []), ...(t.optional || [])])];
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(t.optional || []),
    status: 'active',
    updated_at: new Date(),
  });

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const versionNumber = (latest?.version_number || 0) + 1;

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: versionNumber,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      referenced_variables: allowed.slice().sort(),
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
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

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload: json(t.fixture || {}),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: json(t.fixture || {}),
      is_default: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const template of TEMPLATES) {
    await publishTemplateVersion(knex, template);
  }
};

exports.down = async function down(knex) {
  // Prior copy versions are archived, not deleted — restore any of them
  // from the admin template UI. Mechanically reverting active_version_id
  // here would guess wrong whenever an operator has published in between.
};

exports.TEMPLATES = TEMPLATES;
