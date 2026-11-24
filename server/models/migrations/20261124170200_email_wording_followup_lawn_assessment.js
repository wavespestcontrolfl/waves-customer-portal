'use strict';

/**
 * EMAIL WORDING, PART 1: FOLLOW-UP, LAWN SETUP, ASSESSMENT LINK (owner 2026-11-24, "ok do
 * whatever you rec" = changes 1 2 3, *assessment*, *adam keep*; plan page NWMRcRWj). Approved
 * copy, no gate. Data only, no schema.
 *
 * Change 1 (service.report_ready) is NOT here: its new opening reads {{visit_done_line}}, which
 * this PR adds to the report payload. Railway runs migrations before the new code serves, so the
 * template publishes in a later migration, once a deploy carrying the payload is live.
 *
 * Change 2 - estimate.engage_gone_quiet. The subject becomes "One question about your Waves
 *   estimate" (no service name: a one-time quote's fallback label is "service quote"). The "Take another look" button, the PDF note under it and the consultation
 *   link move up to directly after {{category_question}}, followed by "Went another way? Tell us
 *   that too. No hard feelings." Every other block stays, in its order.
 * Change 3 - irrigation.weekly_setup_schedule and irrigation.weekly_setup_system. The subject is
 *   a question with no number in it. Directly after the {{rain_sentence}} paragraph: one sentence
 *   on what we can do with their watering, the request, the button ("Update my watering details", the
 *   same link), and an offer to reply instead. The old button lower down goes. setup_schedule's
 *   request is its own {{schedule_ask}} callout, moved up (it says what is on file and what is
 *   still missing); setup_system's fixed "We don't have your watering amount yet ..." callout is
 *   replaced by one sentence that asks for days and run times, or a weekly amount by hand.
 * Assessment link - the "free consultation" text link becomes "Rather have us come look first?
 *   Book a Waves Assessment →" (owner 11-23: no free inspections, book an assessment) in
 *   estimate.engage_gone_quiet and in the unsent nurture.expired_1 draft (its draft version is
 *   relabeled in place; nothing is published there).
 * The billing.rate_review_notice "Adam" signature stays (*adam keep*): not touched.
 *
 * Publish mechanics follow 20261122140000 / 20261019200000: template row locked, ONE new active
 * version by compare-and-swap on the active version, only the replaced version archived. Each
 * transform is anchored on the exact live blocks and subject; a template an administrator has
 * edited away from them is left whole and logged, never half-patched. No variable is added, so
 * no fixture or allowed-variable list changes.
 *
 * down: a no-op, as in 20261122140000. To go back, republish the prior version from the template
 * library, or ship a forward migration.
 */

const MIGRATION = '20261124170200';
const MARKER = `migration:${MIGRATION}`;

const OLD_CONSULT = 'Rather have us come look first? Pick a time for a free consultation →';
const NEW_CONSULT = 'Rather have us come look first? Book a Waves Assessment →';

// A block anchors a move only when it is exactly the seeded block (every key and value), so a
// block an administrator relabeled or reworded leaves the whole template as it is.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const sameBlock = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const indexOfBlock = (blocks, seeded) => blocks.findIndex((b) => sameBlock(b, seeded));

// ---- Change 2: estimate.engage_gone_quiet --------------------------------------------------
const GONE_QUIET = {
  subjectBefore: 'Any questions about your Waves estimate?',
  subjectAfter: 'One question about your Waves estimate',
  noHardFeelings: 'Went another way? Tell us that too. No hard feelings.',
  question: { type: 'paragraph', content: '{{category_question}}' },
  cta: { type: 'cta', label: 'Take another look', url_variable: 'estimate_url' },
  pdf: { type: 'paragraph', content: '{{estimate_pdf_note}}' },
  consult: { type: 'cta', label: OLD_CONSULT, variant: 'link', url_variable: 'consultation_url' },
};

function goneQuietUp(blocks) {
  if (blocks.some((b) => b?.type === 'paragraph' && b.content === GONE_QUIET.noHardFeelings)) return { outcome: 'already' };
  const question = indexOfBlock(blocks, GONE_QUIET.question);
  const cta = indexOfBlock(blocks, GONE_QUIET.cta);
  const consult = indexOfBlock(blocks, GONE_QUIET.consult);
  if (question < 0 || cta < 0 || consult < 0 || cta < question || consult < cta) {
    return { outcome: 'skipped', note: 'question, estimate button or consultation link not as seeded' };
  }
  // The PDF note travels with the button, so it must still be the seeded one right under it;
  // an edited or moved note means an administrator changed this part, and the template is left whole.
  const pdf = cta + 1;
  if (!blocks[pdf] || !sameBlock(blocks[pdf], GONE_QUIET.pdf)) {
    return { outcome: 'skipped', note: 'PDF note under the estimate button not as seeded' };
  }
  const moved = new Set([cta, consult, pdf]);
  const group = [
    blocks[cta],
    blocks[pdf],
    { ...blocks[consult], label: NEW_CONSULT },
    { type: 'paragraph', content: GONE_QUIET.noHardFeelings },
  ];
  const out = [];
  blocks.forEach((b, i) => {
    if (moved.has(i)) return;
    out.push(b);
    if (i === question) out.push(...group);
  });
  return { outcome: 'changed', blocks: out };
}

// ---- Change 3: irrigation setup emails -----------------------------------------------------
const IRRIGATION = {
  subjectBefore: "Here's what fell on your lawn last week, {{first_name}}",
  subjectAfter: 'Does your lawn need more water this week, {{first_name}}?',
  rain: { type: 'paragraph', content: '{{rain_sentence}} This time of year your {{grass_label}} needs roughly {{target_inches}}" of water a week — rain and watering counted together.' },
  cta: { type: 'cta', label: 'ADD MY WATERING SCHEDULE', url_variable: 'customer_portal_url' },
  ctaAfter: 'Update my watering details',
  systemCallout: "We don't have your watering amount yet. Open Irrigation in your portal and add how much you water each week — once we have it, we can tell you every week whether to ease back, add a little, or leave things alone. Water by hand or have an unusual setup? Just reply to this email and tell us, and we'll get it set up for you.",
  // setup_schedule: its {{schedule_ask}} callout already says what is on file and what is still
  // missing (days and run times, or weekly inches for mixed heads), so it moves up as the request
  // and the intro sentence asks for nothing on its own.
  schedule: {
    ask: 'We can tell you each week to water more, less, or the same.',
    reply: "Easier by email? Reply with the details above. We'll enter them for you.",
  },
  // setup_system: nothing usable is on file, and the customer may have sprinklers, water by hand
  // or have no system at all, so the ask names how they water first. Weekly inches need the head
  // type with the days and minutes (irrigation-weekly-email.js buildScheduleAsk), or measured
  // inches; anyone without sprinklers replies, as the old callout said.
  system: {
    ask: 'We can tell you each week to water more, less, or the same. We just need to know how you water. With sprinklers, that is your head type (spray or rotor), your watering days and minutes per zone, or your weekly inches if you know them.',
    reply: "Water by hand, have no sprinklers, or rather do this by email? Reply and tell us how you water. We'll get it set up for you.",
  },
};

function irrigationUp(kind) {
  const copy = IRRIGATION[kind];
  return (blocks) => {
    if (blocks.some((b) => b?.type === 'paragraph' && b.content === copy.ask)) return { outcome: 'already' };
    const rain = indexOfBlock(blocks, IRRIGATION.rain);
    const cta = indexOfBlock(blocks, IRRIGATION.cta);
    const callout = indexOfBlock(blocks, { type: 'callout', content: kind === 'system' ? IRRIGATION.systemCallout : '{{schedule_ask}}' });
    if (rain < 0 || cta < 0 || cta < rain || callout < 0) {
      return { outcome: 'skipped', note: 'rain sentence, watering button or setup callout not as seeded' };
    }
    // setup_system drops its fixed callout (the ask replaces it); setup_schedule moves its
    // {{schedule_ask}} callout up, right under the intro sentence.
    const request = kind === 'schedule' ? [blocks[callout]] : [];
    const out = [];
    blocks.forEach((b, i) => {
      if (i === cta || i === callout) return;
      out.push(b);
      if (i === rain) {
        out.push(
          { type: 'paragraph', content: copy.ask },
          ...request,
          { ...blocks[cta], label: IRRIGATION.ctaAfter },
          { type: 'paragraph', content: copy.reply },
        );
      }
    });
    return { outcome: 'changed', blocks: out };
  };
}

const PLANS = [
  { key: 'estimate.engage_gone_quiet', up: goneQuietUp, subject: [GONE_QUIET.subjectBefore, GONE_QUIET.subjectAfter] },
  { key: 'irrigation.weekly_setup_schedule', up: irrigationUp('schedule'), subject: [IRRIGATION.subjectBefore, IRRIGATION.subjectAfter] },
  { key: 'irrigation.weekly_setup_system', up: irrigationUp('system'), subject: [IRRIGATION.subjectBefore, IRRIGATION.subjectAfter] },
];

const DRAFT_RELABELS = ['nurture.expired_1'];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// A field is changed only from its exact seeded value; an edited one is left as the admin set it.
// The new version is published only when the blocks AND the subject are still as seeded, so the
// email never ships half old and half new.
function planVersion(plan, prior) {
  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) return { outcome: 'skipped', note: 'active blocks unreadable' };
  const result = plan.up(blocks);
  if (result.outcome !== 'changed') return result;
  if (prior.subject !== plan.subject[0]) return { outcome: 'skipped', note: 'subject edited since seeding' };
  if (prior.text_body != null && String(prior.text_body).trim()) return { outcome: 'skipped', note: 'custom plain-text body present' };
  return {
    outcome: 'changed',
    blocks: result.blocks,
    subject: plan.subject[1],
  };
}

async function publishPlan(knex, plan) {
  const template = await knex('email_templates').where({ template_key: plan.key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';

  const next = planVersion(plan, prior);
  if (next.outcome === 'already') return 'already';
  if (next.outcome === 'skipped') {
    console.warn(`[${MARKER}] ${plan.key}: ${next.note}; template left as-is`);
    return 'skipped';
  }


  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, ...next });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${plan.key}: new version failed variable validation (${JSON.stringify(validation)}); template left as-is`);
    return 'skipped';
  }

  const now = new Date();
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    // Savepoint: the admin editor allocates draft numbers the same way (max + 1, no lock),
    // so a concurrent draft can take this number.
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: next.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(next.blocks),
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
    .update({
      active_version_id: created.id,
      last_published_at: now,
      updated_at: now,
    });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return 'published';
}

function relabelConsult(blocks) {
  let changed = false;
  const out = blocks.map((b) => {
    if (b?.type === 'cta' && b.url_variable === 'consultation_url' && b.label === OLD_CONSULT) {
      changed = true;
      return { ...b, label: NEW_CONSULT };
    }
    return b;
  });
  return { changed, blocks: out };
}

// Drafts only: the expired-estimate email was never published, so its draft version is
// relabeled in place. An active or archived version is never touched here.
async function relabelDrafts(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).forUpdate().first();
  if (!template) return 'missing';
  // Locked: the draft editor writes the version row directly; relabel only the latest committed blocks.
  const drafts = await knex('email_template_versions').where({ template_id: template.id, status: 'draft' }).forUpdate();
  let changed = 0;
  for (const v of drafts) {
    const blocks = json(v.blocks, null);
    if (!Array.isArray(blocks)) continue;
    // A custom plain-text body would keep the old offer while the HTML says the new one.
    if (v.text_body != null && String(v.text_body).trim()) {
      console.warn(`[${MARKER}] ${key}: draft v${v.version_number} has a custom plain-text body; left for manual review`);
      continue;
    }
    const r = relabelConsult(blocks);
    if (!r.changed) continue;
    const n = await knex('email_template_versions')
      .where({ id: v.id, status: 'draft' })
      .update({ blocks: JSON.stringify(r.blocks), updated_at: new Date() });
    changed += n;
  }
  return changed ? `relabeled ${changed}` : 'already';
}

async function run(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    for (const plan of PLANS) results[plan.key] = await publishPlan(trx, plan);
    for (const key of DRAFT_RELABELS) results[key] = await relabelDrafts(trx, key);
    console.log(`[${MARKER}] ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    if (await trx.schema.hasTable('audit_log')) {
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

exports._private = {
  PLANS, GONE_QUIET, IRRIGATION, OLD_CONSULT, NEW_CONSULT,
  goneQuietUp, irrigationUp, relabelConsult, planVersion,
};
