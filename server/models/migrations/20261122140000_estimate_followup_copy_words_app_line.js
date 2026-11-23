'use strict';

/**
 * ESTIMATE FOLLOW-UP WORDS + WAVES APP LINE (owner "words ok" 2026-11-22; approved copy, no gate).
 * Data only, no schema. Same class as 20260926120200_customer_copy_audit_automations and
 * 20261019200000_estimate_email_pdf_note: an owner-approved copy change.
 *
 * Part 1 - the 2-hour estimate email (automation_steps, template_key estimate_sent, step 0).
 *   A new first paragraph; the "Am I locked in?" and "What if I see activity between
 *   visits?" rows go (they are not true for every service); one Waves app paragraph
 *   follows the list. Exact-value compare-and-swap per field, as in 20260926120200: a
 *   row an administrator has edited since is left alone. subject and preview_text are
 *   not touched.
 *
 * Part 2 - "reschedule any visit yourself" becomes "reschedule a visit yourself" in the
 *   three live follow-up emails that carry the Waves app paragraph: estimate.engage_unopened,
 *   estimate.engage_expiring_unseen, estimate.engage_high_intent.
 *
 * Part 3 - the other four follow-up emails gain the same three blocks (the Waves app
 *   paragraph, the app-tour video still, its "Tap to watch" note), directly after the
 *   small_note whose content is {{report_video_caption}}, where the three live templates
 *   carry them: estimate.engage_expiring, estimate.engage_gone_quiet,
 *   estimate.engage_return_after_dark, estimate.engage_return_visit.
 *
 * Parts 2 and 3 publish like 20261019200000: the template row is locked first, ONE new
 * active version is published by compare-and-swap on the active version, and only the
 * version it replaces is archived (drafts and older versions are never touched). A
 * template whose blocks are unreadable, that already carries the change, that has no
 * {{report_video_caption}} anchor, or whose new version fails validation is left whole
 * and logged, never half-patched. No variable is added, so no fixture changes. The
 * version's text_body is carried over unchanged (production has none). One audit_log row
 * for the template publishes, and one per step row changed.
 *
 * down: a no-op, as in 20260926120200 and 20261019200000. A revert by content cannot tell
 * this migration's words from the same words an administrator published before it ran, so
 * it could undo an administrator's edit. To go back, republish the prior version from the
 * template library, or ship a forward migration.
 */

const MIGRATION = '20261122140000';
const MARKER = `migration:${MIGRATION}`;
const COPY_MIGRATION = '20261122140000_estimate_followup_copy_words_app_line';

const STEP_SWAPS = [
  {
    "key": "estimate_sent",
    "field": "html_body",
    "before": "<h2>Hi {{first_name}} — thanks for considering Waves</h2>\n<p>We sent your estimate over a couple of hours ago and wanted to follow up personally. No sales pitch — just making sure it landed and answering anything you're wondering about.</p>\n\n<h2>A few things folks usually ask</h2>\n<ul>\n  <li><strong>When can I start?</strong> Whenever. Most new customers pick a start date within 1–2 weeks.</li>\n  <li><strong>Am I locked in?</strong> No. We don't do commitment contracts — you can pause or cancel anytime.</li>\n  <li><strong>What if I see activity between visits?</strong> On recurring plans, re-services between visits are free — reply to a service reminder text and we're back out.</li>\n  <li><strong>Is the price locked in?</strong> Yes — for the quoted service, your price holds until the expiration date on your estimate. We'll always tell you before anything changes.</li>\n</ul>\n\n<p>If you've got a question that's not on that list, just reply to this email. It goes straight to our local team — no call center, no ticket queue.</p>\n\n<p>— The Waves Pest Control team</p>",
    "after": "<h2>Hi {{first_name}} — thanks for considering Waves</h2>\n<p>Any questions about your Waves estimate? Just reply to this email and a real person answers.</p>\n\n<h2>A few things folks usually ask</h2>\n<ul>\n  <li><strong>When can I start?</strong> Whenever. Most new customers pick a start date within 1–2 weeks.</li>\n  <li><strong>Is the price locked in?</strong> Yes — for the quoted service, your price holds until the expiration date on your estimate. We'll always tell you before anything changes.</li>\n</ul>\n\n<p>The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app.</p>\n\n<p>If you've got a question that's not on that list, just reply to this email. It goes straight to our local team — no call center, no ticket queue.</p>\n\n<p>— The Waves Pest Control team</p>"
  },
  {
    "key": "estimate_sent",
    "field": "text_body",
    "before": "Hi {{first_name}} — thanks for considering Waves. No sales pitch, just a quick follow-up to make sure the estimate landed. A few common questions: you can start whenever (most folks pick 1–2 weeks out); no commitment contracts, pause/cancel anytime; free re-service between visits on recurring plans; your price holds for the quoted service until the estimate expires. Reply with any questions — it goes straight to our local team. — The Waves Pest Control team",
    "after": "Hi {{first_name}} — thanks for considering Waves. Any questions about your Waves estimate? Just reply to this email and a real person answers. A couple of common questions: you can start whenever (most folks pick 1–2 weeks out); your price holds for the quoted service until the estimate expires. The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app. Reply with any questions — it goes straight to our local team. — The Waves Pest Control team"
  }
];

const VIDEOS = 'https://portal.wavespestcontrol.com/app-email/videos';
const ANY_VISIT = 'And the Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule any visit yourself, right from the app.';
const A_VISIT = 'And the Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app.';
const APP_MARKER = 'the Waves app keeps everything in one place';
const CAPTION = '{{report_video_caption}}';

// The three blocks the live templates carry (see 20260723300000_engage_video_modules).
const APP_BLOCKS = [
  { type: 'paragraph', content: A_VISIT },
  {
    type: 'image',
    src: `${VIDEOS}/waves-app-tour-poster.jpg`,
    href: `${VIDEOS}/waves-app-tour.mp4`,
    alt: 'Tap to watch: the Waves app — visits, reports, reschedule, and payments in one place',
    width: 520,
    radius: 18,
  },
  { type: 'small_note', content: 'Tap to watch the Waves app in action.' },
];

const WORDS_KEYS = ['estimate.engage_unopened', 'estimate.engage_expiring_unseen', 'estimate.engage_high_intent'];
const APP_KEYS = ['estimate.engage_expiring', 'estimate.engage_gone_quiet', 'estimate.engage_return_after_dark', 'estimate.engage_return_visit'];

const isCaption = (b) => b?.type === 'small_note' && b.content === CAPTION;
const mentionsApp = (b) => typeof b?.content === 'string' && b.content.includes(APP_MARKER);

// Pure transforms: { blocks, outcome: 'changed' | 'already' | 'skipped', note? }; the input is never mutated.
function swapSentence(blocksIn, from, to) {
  let changed = false;
  const blocks = blocksIn.map((b) => {
    if (b?.type === 'paragraph' && b.content === from) {
      changed = true;
      return { ...b, content: to };
    }
    return b;
  });
  return { blocks, outcome: changed ? 'changed' : 'already' };
}

function addAppBlocks(blocksIn) {
  if (blocksIn.some(mentionsApp)) return { blocks: blocksIn, outcome: 'already' };
  const at = blocksIn.findIndex(isCaption);
  if (at < 0) return { blocks: blocksIn, outcome: 'skipped', note: 'no {{report_video_caption}} note to anchor on' };
  const blocks = [...blocksIn];
  blocks.splice(at + 1, 0, ...structuredClone(APP_BLOCKS));
  return { blocks, outcome: 'changed' };
}

const PLANS = [
  ...WORDS_KEYS.map((key) => ({ key, up: (blocks) => swapSentence(blocks, ANY_VISIT, A_VISIT) })),
  ...APP_KEYS.map((key) => ({ key, up: addAppBlocks })),
];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

async function publishPlan(knex, plan) {
  const template = await knex('email_templates').where({ template_key: plan.key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${plan.key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  const { blocks: nextBlocks, outcome, note } = plan.up(blocks);
  if (outcome === 'already') return 'already';
  if (outcome === 'skipped') {
    console.warn(`[${MARKER}] ${plan.key}: ${note}; template left as-is`);
    return 'skipped';
  }

  const now = new Date();
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${plan.key}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    // Savepoint: the admin editor allocates draft numbers the same way
    // (max + 1, no lock), so a concurrent draft can take this number.
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(nextBlocks),
        text_body: prior.text_body ?? null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${plan.key}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return 'published';
}

async function auditStep(knex, id, key, field) {
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system',
    action: 'automation_copy_updated',
    resource_type: 'automation_steps',
    resource_id: id == null ? null : String(id),
    metadata: { migration: COPY_MIGRATION, template_key: key, field },
    critical: true,
    trx: knex,
  });
}

// Step 0 only: the seeded 2-hour email. A later estimate_sent step that reuses the same body
// is another email and stays as it is.
const STEP_ORDER = 0;

async function swapSteps(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return {};
  const hasAudit = await knex.schema.hasTable('audit_log');
  const results = {};
  for (const { key, field, before, after } of STEP_SWAPS) {
    const rows = await knex('automation_steps').where({ template_key: key, step_order: STEP_ORDER, [field]: before }).select('id');
    let changedRows = 0;
    for (const { id } of rows) {
      const changed = await knex('automation_steps')
        .where({ id, step_order: STEP_ORDER, [field]: before })
        .update({ [field]: after, updated_at: knex.fn.now() });
      if (changed) {
        changedRows += 1;
        if (hasAudit) await auditStep(knex, id, key, field);
      }
    }
    results[`${key}.${field}`] = changedRows;
  }
  return results;
}

async function run(knex) {
  await knex.transaction(async (trx) => {
    const steps = await swapSteps(trx);
    const results = {};
    if ((await trx.schema.hasTable('email_templates')) && (await trx.schema.hasTable('email_template_versions'))) {
      for (const plan of PLANS) {
        results[plan.key] = await publishPlan(trx, plan);
      }
    }
    console.log(`[${MARKER}] steps: ${JSON.stringify(steps)}; templates: ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'}`);
    if (Object.keys(results).length && await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results },
        critical: true,
        trx,
      });
    }
  });
}

exports.up = (knex) => run(knex);

exports.down = async function down() {
  // Intentionally no-op: a revert by content could erase an administrator's edit (see the header).
};

exports._private = { STEP_SWAPS, PLANS, APP_BLOCKS, ANY_VISIT, A_VISIT, WORDS_KEYS, APP_KEYS, swapSentence, addAppBlocks };
