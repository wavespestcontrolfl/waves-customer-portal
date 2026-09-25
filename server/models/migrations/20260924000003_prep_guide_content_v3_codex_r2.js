'use strict';

/**
 * Prep guide content v3 — Codex round-2 corrections (PR #4790).
 *
 * 20260924000002 ran on the PR's preview database after round 1, so it is
 * frozen too (applied-migration guard). This file supersedes it the same
 * way: exact-match text patches over 000002's effective TEMPLATES (a
 * missing or duplicated `from` throws), published as a NEW active version
 * of every prep.* template. The migration test reads THIS file's
 * TEMPLATES as the content customers receive.
 *
 * Round-2 findings, all "the copy says more or less than the customer
 * bought":
 *  P1  Flea preview text still said the guide "saves a second visit" —
 *      the second visit is the package (intent-composer.js:44).
 *  P1  Flea "what we do" promised exterior harborage treatment on every
 *      job; yard treatment is an add-on (20260903000060:79). Now
 *      conditional, matching the prep checklist.
 *  P1  German roach copy pinned the cleanout to "initial + one follow-up";
 *      moderate/heavy tiers include 3–4 visits (pricing-engine
 *      constants.js germanRoach tiers). Visit-count-neutral now.
 *  P1  Bed bug copy described a single 10–14 day follow-up; moderate/heavy
 *      chemical packages include three visits (constants.js bed bug
 *      severity). Plural, severity-neutral now.
 *  P1  Freezer alternative said 3 days at 0°F; the accepted guidance is at
 *      least 4 full days, longer for bulky items.
 *  P1  "Leave the suitcase in a hot garage or car for a day" is not a
 *      temperature-verified treatment; replaced with the dryer + flashlight
 *      inspection.
 */

const base = require('./20260924000002_prep_guide_content_v3_codex_r1');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000003';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match text patches over the 000002 content. `from` must occur
// exactly once across the named template's text fields (subject/preview
// included when `field` names them).
const PATCHES = [
  // ── Flea: preview + exterior conditional ──
  {
    key: 'prep.flea',
    field: 'preview',
    from: 'Pets first, floors second, then let us handle the rest. A five-minute read that saves a second visit.',
    to: 'Pets first, floors second, then let us handle the rest. A five-minute read that gets the most out of both visits.',
  },
  {
    key: 'prep.flea',
    from: 'to floors, carpets, under furniture, baseboards and pet resting areas, then treats exterior harborage. The adulticide',
    to: 'to floors, carpets, under furniture, baseboards and pet resting areas and, when yard treatment is part of your package, treats exterior harborage. The adulticide',
  },
  {
    key: 'prep.flea',
    from: 'When fleas are coming from outside, yes. Exterior work targets shaded, moist harborage along the foundation, under decks and shrubs, and where pets rest, not the open lawn. Reply if you are seeing fleas on the lanai or in the garage.',
    to: 'Yard treatment is an add-on to the two-visit package, and it is worth adding when fleas are coming from outside. Exterior work targets shaded, moist harborage along the foundation, under decks and shrubs, and where pets rest, not the open lawn. Reply if you are seeing fleas on the lanai or in the garage and we will add it.',
  },
  // ── German roach: visit-count-neutral ──
  {
    key: 'prep.cockroach',
    from: 'Interior German roach activity is a separate cleanout program, the initial visit plus the 10 to 14 day follow-up, and catching it early keeps that program short.',
    to: 'Interior German roach activity is a separate cleanout program with scheduled follow-up visits, and catching it early keeps that program short.',
  },
  {
    key: 'prep.cockroach',
    from: 'Activity should fall off hard by day 10 to 14, when your follow-up visit is due.',
    to: 'Activity should fall off hard by day 10 to 14, when your first follow-up visit is due. Your package includes the follow-up visits your infestation calls for.',
  },
  {
    key: 'prep.cockroach',
    from: 'Still seeing live German roaches at day 14? That is exactly what the follow-up is for. Tell your technician what you have seen and where.',
    to: 'Still seeing live German roaches at day 14? That is exactly what the follow-up visits are for. Tell your technician what you have seen and where.',
  },
  {
    key: 'prep.cockroach',
    field: 'label',
    from: 'Is the follow-up visit really necessary?',
    to: 'Are the follow-up visits really necessary?',
  },
  {
    key: 'prep.cockroach',
    from: 'For German roaches, yes. Egg cases laid before the visit hatch over the following two weeks, and the follow-up catches that generation before it breeds. Skipping it is the most common reason a German roach job comes back.',
    to: 'For German roaches, yes. Egg cases laid before the visit hatch over the following weeks, and the follow-up visits catch each generation before it breeds. Skipping them is the most common reason a German roach job comes back.',
  },
  // ── Bed bug: plural, severity-neutral follow-ups ──
  {
    key: 'prep.bed_bug',
    from: 'Bag clean items in new sealed plastic bags or bins as they come out of the dryer, and keep them sealed until after the follow-up visit. Label the bags "clean."',
    to: 'Bag clean items in new sealed plastic bags or bins as they come out of the dryer, and keep them sealed until your technician clears the room at the final follow-up visit. Label the bags "clean."',
  },
  {
    key: 'prep.bed_bug',
    from: 'or seal them for 3 days in a freezer at 0°F.',
    to: 'or seal them in a freezer at 0°F for at least 4 full days, longer for bulky items so the center reaches temperature.',
  },
  {
    key: 'prep.bed_bug',
    from: 'They catch bugs traveling to and from the bed and tell you, and us, whether anything is still alive at the follow-up.',
    to: 'They catch bugs traveling to and from the bed and tell you, and us, whether anything is still alive at each follow-up visit.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Seeing a few bed bugs in the first week or two after treatment is expected. Eggs are not killed by most products; they hatch over 7 to 10 days onto treated surfaces and die. A second treatment 10 to 14 days later catches that hatch, which is why the follow-up is part of the plan and not a sign of failure.',
    to: 'Seeing a few bed bugs in the first week or two after treatment is expected. Eggs are not killed by most products; they hatch over 7 to 10 days onto treated surfaces and die. Follow-up visits, the first about 10 to 14 days later, catch that hatch. Your package includes the follow-up visits your infestation calls for; they are part of the plan, not a sign of failure.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Check them every few days and photograph anything you find. Your technician will ask at the follow-up.',
    to: 'Check them every few days and photograph anything you find. Your technician will ask at each follow-up visit.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Keep bagged items sealed until the follow-up visit clears the room. Then unbag a little at a time.',
    to: 'Keep bagged items sealed until your final follow-up visit clears the room. Then unbag a little at a time.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Repeat the laundry prep before the follow-up visit: bedding hot-washed and dried on high, floor clear, bed pulled from the wall.',
    to: 'Repeat the laundry prep before each follow-up visit: bedding hot-washed and dried on high, floor clear, bed pulled from the wall.',
  },
  {
    key: 'prep.bed_bug',
    from: 'When you get home, unpack straight into the washer and run the empty suitcase in a hot dryer or leave it in a hot garage or car for a day.',
    to: 'When you get home, unpack straight into the washer, run soft luggage through a hot dryer for 30 minutes, and inspect hard luggage seams, pockets and wheel wells with a flashlight before storing it.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Bed bugs are the toughest household pest, and eggs survive the first visit. The follow-up 10 to 14 days later is what breaks the cycle. Be wary of anyone who promises every last egg gone in one shot.',
    to: 'Bed bugs are the toughest household pest, and eggs survive the first visit. The included follow-up visits, the first about 10 to 14 days later, are what break the cycle. Be wary of anyone who promises every last egg gone in one shot.',
  },
  // ── Pre-emptive: remaining singular follow-up phrasings + mosquito cadence ──
  {
    key: 'prep.cockroach',
    from: 'Leave the sticky monitors in place. Your technician reads them at the follow-up.',
    to: 'Leave the sticky monitors in place. Your technician reads them at the follow-up visits.',
  },
  {
    key: 'prep.bed_bug',
    from: 'We photograph evidence so the follow-up has a baseline.',
    to: 'We photograph evidence so the follow-up visits have a baseline.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Documents rooms treated, method, and anything we could not reach, then sets the follow-up window.',
    to: 'Documents rooms treated, method, and anything we could not reach, then sets the follow-up schedule.',
  },
  {
    key: 'prep.mosquito',
    from: 'In season, every 3 to 4 weeks keeps the barrier continuous. Waves also offers a misting system',
    to: 'Roughly monthly keeps the barrier continuous: our programs run either monthly year-round or as a nine-visit season. Waves also offers a misting system',
  },
];

function patchText(text, from, to, hits) {
  if (typeof text !== 'string' || !text.includes(from)) return text;
  hits.count += text.split(from).length - 1;
  return text.split(from).join(to);
}

function applyPatch(template, patch) {
  const hits = { count: 0 };
  const next = { ...template };
  if (patch.field === 'preview' || patch.field === 'subject') {
    next[patch.field] = patchText(next[patch.field], patch.from, patch.to, hits);
  } else {
    next.blocks = template.blocks.map((block) => {
      const b = { ...block };
      if (patch.field !== 'label' && typeof b.content === 'string') {
        b.content = patchText(b.content, patch.from, patch.to, hits);
      }
      if (patch.field !== 'label' && Array.isArray(b.items)) {
        b.items = b.items.map((item) => patchText(item, patch.from, patch.to, hits));
      }
      if (Array.isArray(b.rows)) {
        b.rows = b.rows.map((row) => ({
          ...row,
          label: patch.field === 'label' ? patchText(row.label, patch.from, patch.to, hits) : row.label,
          value: patch.field !== 'label' ? patchText(row.value, patch.from, patch.to, hits) : row.value,
        }));
      }
      return b;
    });
  }
  if (hits.count !== 1) {
    throw new Error(`20260924000003: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
  }
  return next;
}

function buildTemplates() {
  return base.TEMPLATES.map((t) => {
    let template = { ...t, blocks: t.blocks.map((b) => ({ ...b })) };
    for (const patch of PATCHES.filter((p) => p.key === t.key)) {
      template = applyPatch(template, patch);
    }
    return template;
  });
}

const TEMPLATES = buildTemplates();

async function publishVersion(knex, t) {
  const template = await knex('email_templates').where({ template_key: t.key }).first();
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
    subject: t.subject || prior?.subject || null,
    preview_text: t.preview || prior?.preview_text || null,
    blocks: json(t.blocks),
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
exports.PATCHES = PATCHES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.SUPERSEDES = base.MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    await publishVersion(knex, t);
  }
};

exports.down = async function down(knex) {
  // Re-activate the version this migration displaced (the 000002 one);
  // only a version THIS migration created is rolled back.
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    const template = await knex('email_templates').where({ template_key: t.key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
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
