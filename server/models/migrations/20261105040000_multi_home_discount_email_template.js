'use strict';

/**
 * MULTI-HOME FAMILY BUILD, PR 3 of 3: the "Your Multi-Home Discount is on" email
 * (owner 2026-11-04; dark behind GATE_MULTI_HOME_DISCOUNT_EMAIL, the owner flips it only after approving the copy).
 *
 * Data only, no schema: one NEW template, customer.multi_home_discount_on, with one active version and two preview
 * fixtures, so the admin template preview renders every section before the gate flips.
 *
 *   - Stream: transactional_required, like estimate.accepted_additional_property and membership.started (it states what
 *     the customer is billed from now on, so a SendGrid-side unsubscribe must not swallow it).
 *   - Copy: the draft the owner saw (subject and heading "Your Multi-Home Discount is on"; the 10% line; one block per
 *     home; "Your schedule does not change. Each visit is billed after it is done."; the questions note; the signature
 *     "We look forward to servicing your homes. — The Waves Team").
 *   - One block per home. The renderer has no loop, so the template carries MAX_HOMES fixed slots (home_1_* ... home_8_*).
 *     A slot whose address is blank renders nothing, and so does any row whose value is blank: the sender leaves a cell
 *     out when it cannot read the value from a record (it never guesses a price).
 *
 * Idempotent: an existing template row (a re-run, or one staff authored) is never overwritten. A pushed migration is
 * frozen. `down` is a documented no-op (a blanket revert would erase admin edits made after this published).
 */

const MARKER = 'migration:20261105040000';
const TEMPLATE_KEY = 'customer.multi_home_discount_on';
const STREAM = 'transactional_required';
const MAX_HOMES = 8;

const SUBJECT = 'Your Multi-Home Discount is on';
const PREVIEW_TEXT = 'Every visit at each home you pay for is 10% off from its next visit.';

const HOME_FIELDS = ['address', 'service', 'regular', 'discount', 'price', 'starts', 'payment'];

function homeVariables(i) {
  return HOME_FIELDS.map((field) => `home_${i}_${field}`);
}

function homeBlocks(i) {
  return [
    { type: 'heading', content: `{{home_${i}_address}}` },
    {
      type: 'details',
      rows: [
        { label: 'Service', value: `{{home_${i}_service}}` },
        { label: 'Regular', value: `{{home_${i}_regular}}` },
        { label: 'Multi-Home 10%', value: `{{home_${i}_discount}}` },
        { label: 'Per application', value: `{{home_${i}_price}}` },
        { label: 'Starts', value: `{{home_${i}_starts}}` },
        { label: 'How it is paid', value: `{{home_${i}_payment}}` },
      ],
    },
  ];
}

function buildBlocks() {
  const blocks = [
    { type: 'heading', content: 'Your Multi-Home Discount is on' },
    { type: 'paragraph', content: 'Hi {{greeting_name}},' },
    { type: 'paragraph', content: 'Thanks for trusting Waves with more than one home. From the next visit at each home, every visit is 10% off.' },
  ];
  for (let i = 1; i <= MAX_HOMES; i += 1) blocks.push(...homeBlocks(i));
  blocks.push(
    { type: 'paragraph', content: 'Your schedule does not change. Each visit is billed after it is done.' },
    { type: 'small_note', content: 'Questions? Reply to this email or call {{company_phone}}. A real person answers.' },
    { type: 'signature', content: 'We look forward to servicing your homes. — The Waves Team' },
  );
  return blocks;
}

const REQUIRED = ['greeting_name', 'company_phone', 'home_1_address'];

function allVariables() {
  const list = ['greeting_name', 'company_phone'];
  for (let i = 1; i <= MAX_HOMES; i += 1) list.push(...homeVariables(i));
  return list;
}

// Synthetic values only (no real customer, address or price).
const FIXTURE_HOMES = [
  {
    address: '123 Example Street', service: 'Quarterly Pest Control Service', regular: '$117.00', discount: '-$11.70',
    price: '$105.30', starts: 'Sat, Nov 14', payment: 'Auto Pay card on file',
  },
  {
    address: '45 Sample Court', service: 'Quarterly Pest Control Service', regular: '$117.00', discount: '-$11.70',
    price: '$105.30', starts: 'Tue, Nov 17', payment: 'Invoice to you by email',
  },
  {
    address: '78 Test Lane', service: 'Quarterly Pest Control Service', regular: '$117.00', discount: '-$11.70',
    price: '$105.30', starts: 'Thu, Nov 19', payment: 'Invoice after each visit',
  },
];

function fixturePayload(homes, extra = {}) {
  const payload = { greeting_name: 'Taylor', company_phone: '(941) 297-5749' };
  homes.forEach((home, idx) => {
    for (const field of HOME_FIELDS) payload[`home_${idx + 1}_${field}`] = home[field] || '';
  });
  return { ...payload, ...extra };
}

async function suppressionGroupFor(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return null;
  const group = await knex('email_preference_groups').where({ key: STREAM }).first('key');
  return group ? STREAM : null;
}

async function seedTemplate(knex) {
  if (await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first()) return 'exists';
  const now = new Date();
  const variables = allVariables();
  const optional = variables.filter((v) => !REQUIRED.includes(v));
  const blocks = buildBlocks();
  const [template] = await knex('email_templates').insert({
    template_key: TEMPLATE_KEY,
    name: 'Multi-Home Discount Is On',
    description: 'Sent once per paying address when a home\'s recurring plan has started with the 10% Multi-Home Discount and the discount is on every other home of the family: lists each home the address pays for with its price per application. Transactional stream. Gated behind GATE_MULTI_HOME_DISCOUNT_EMAIL.',
    mode: 'service',
    purpose: 'membership',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'account',
    send_stream: STREAM,
    suppression_group_key: await suppressionGroupFor(knex),
    layout_wrapper_id: 'service_default_v1',
    allowed_variables: JSON.stringify(variables),
    required_variables: JSON.stringify(REQUIRED),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    created_at: now,
    updated_at: now,
  }).returning('*');
  const versionFields = { subject: SUBJECT, preview_text: PREVIEW_TEXT };
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(
    { ...template, allowed_variables: variables, required_variables: REQUIRED },
    { ...versionFields, blocks, text_body: null },
  );
  if (!validation.ok) throw new Error(`${MARKER}: ${TEMPLATE_KEY} failed variable validation`);
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    ...versionFields,
    blocks: JSON.stringify(blocks),
    text_body: null,
    validation_snapshot: JSON.stringify({ ...validation, source: MARKER }),
    published_at: now,
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({ active_version_id: version.id, last_published_at: now, updated_at: now });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    await knex('email_template_fixtures').insert([
      { template_id: template.id, name: 'Three homes, three ways to pay', is_default: true, payload: JSON.stringify(fixturePayload(FIXTURE_HOMES)), updated_at: now },
      {
        template_id: template.id,
        name: 'One home, prices not on file',
        is_default: false,
        payload: JSON.stringify(fixturePayload([{ ...FIXTURE_HOMES[0], regular: '', discount: '' }])),
        updated_at: now,
      },
    ]);
  }
  return 'seeded';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const result = await seedTemplate(trx);
    console.log(`[${MARKER}] ${TEMPLATE_KEY}: ${result}`);
    if (result === 'seeded' && await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { template_keys: [TEMPLATE_KEY], result },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only publish: a blanket revert would erase admin edits made after it published. Staff can archive the
  // template from the template library.
};

exports._private = { buildBlocks, allVariables, REQUIRED, MAX_HOMES, HOME_FIELDS, FIXTURE_HOMES, fixturePayload, TEMPLATE_KEY, SUBJECT };
