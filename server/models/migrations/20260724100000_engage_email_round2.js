'use strict';

/**
 * Engage email round 2 (owner 2026-07-24, on reviewing the live set):
 *  1. "Let's not use the van picture in every email" — the why-Waves van
 *     photo now rides ONLY the two flagship never-viewed emails
 *     (engage_unopened, engage_expiring_unseen). The why-Waves heading +
 *     claim checklist stays on all 7.
 *  2. "Where are the service reports?" — the per-category report-tour
 *     module ({{report_video_*}} preview -> mp4) now rides ALL 7 templates
 *     (was 4): added to return_visit, high_intent, and expiring. Same
 *     truth-scope mechanism — no-video categories drop the blocks.
 *  3. "The 2/7 email should be after the 3/7" — the hot-second-visit rule
 *     (return_visit_hot) now sends the strong accept email
 *     (engage_high_intent: "Ready when you are — it takes about a
 *     minute"), and the 3+-views rule (multi_view_high_intent) sends the
 *     help-forward questions email (engage_return_visit: "Welcome back —
 *     questions about your estimate?"). A fast return is the hot moment;
 *     repeated looks without accepting usually means an unanswered
 *     question. Swap is guarded so admin-edited template_key values are
 *     never clobbered.
 *
 * Transforms chain on the 20260723300000 video migration's export; its
 * splice-by-anchor/loud-failure pattern is kept. down() restores that
 * migration's template state and swaps the rules back (same guards).
 */

const videoRound = require('./20260723300000_engage_video_modules');

const VAN_KEEP = new Set(['estimate.engage_unopened', 'estimate.engage_expiring_unseen']);
const VAN_RE = /\/why-waves-van-(home|streets)\.jpg$/;

const REPORT_VIDEO_BLOCKS = [
  {
    type: 'image',
    src: '{{report_video_preview}}',
    href: '{{report_video_url}}',
    alt: 'Tap to watch: a tour of a real Waves service report',
    width: 520,
    radius: 18,
  },
  { type: 'small_note', content: '{{report_video_caption}}' },
];

// Where the report tour lands in the three templates that lacked it —
// right after the category substance paragraph each one carries.
const INSERT_AFTER = {
  'estimate.engage_return_visit': '{{category_process}}',
  'estimate.engage_high_intent': '{{category_process}}',
  'estimate.engage_expiring': '{{category_included}}',
};

const VIDEO_VARIABLES = ['report_video_preview', 'report_video_url', 'report_video_caption'];
const FIXTURE_VIDEO = {
  report_video_preview: 'https://portal.wavespestcontrol.com/app-email/videos/waves-pest-tour-preview.gif',
  report_video_url: 'https://portal.wavespestcontrol.com/app-email/videos/waves-pest-tour.mp4',
  report_video_caption: 'Tap to watch — what a real Waves pest control report looks like.',
};

function transformTemplates(templates) {
  return templates.map((t) => {
    const next = JSON.parse(JSON.stringify(t));
    const blocks = next.blocks || [];

    // 1. Van photo only on the flagships.
    if (!VAN_KEEP.has(next.key)) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i]?.type === 'image' && VAN_RE.test(blocks[i].src || '')) blocks.splice(i, 1);
      }
    }

    // 2. Report tour on the three templates that lacked it.
    const anchor = INSERT_AFTER[next.key];
    if (anchor) {
      const at = blocks.findIndex((b) => b?.content === anchor);
      if (at === -1) throw new Error(`engage-round2 migration: anchor ${anchor} missing in ${next.key}`);
      blocks.splice(at + 1, 0, ...JSON.parse(JSON.stringify(REPORT_VIDEO_BLOCKS)));
      next.optional = [...new Set([...(next.optional || []), ...VIDEO_VARIABLES])];
      next.fixture = { ...(next.fixture || {}), ...FIXTURE_VIDEO };
    }
    return next;
  });
}

const TEMPLATES = transformTemplates(videoRound._TEMPLATES);

const WITH_REPORT = TEMPLATES.filter((t) => (t.blocks || []).some(
  (b) => b?.src === '{{report_video_preview}}',
)).map((t) => t.key);
const WITH_VAN = TEMPLATES.filter((t) => (t.blocks || []).some(
  (b) => b?.type === 'image' && VAN_RE.test(b.src || ''),
)).map((t) => t.key);
if (WITH_REPORT.length !== 7 || WITH_VAN.length !== 2) {
  throw new Error(`engage-round2 migration: expected 7 report / 2 van placements, got ${WITH_REPORT.length}/${WITH_VAN.length}`);
}

// Same upsert mechanics as the seed (kept local — the seed doesn't export
// its helpers, and this must keep working even if that file is archived).
const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';
const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];
const CATEGORY_VARIABLES = [
  'service_label', 'category_headline', 'category_hook', 'category_benefit', 'category_question',
  'category_included', 'category_process',
  'faq_start', 'faq_terms', 'faq_between_visits', 'faq_price',
];
const BASE_FIXTURE = {
  first_name: 'Taylor',
  estimate_url: 'https://portal.wavespestcontrol.com/estimate/example-token',
  estimate_accept_url: 'https://portal.wavespestcontrol.com/estimate/example-token?intent=accept',
  service_label: 'pest control',
  category_headline: 'Your pest-free home plan is ready',
  category_hook: 'Your price was built from your home — lot, roofline, and entry points — not somebody else’s.',
  category_benefit: 'No long-term contract, unlimited free callbacks, and a 90-day money-back guarantee.',
  category_question: 'Wondering about pets and kids, interior treatment, or what happens if bugs come back? Reply and ask — real answers in minutes.',
  category_included: 'Exterior and interior pest protection on a recurring schedule, built around how bugs actually get into your home. And if pests show up between visits, callbacks are free and unlimited — that’s part of the plan, not an upsell.',
  category_process: 'Approve online, pick a time for your first visit, and your tech protects the outside and inside of your home — with a full report of what was treated and found after every visit.',
  faq_start: 'Whenever works for you. Most new customers pick a start date within 1–2 weeks.',
  faq_terms: 'No. We don’t do commitment contracts — you can pause or cancel anytime.',
  faq_between_visits: 'Free re-service. Reply to a service reminder text and we’re back out.',
  faq_price: 'Yes — for the quoted service, your price holds until the expiration date on your estimate. We’ll always tell you before anything changes.',
};

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

// Rule swap (guarded: only swap a row still pointing at its seeded value,
// so an admin-retargeted rule is never clobbered — in either direction).
const RULE_SWAP = [
  { rule_key: 'return_visit_hot', from: 'estimate.engage_return_visit', to: 'estimate.engage_high_intent' },
  { rule_key: 'multi_view_high_intent', from: 'estimate.engage_high_intent', to: 'estimate.engage_return_visit' },
];

async function applyRuleSwap(knex, swaps) {
  if (!(await knex.schema.hasTable('estimate_followup_rules'))) return;
  for (const s of swaps) {
    await knex('estimate_followup_rules')
      .where({ rule_key: s.rule_key, template_key: s.from })
      .update({ template_key: s.to, updated_at: new Date() });
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
  await applyRuleSwap(knex, RULE_SWAP);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    for (const t of videoRound._TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
  await applyRuleSwap(knex, RULE_SWAP.map((s) => ({ rule_key: s.rule_key, from: s.to, to: s.from })));
};

// Exported for the placement-pinning test.
exports._TEMPLATES = TEMPLATES;
exports._private = { transformTemplates, WITH_REPORT, WITH_VAN, RULE_SWAP };
