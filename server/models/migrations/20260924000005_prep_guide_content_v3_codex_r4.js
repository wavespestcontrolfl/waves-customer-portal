'use strict';

/**
 * Prep guide content v3 — Codex round-4 corrections (PR #4790).
 *
 * 20260924000004 ran on the PR's preview database after round 3, so it is
 * frozen (applied-migration guard). Same supersession pattern for the
 * prep.* templates (exact-match patches over 000004's TEMPLATES; a missing
 * or duplicated `from` throws; new active version per template), PLUS the
 * Automations-tab sequence step-0 bodies, which round 4 flagged:
 *
 *  P1  Bed bug method scope. The pricing contract still carries HEAT /
 *      HYBRID methods (pricing-engine constants.js bedBug.allowedMethods)
 *      while the appointment flow selects prep.bed_bug from the pest type
 *      alone, so a heat-booked customer would have read chemical prep as
 *      their instructions. Owner ruling 2026-09-24 keeps this guide
 *      chemical/IPM-only, so instead of adding heat content the guide now
 *      says which method it covers and tells a heat/hybrid customer that
 *      method-specific prep (incl. the heat-sensitive-items plan) comes
 *      separately from the technician.
 *
 *  P1  Sequence step-0 bodies (automation_steps bed_bug / cockroach /
 *      flea — the gated treatment sequence a first-time booking also
 *      enrolls, TREATMENT_AUTOMATION_BY_PEST_TYPE in appointment-tagger.js)
 *      still carried the pre-v3 copy: flea framed as "one treatment and a
 *      repeat visit" (it is the two-visit package), roach/bed bug with a
 *      single follow-up (moderate/heavy tiers include more), the retired
 *      company-name sign-off. Same exact-match, admin-edit-preserving swap
 *      as 20260715000001 — `fromHtml` is that migration's `toHtml` (no
 *      later migration touched these three rows); a body an operator has
 *      edited since is left alone.
 *
 * The PDF check-glyph P2 from the same round is a code change in
 * server/services/pdf/prep-guide-pdf.js, not a migration.
 */

const base = require('./20260924000004_prep_guide_content_v3_codex_r3');
const refresh = require('./20260715000001_prep_guide_content_refresh');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000005';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match text patches over the 000004 content.
const PATCHES = [
  {
    key: 'prep.bed_bug',
    from: 'They ride in on luggage, furniture and travel. It happens to spotless homes.',
    to: 'They ride in on luggage, furniture and travel. It happens to spotless homes. This guide covers our standard chemical treatment, which is nearly every bed bug job we do. If your estimate lists a heat or hybrid treatment instead, your technician will send separate prep for that method, including a plan for heat-sensitive items such as medications, candles, aerosols and electronics, so do not rely on this list alone.',
  },
];

// ── Sequence step-0 bodies ────────────────────────────────────────────
// fromHtml = 20260715000001's toHtml (the current shipped copy). toHtml =
// v3-consistent condensed guide. Compliance: no "safe", no fixed re-entry
// windows, "EPA-registered" wherever products are described, approved
// "— The Waves Team" sign-off.

const FOOTER = '\n<p>— The Waves Team</p>\n<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>';

const STEP_BODIES = {
  bed_bug: `<h2>Hi {{first_name}} — let's get your home bed bug-free</h2>
<p>Bed bug treatments work best when the home is prepped properly. This list isn't optional — skipping steps is the #1 reason a treatment plan runs long. And for the record: bed bugs hitchhike in on luggage and furniture. They are not a housekeeping verdict. This covers our standard chemical treatment; if your estimate lists a heat or hybrid method, your technician will send separate prep for it.</p>

<h2>Three things NOT to do</h2>
<ul>
  <li>No bug bombs or foggers — they scatter bed bugs into other rooms.</li>
  <li>Do NOT throw out your mattress or furniture — discarding spreads bugs on the way out, and encasements protect what you have.</li>
  <li>Do NOT move to another bedroom or the couch — keep sleeping in the treated bed so the bugs come to the treated zone.</li>
</ul>

<h2>Before we arrive</h2>
<ul>
  <li>Strip all bedding — sheets, pillowcases, comforters. Wash hot, then dry on high heat 30+ minutes (the hot dryer is the step that kills every stage). Bag clean laundry in NEW sealed plastic bags until your technician clears the room at the final follow-up visit.</li>
  <li>Electronics never go in a dryer or freezer: unplug them, bag each device, and leave them on the bed for inspection.</li>
  <li>Vacuum mattress seams, box springs, bed frame joints, and the floor along baseboards. Seal the vacuum contents in plastic and take them to an outside bin.</li>
  <li>Clear the floor of clutter in the affected rooms — but do NOT carry loose items to other rooms; bag first, then move.</li>
  <li>Pull the bed and furniture 18 inches from the walls; take wall decor down and set it face-down on the bed.</li>
  <li>Strip the mattress and box spring bare — encasements go on AFTER treatment, and stay on 12 months.</li>
</ul>

<h2>Day of treatment</h2>
<p>Plan for everyone — people and pets — to be out of the home during treatment and until your technician confirms treated areas are ready. Fish tanks: pump off, top covered. Birds and reptiles are extra sensitive — arrange for them to stay elsewhere. If anyone is pregnant or chemically sensitive, reply and tell us before the visit.</p>

<h2>After</h2>
<p>Seeing a few bed bugs in the first days is normal — they're crossing treated surfaces, which is the treatment working. Eggs hatch over 7–10 days, so your package includes follow-up visits (the first at about 10–14 days) — repeat this same prep before each one, keep bagged items sealed until the final visit clears the room, and keep sleeping in the treated bed. Don't wipe down baseboards or bed frames where the EPA-registered products were applied — they keep working for weeks. Interceptor cups under the bed legs tell you and us what is still alive.</p>

<p>Reply to this email if anything on the list is unclear — we'd rather answer now than re-treat later.</p>
${FOOTER}`,

  cockroach: `<h2>Hi {{first_name}} — let's clear out the roaches</h2>
<p>German cockroach treatments are more effective when their hiding spots are accessible. Spend 20 minutes on this and we'll spend 20 minutes less chasing them. One rule above all: please do not spray anything before or between our visits — store sprays repel roaches away from the bait that kills the colony.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Empty the cabinets under the kitchen and bathroom sinks; clear access to cabinets where you've seen activity (your technician will say if a heavy infestation needs more)</li>
  <li>Pull the fridge forward a foot if you can (they hide behind the motor); unplug and pull small appliances forward</li>
  <li>Wash the dishes and run the dishwasher the night before; clear countertops and wipe up grease + crumbs — grease keeps the treatment from sticking</li>
  <li>Pet bowls up off the floor overnight, dry pet food in sealed containers, pet toys and chews put away; toss food that was sitting out uncovered</li>
  <li>Take trash out the morning of the visit and use a lidded can; dry the sink and tub before bed — roaches need water more than food</li>
  <li>Big reddish roaches that wander in from outside are palmetto bugs — that's exterior work; reply if that's what you're seeing</li>
</ul>

<h2>Day of</h2>
<p>Keep people and pets out of the kitchen until surfaces are dry and your technician confirms it's ready — bait goes into cracks, hinges, and voids, out of reach of kids and pets. The EPA-registered product is non-repellent — roaches walk through it, go back to the nest, and spread it — so don't spray over-the-counter products between our visits or you'll scatter them without killing them.</p>

<h2>Follow-up visits</h2>
<p>Your package includes the follow-up visits your infestation calls for; the first is at 10–14 days to hit the generation that hatches from existing eggs. Expect to still see a few roaches for the first 2–3 weeks — seeing MORE at first is normal too; treatment flushes them out, and that traffic spreads the bait. One rule while it works: don't deep-clean the baited zones (baseboards, hinges, cabinet corners) — cleaning products push roaches away from the bait. Normal counter-and-dish cleanup is fine once dry, and keep the kitchen dry and dish-free overnight for 30 days.</p>

<p>Questions? Reply here.</p>
${FOOTER}`,

  flea: `<h2>Hi {{first_name}} — let's get your home flea-free</h2>
<p>Your flea service is a two-visit elimination package: the initial treatment, then a follow-up about 14 days later timed to the egg-hatch window. It works best when the home, the pets, and the activity areas get handled together — twenty minutes of prep before each visit is what lets the two visits finish the job.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Vacuum carpets, rugs, under furniture and cushions, pet resting areas, and along baseboards — the vibration also wakes dormant fleas so the treatment reaches them. Seal the vacuum contents in plastic and take them to an outside bin.</li>
  <li>Wash pet bedding, blankets, and washable throws on a hot cycle and dry on high heat.</li>
  <li>Treat every pet the same day with a vet-recommended product — treating the home without treating the pets is how fleas come back. Dog and cat products are not interchangeable, and never use a dog product on a cat.</li>
  <li>Pick up toys, pet toys, pet bowls, clothes, and clutter from the floor so we can treat the full carpet area.</li>
  <li>Used a fogger or spray already? Tell your technician what and where — foggers don't reach fleas under furniture, and it changes how we treat.</li>
</ul>

<h2>After the treatment</h2>
<p>Keep people and pets off treated areas until they're dry — your technician will confirm when things are ready. You may still see fleas for up to a few weeks as protected pupae hatch — that's expected, not a failed treatment; the follow-up visit is what catches that hatch, so repeat the vacuuming and pet steps before it. Vacuum every day or two (it speeds things up), but hold off on mopping, shampooing, or steam-cleaning treated floors — wet cleaning strips the EPA-registered product that's still catching new hatchers. Yard treatment is an add-on: reply if you're seeing fleas on the lanai or in the garage.</p>

<p>Reply to this email if anything on the list is unclear — we'd rather answer now than re-treat later.</p>
${FOOTER}`,
};

const STEP_SWAPS = refresh.STEP_SWAPS.map((s) => ({
  templateKey: s.templateKey,
  fromHtml: s.toHtml,
  toHtml: STEP_BODIES[s.templateKey],
}));
for (const s of STEP_SWAPS) {
  if (!s.toHtml) throw new Error(`20260924000005: no v3 step body for ${s.templateKey}`);
}

function textFromHtml(html) {
  return String(html || '')
    .replace(/<li>/g, '• ')
    .replace(/<\/(h2|p|li|ul)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
    throw new Error(`20260924000005: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
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

async function swapStepBody(knex, { templateKey, fromHtml, toHtml }, direction) {
  const from = direction === 'up' ? fromHtml : toHtml;
  const to = direction === 'up' ? toHtml : fromHtml;
  const step = await knex('automation_steps')
    .where({ template_key: templateKey })
    .orderBy('step_order', 'asc')
    .first();
  if (!step || String(step.html_body || '') !== from) return; // admin-edited: leave alone
  await knex('automation_steps').where({ id: step.id }).update({
    html_body: to,
    text_body: textFromHtml(to),
    updated_at: new Date(),
  });
}

exports.TEMPLATES = TEMPLATES;
exports.PATCHES = PATCHES;
exports.STEP_SWAPS = STEP_SWAPS;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.SUPERSEDES = base.MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      await publishVersion(knex, t);
    }
  }
  if (await knex.schema.hasTable('automation_steps')) {
    for (const swap of STEP_SWAPS) {
      await swapStepBody(knex, swap, 'up');
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
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
  }
  if (await knex.schema.hasTable('automation_steps')) {
    for (const swap of STEP_SWAPS) {
      await swapStepBody(knex, swap, 'down');
    }
  }
};
