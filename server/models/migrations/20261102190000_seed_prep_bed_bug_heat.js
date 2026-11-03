'use strict';

/**
 * prep.bed_bug_heat: the customer prep sheet for bed bug HEAT and HYBRID
 * treatment (Drive audit 2026-11-02, finding A).
 *
 * Heat and hybrid bed bug work are sold (pricing-engine constants.js
 * bedBug.heat / bedBug.hybrid, requiresHeatSensitiveItemPlan), and the
 * chemical bed bug guide tells those customers "your technician will send
 * separate prep" (20260924000005). No such sheet existed. Owner ruling
 * 2026-09-24 keeps prep.bed_bug chemical-only, so the heat sheet is a
 * SEPARATE template; the chemical guide is not given heat content.
 *
 * Three steps, all idempotent:
 *  1. Seed the prep.bed_bug_heat template (insert-only: an existing row is
 *     left alone, so a re-run never overwrites an office edit). Its row
 *     settings (purpose, stream, variables, CTA) are copied from the live
 *     prep.bed_bug row, so the two guides render and send the same way.
 *     One critical email_template.seeded audit row per template inserted.
 *  2. Seed the appointment.booked automation for it (insert-only), copying
 *     the status and exit conditions of the prep.bed_bug automation. The
 *     service_type_contains condition lists the heat/hybrid names the
 *     appointment tagger uses (utils/bed-bug-heat-service.js).
 *  3. Point the chemical guide at the sheet. The sentence "your technician
 *     will send separate prep for that method" is replaced, by exact text
 *     match, in the LIVE prep.bed_bug version (a NEW active version, so an
 *     office edit elsewhere in the guide is kept) and in the bed bug
 *     sequence's step-0 body. A sentence an office edit removed is left
 *     alone. The old sentence also named electronics as heat-sensitive; the
 *     heat sheet says electronics can stay in the room, so the new sentence
 *     drops that word.
 *
 * Compliance copied from the v3 prep guides (the migration test guards it):
 * no "safe", no fixed re-entry window, no fumigation, no "per visit". The
 * technician handles smoke detectors; customers are not told to remove them.
 * The bed bug guarantee is 30 days (owner ruling 2026-09-03); the sheet makes
 * no guarantee claim.
 *
 * down() is a documented no-op: the template may carry office edits by then,
 * and the tagger stops using it once the code rolls back.
 */

const MIGRATION_ID = '20261102190000_seed_prep_bed_bug_heat';
const MIGRATION_MARKER = 'migration:20261102190000';
const TEMPLATE_KEY = 'prep.bed_bug_heat';
const CHEMICAL_KEY = 'prep.bed_bug';
const AUDIT_SEEDED = 'email_template.seeded';
const AUDIT_CORRECTED = 'email_template.copy_corrected';

// Same names as utils/bed-bug-heat-service.js. Copied, not required: a frozen
// migration must not change when that list changes later.
const HEAT_SERVICE_NAMES = ['bed bug heat', 'bed bug hybrid', 'heat bed bug', 'hybrid bed bug'];

const p = (content) => ({ type: 'paragraph', content });
const h = (content) => ({ type: 'heading', content });
const callout = (content) => ({ type: 'callout', content });
const list = (items) => ({ type: 'list', items });
const faq = (rows) => ({ type: 'details', variant: 'faq', rows });

const SERVICE_DETAILS = {
  type: 'details',
  rows: [
    { label: 'Service', value: '{{project_type}}' },
    { label: 'Service date', value: '{{service_date}}' },
    { label: 'Property', value: '{{property_address}}' },
  ],
};

const CTA = { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' };

const SIGNATURE = {
  type: 'signature',
  content: '— The Waves Pest Control Team\nOffice (941) 318-7612 · Mobile (941) 599-3489 · Toll-free (855) 926-0203\ncontact@wavespestcontrol.com · wavespestcontrol.com',
};

const TEMPLATE = {
  key: TEMPLATE_KEY,
  name: 'Bed Bug Heat Prep Guide',
  description: 'Prep sheet before a bed bug heat or hybrid treatment. The chemical bed bug guide is prep.bed_bug.',
  subject: 'Your bed bug heat treatment: how to get ready',
  preview: 'Heat treatment needs careful prep. Here is what to do, in order.',
  blocks: [
    p('Hi {{first_name}}, your bed bug heat treatment is booked. Heat is one of the most effective ways to clear bed bugs, and it needs careful prep to work. Items we overlook can get in the way of the treatment or let the bugs come back. This sheet covers heat treatment and hybrid treatment (heat plus a targeted residual). Please finish everything below at least 24 hours before we arrive. And one thing first: bed bugs are hitchhikers, not a housekeeping verdict. It happens to spotless homes.'),
    SERVICE_DETAILS,
    h('Laundry and fabrics'),
    list([
      'Wash all clothing, bedding and other fabric items in hot water.',
      'Dry them on high heat for at least 30 minutes.',
      'Put the clean items in sealed plastic bags.',
    ]),
    h('Take heat-sensitive items out of the home'),
    p('These items do not do well in high heat. Take them out before we arrive.'),
    list([
      'Flammable items: alcohol, lighters and aerosol sprays.',
      'Wooden and stringed instruments.',
      'Vinyl records and cassette tapes.',
      'Cosmetics and medications.',
      'Houseplants.',
      'Paintings and artwork.',
      'Batteries and battery-operated devices.',
      'Candles, wax items and crayons.',
      'Anything else that could melt or warp.',
    ]),
    callout('Leave your smoke detectors alone. Your technician handles them.'),
    h('Get each room ready'),
    list([
      'Clear clutter off floors and surfaces.',
      'Move furniture about 18 inches away from the walls.',
      'Stand mattresses and box springs on their edge.',
      'Open all drawers and closets.',
      'Empty the space under beds.',
      'Put away loose papers and light objects, or secure them.',
      'Take out all food items.',
    ]),
    h('Electronics'),
    p('Unplug all electronics. For a heat treatment they can stay in the room, because they can take the heat. Batteries and battery-operated devices are the exception. Those come out, as listed above.'),
    h('Pets and people'),
    list([
      'Take all pets out of the home. That includes fish tanks.',
      'Plan for everyone to be out of the home during the treatment.',
    ]),
    h('Air and access'),
    list([
      'Turn off the air conditioning and fans.',
      'Close all windows.',
      'Give us clear access to every room and area.',
      'Make sure your technician has the keys or codes needed to get in.',
    ]),
    h('The day of treatment'),
    list([
      'Pack a bag with what you need for the day.',
      'Do one last walk-through to check that every step above is done.',
      'The whole process can take 6 to 8 hours. Plan to be away that long.',
      'Do not go back inside until your technician says you can.',
    ]),
    callout('Cannot get something on this list done in time? Reply and tell us what is not finished. We would rather adjust the plan than treat a home that is not ready.'),
    h('After the treatment'),
    p('Your technician will give you specific instructions for coming back in and for any follow-up.'),
    faq([
      { label: 'How did I get bed bugs?', value: 'Travel, guests, used furniture, shared walls. Anywhere people and their belongings move. It has nothing to do with how clean your home is.' },
      { label: 'Can I stay home during the treatment?', value: 'No. Everyone, people and pets, needs to be out of the home for the whole treatment and back in only when your technician says so.' },
      { label: 'Do I need to carry my TV and computers out?', value: 'No. Unplug them and leave them in the room. Batteries and battery-operated devices do come out.' },
    ]),
    p('Questions before the visit? Reply to this email and it goes straight to our team.'),
    CTA,
    SIGNATURE,
  ],
};

const FIXTURE_PAYLOAD = {
  first_name: 'Stan',
  project_type: 'Bed Bug Treatment Service',
  service_date: 'May 20, 2026',
  property_address: '123 Palm Ave, Bradenton, FL 34211',
  prep_url: 'https://portal.wavespestcontrol.com/prep/0123456789abcdef0123456789abcdef',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
};

// Chemical guide wording: the sentence that promised "separate prep".
const OLD_SENTENCE = 'If your estimate lists a heat or hybrid treatment instead, your technician will send separate prep for that method, including a plan for heat-sensitive items such as medications, candles, aerosols and electronics, so do not rely on this list alone.';
const NEW_SENTENCE = 'If your estimate lists a heat or hybrid treatment instead, we send you a separate heat prep sheet for that method. It covers heat-sensitive items such as medications, candles and aerosols, so do not rely on this list alone.';

// The same promise inside the bed bug sequence's step-0 HTML body.
const OLD_STEP_SENTENCE = 'if your estimate lists a heat or hybrid method, your technician will send separate prep for it.';
const NEW_STEP_SENTENCE = 'if your estimate lists a heat or hybrid method, we send you a separate heat prep sheet for it.';

const json = (v) => JSON.stringify(v);

// Row settings copied from the chemical guide's template row.
const COPIED_COLUMNS = [
  'mode', 'purpose', 'legal_classification', 'audience', 'message_priority',
  'content_sensitivity', 'send_stream', 'suppression_group_key', 'layout_wrapper_id',
  'from_name', 'from_email', 'reply_to', 'default_cta_label', 'default_cta_url_variable',
  'allowed_variables', 'required_variables', 'optional_variables', 'status',
];

function templateRowFrom(source) {
  const row = {
    template_key: TEMPLATE.key,
    name: TEMPLATE.name,
    description: TEMPLATE.description,
  };
  for (const column of COPIED_COLUMNS) {
    const value = source[column];
    // jsonb columns come back parsed from pg; write them back as JSON text.
    row[column] = value !== null && typeof value === 'object' ? json(value) : value;
  }
  return row;
}

async function seedTemplate(trx, hasFixtures, recordAuditEvent) {
  if (await trx('email_templates').where({ template_key: TEMPLATE.key }).first('id')) return null;
  const source = await trx('email_templates').where({ template_key: CHEMICAL_KEY }).first();
  if (!source) return null;
  const now = new Date();
  const [template] = await trx('email_templates')
    .insert({ ...templateRowFrom(source), created_at: now, updated_at: now })
    .returning('*');
  const [version] = await trx('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: TEMPLATE.subject,
    preview_text: TEMPLATE.preview,
    blocks: json(TEMPLATE.blocks),
    text_body: null,
    published_at: now,
    created_at: now,
    updated_at: now,
  }).returning('*');
  await trx('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
  if (hasFixtures) {
    await trx('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: json(FIXTURE_PAYLOAD),
      is_default: true,
      created_at: now,
      updated_at: now,
    });
  }
  await recordAuditEvent({
    actor_type: 'system',
    action: AUDIT_SEEDED,
    resource_type: 'email_template',
    resource_id: template.id,
    critical: true,
    trx,
    metadata: {
      migration: MIGRATION_ID,
      template_key: TEMPLATE.key,
      to_version_id: version.id,
      to_version_number: version.version_number,
      reason: 'Prep sheet for bed bug heat and hybrid treatment (Drive audit 2026-11-02, finding A)',
      changes: { created: { before: null, after: { subject: TEMPLATE.subject, blocks: TEMPLATE.blocks } } },
    },
  });
  return template;
}

async function seedAutomation(trx) {
  if (await trx('email_template_automations').where({ automation_key: TEMPLATE_KEY }).first('id')) return;
  const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  const chemical = await trx('email_template_automations').where({ automation_key: CHEMICAL_KEY }).first();
  // Mirror the chemical guide's pause state (draft or active) and exit rules.
  const exit = chemical?.exit_conditions && typeof chemical.exit_conditions === 'object'
    ? chemical.exit_conditions
    : { stop_if: ['appointment.cancelled', 'appointment.closed', 'appointment.past'] };
  await trx('email_template_automations').insert({
    automation_key: TEMPLATE_KEY,
    name: 'Bed bug heat prep guide',
    description: 'Prep instructions before a bed bug heat or hybrid treatment.',
    trigger_event_key: 'appointment.booked',
    trigger_description: 'Prep instructions before a bed bug heat or hybrid treatment.',
    template_key: TEMPLATE_KEY,
    delay_minutes: 0,
    audience: 'customer',
    status: chemical?.status || 'active',
    suppression_group_key: template.suppression_group_key || template.send_stream || null,
    legal_classification: 'transactional_relationship',
    frequency_cap: 'once_per_appointment',
    idempotency_key_template: `${TEMPLATE_KEY}:{scheduled_service_id}`,
    conditions: json({ service_type_contains: HEAT_SERVICE_NAMES }),
    exit_conditions: json(exit),
    retry_policy: json({ max_attempts: 2, backoff_minutes: [15, 60] }),
    quiet_hours: json({ enabled: false }),
    timezone: 'America/New_York',
    owner: 'operations',
    dry_run_notes: 'Counts upcoming scheduled services with a bed bug heat or hybrid name in the service type.',
    last_published_at: new Date(),
  });
}

function parseBlocks(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// Replace OLD_SENTENCE inside the one block that holds it. Returns the new
// blocks, or null when the sentence is not present exactly once.
function patchChemicalBlocks(blocks) {
  if (!Array.isArray(blocks)) return null;
  let hits = 0;
  const next = blocks.map((block) => {
    if (!block || typeof block.content !== 'string' || !block.content.includes(OLD_SENTENCE)) return block;
    hits += block.content.split(OLD_SENTENCE).length - 1;
    return { ...block, content: block.content.split(OLD_SENTENCE).join(NEW_SENTENCE) };
  });
  return hits === 1 ? next : null;
}

// Publish a NEW active version of the chemical guide with the sentence
// swapped. Template row locked first (the editor's lock order), savepoint
// insert, pointer compare-and-swap before any status change.
async function repointChemicalGuide(knex, recordAuditEvent) {
  const template = await knex('email_templates').where({ template_key: CHEMICAL_KEY }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  if (prior.text_body != null && String(prior.text_body).trim()) return 'skipped';
  const blocks = patchChemicalBlocks(parseBlocks(prior.blocks));
  if (!blocks) return 'skipped';
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  let created;
  try {
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject || null,
        preview_text: prior.preview_text || null,
        blocks: json(blocks),
        text_body: null,
        validation_snapshot: json({
          ok: true,
          source: MIGRATION_MARKER,
          supersedes_version: prior.version_number,
          referenced_variables: [],
          disallowed_variables: [],
          missing_required_in_template: [],
        }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions')
    .where({ id: prior.id, status: 'active' })
    .update({ status: 'archived', updated_at: now });
  await recordAuditEvent({
    actor_type: 'system',
    action: AUDIT_CORRECTED,
    resource_type: 'email_template',
    resource_id: template.id,
    critical: true,
    metadata: {
      migration: MIGRATION_ID,
      template_key: CHEMICAL_KEY,
      from_version_id: prior.id,
      to_version_id: created.id,
      reason: 'Chemical guide now points heat and hybrid customers at the heat prep sheet',
      changes: { replaced: { before: OLD_SENTENCE, after: NEW_SENTENCE } },
    },
  });
  return 'published';
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<li>/g, '• ')
    .replace(/<\/(h2|p|li|ul)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bed bug sequence step 0: swap the one sentence when it is there exactly
// once; an office-edited body without it is left alone.
async function repointSequenceStep(knex) {
  const step = await knex('automation_steps')
    .where({ template_key: 'bed_bug' })
    .orderBy('step_order', 'asc')
    .first();
  const html = String(step?.html_body || '');
  if (!step || html.split(OLD_STEP_SENTENCE).length !== 2) return;
  const next = html.split(OLD_STEP_SENTENCE).join(NEW_STEP_SENTENCE);
  await knex('automation_steps').where({ id: step.id }).update({
    html_body: next,
    text_body: textFromHtml(next),
    updated_at: new Date(),
  });
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTemplates) return;
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  const hasAutomations = await knex.schema.hasTable('email_template_automations');
  const { recordAuditEvent } = require('../../services/audit-log');
  await knex.transaction(async (trx) => {
    await seedTemplate(trx, hasFixtures, recordAuditEvent);
    if (hasAutomations) await seedAutomation(trx);
  });
  await repointChemicalGuide(knex, recordAuditEvent);
  if (await knex.schema.hasTable('automation_steps')) await repointSequenceStep(knex);
};

exports.down = async function down() {
  // No-op on purpose (see the header): rollback must not delete office-owned content.
};

exports.AUDIT_SEEDED = AUDIT_SEEDED;
exports.AUDIT_CORRECTED = AUDIT_CORRECTED;
exports.__private = {
  TEMPLATE, FIXTURE_PAYLOAD, HEAT_SERVICE_NAMES, OLD_SENTENCE, NEW_SENTENCE,
  OLD_STEP_SENTENCE, NEW_STEP_SENTENCE, MIGRATION_MARKER,
  patchChemicalBlocks, templateRowFrom,
};
