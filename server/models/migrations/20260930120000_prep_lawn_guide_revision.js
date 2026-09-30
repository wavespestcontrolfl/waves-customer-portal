'use strict';

/**
 * Lawn prep guide revision (owner-approved 2026-09-29/30).
 *
 * The owner-approved revised Lawn Care prep & service guide replaces the
 * prep.lawn email/page copy: a prep guide (what you do, what we do, why)
 * instead of the 2026-07 refresh. Same single source text as the estimate
 * "full details" guide (services/estimate-service-details.js), at email length.
 *
 * ONE template: prep.lawn. It gets a NEW active version (the prior version is
 * archived, never edited) via the same mechanics as the 2026-07-15 refresh
 * (20260715000001_prep_guide_content_refresh.js): prior active versions are
 * archived, the template pointer flips to the new version, and down() only
 * rolls back a version THIS migration created (snapshot marker).
 *
 * Compliance (enforced in server/tests/prep-lawn-guide-revision-migration.test.js):
 * never "safe"/"safely"; no fixed re-entry windows (say "keep foot traffic off
 * for two days", never a stay-off-N-hours window); products are "EPA-registered";
 * brand is "Waves"; pricing wording never says "per visit".
 */

const json = (v) => JSON.stringify(v);

// Stamped into validation_snapshot.source on the version this migration
// publishes so down() can identify its OWN version exactly — never a later
// admin publication that happens to carry identical blocks (created_by is a
// technician-uuid FK, so the marker lives here).
const MIGRATION_MARKER = 'migration:20260930120000';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

const p = (content) => ({ type: 'paragraph', content });
const h = (content) => ({ type: 'heading', content });
const callout = (content) => ({ type: 'callout', content });
// FAQ rows ride the details block with the variant marker the page uses to
// render single-column question-over-answer.
const faq = (rows) => ({ type: 'details', variant: 'faq', rows });

// The standard service-info block every prep guide leads with.
const SERVICE_DETAILS = {
  type: 'details',
  rows: [
    { label: 'Service', value: '{{project_type}}' },
    { label: 'Service date', value: '{{service_date}}' },
    { label: 'Property', value: '{{property_address}}' },
  ],
};

// renderTemplate only appends the default CTA when there is NO cta block, and
// renderBlocks skips a cta without url/url_variable, so label + url_variable
// must ride along or the email loses its "Open prep guide" button.
const CTA = { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' };

const PETS_KIDS_HEADING = h('Pets & kids');

const TEMPLATES = [
  {
    key: 'prep.lawn',
    blocks: [
      p('Hi {{first_name}}, your Waves lawn care visit is coming up. Your grass type, your property’s conditions, and the actual problem determine the treatment, so this guide covers what to do before we arrive, what to expect after we leave, and why each step matters.'),
      SERVICE_DETAILS,
      h('Before your first visit'),
      p('Five things we need from you. Each one changes what we apply.'),
      p('Who mows, and what day. We schedule around your mow so product isn’t stripped off the blade the next morning. Why: most liquid applications need a day or two on the leaf to work.'),
      p('Your irrigation days and run times per zone. If you don’t know them, tell us the controller brand and we’ll read it on the first visit. Why: watering-in and dry-time instructions are written against your real schedule, and overwatering is the single biggest cause of dollarweed, sedge, and fungus in our area.'),
      p('Grass type if you know it, and the sod invoice if you have one. Why: the herbicide list is different for every grass, and for Bermuda removal the St. Augustine cultivar decides whether the treatment is allowed at all.'),
      p('Anything applied in the last 60 days by anyone: store-bought weed-and-feed, a previous company, a landscaper. Send a photo of the bag or bottle. Why: stacking products injures turf and voids label intervals.'),
      p('Edible gardens, ponds, beehives, chickens, an invisible-fence wire, and shallow irrigation lines. Why: product placement is planned around them.'),
      h('Before we arrive'),
      p('Mow at least 24 hours before if mowing is due, and don’t mow the day of. We need leaf surface to treat, and fresh cuts bleed product.'),
      p('Turn the sprinklers off the night before. We treat a dry lawn: wet grass dilutes liquids, and granules stick to the blade instead of reaching the soil.'),
      p('Clear the lawn of toys, hoses, furniture, pet bowls, and pet waste, and unlock gates. Keep pets and kids inside during the application.'),
      p('Tell us what changed: new sod, a new dog, a sprinkler repair, a brown patch that showed up this week. Text a photo. The visit starts from your lawn’s history, and a change we don’t know about is a diagnosis we get wrong.'),
      PETS_KIDS_HEADING,
      p('Every product we apply is EPA-registered and used by its label, which is legally binding on where it goes, at what rate, and when people and pets may return. Keep kids and pets off the lawn until the treated area is dry for liquids, or until it has been watered in for granules. Your service report states the guidance for the products actually used.'),
      p('Dogs that graze grass or lick their paws are the main exposure route. If you have a grazer, tell us and we’ll advise for that specific treatment.'),
      h('What to expect after'),
      p('Watering: your service report says one of water in today (granular fertilizer, most insect granules), keep dry for the stated hours (liquid weed control, fungicide), or resume your normal schedule. Don’t run the sprinklers after a visit unless the report says to.'),
      p('Mowing: wait 1–2 days after liquid applications, longer if the report says so. Never mow a wet application.'),
      p('What working looks like: weeds yellow and wilt over 1–2 weeks, and stubborn perennials may need a second pass. Insect damage stops spreading, but dead turf does not regrow. It fills in by runners, plugs, or sod.'),
      p('Call us right away if the lawn yellows in streaks or stripes within days of a visit, or damage is spreading. That is an immediate look, not wait-and-see, and there is no waiting period for a re-service.'),
      faq([
        { label: 'Will my lawn be weed-free?', value: 'No company should promise that. Some weeds are prevented, some are treated after they emerge, and grassy weeds inside another grass may have limited selective options. The durable fix is dense turf; where shade, water, or compaction keep it thin, weeds return no matter what’s sprayed, and your report will say so.' },
        { label: 'How fast will it improve?', value: 'It depends on the cause and whether the roots are alive. Weeds decline over 1–2 weeks. A treatment stops a pest without replacing dead turf. Your technician tells you which case you have and what to watch for by the next visit.' },
        { label: 'I just had new sod installed. What should I do?', value: 'We don’t install sod, but we care for it after. Tell us the install date, the grass type, and what the installer applied. New sod gets an establishment plan instead of the standard pass: no fertilizer for 30–60 days (and none at all June 1 – September 30), no herbicide during establishment, a first mow at 14–21 days, and feet and pets kept off for two weeks.' },
        { label: 'Can you remove Bermuda from my St. Augustine?', value: 'Yes. It is part of the lawn program and priced separately on your estimate. It is a spring-only, multi-application treatment (Recognition plus Fusilade II), and whether it is allowed depends on your St. Augustine cultivar: Floratam, Palmetto, Raleigh, SunClipse, and CitraBlue qualify; ProVista, Captiva, and Seville do not. Two applications per growing season is the ceiling, and we never promise permanent eradication.' },
      ]),
      callout('Your service report is the rulebook for each visit. Follow the watering, mowing, and dry-time instructions on it for that specific treatment, because they change by application.'),
      CTA,
    ],
  },
];

async function publishVersion(knex, key, blocks) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template) return;
  const prior = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: prior?.subject || null,
    preview_text: prior?.preview_text || null,
    blocks: json(blocks),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      source: MIGRATION_MARKER,
      referenced_variables: [],
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
    published_at: now,
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: now });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
}

exports.TEMPLATES = TEMPLATES;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    await publishVersion(knex, t.key, t.blocks);
  }
};

exports.down = async function down(knex) {
  // Re-activate the prior version; this migration's version is archived
  // (versions are retained, never deleted).
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    const template = await knex('email_templates').where({ template_key: t.key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    // Only roll back a version THIS migration created (snapshot marker) — an
    // admin publication after the migration, even with identical blocks, is
    // left alone.
    if (!current || snapshotSource(current) !== MIGRATION_MARKER) continue;
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, status: 'archived' })
      .where('version_number', '<', current.version_number)
      .orderBy('version_number', 'desc')
      .first();
    if (!prior) continue;
    const now = new Date();
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: now });
    await knex('email_templates').where({ id: template.id }).update({ active_version_id: prior.id, updated_at: now });
  }
};
