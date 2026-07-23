'use strict';

/**
 * Marketing-video modules for the estimate.engage_* templates (owner
 * 2026-07-23: "add marketing videos for the reports for pest and lawn and
 * tree and shrub, and the waves app — videos to get potential customers
 * excited about signing up").
 *
 * The videos are motion tours of the REAL report pages and the REAL
 * customer app (current UI, fixture personas — never customer data),
 * hosted as portal static assets under /app-email/videos/. Email clients
 * can't play video, so the modules render as clickable stills:
 * - REPORT tour: an animated GIF preview (autoplays in most clients;
 *   Outlook shows the first frame) linking to the mp4. Per-category via
 *   the {{report_video_*}} slots filled by estimate-followup-copy.js —
 *   categories whose plan doesn't produce one of the three report types
 *   get empty slots and the renderer drops the blocks (same truth-scope
 *   mechanism as the FAQ rows).
 * - APP tour: a static poster (play button baked in) linking to the mp4 —
 *   one animated GIF per email is the weight budget. Static URLs: the app
 *   is the same for every category. This replaces APP_MODULE's
 *   reschedule-slots still — the tour opens on that same current UI.
 *
 * Mechanics: transforms the 20260715200000 seed's _TEMPLATES in place
 * (splice-by-anchor with loud failures, never silent drift) and re-runs
 * the same upsert. This is a NEW migration because 20260715200000 already
 * ran in prod. down() re-publishes the original seed content. The lane
 * stays dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP either way.
 */

const seed = require('./20260715200000_seed_estimate_engage_email_templates');

const IMG = 'https://portal.wavespestcontrol.com/app-email';
const VIDEOS = `${IMG}/videos`;

// Anchors in the seed content (throw if the seed ever changes shape —
// a migration that can't find its splice points must fail, not half-apply).
const PROTOCOL_ANCHOR = 'After every visit, you get a detailed service report';
const APP_IMAGE_ANCHOR = `${IMG}/app-reschedule-slots.png`;

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

const APP_VIDEO_BLOCKS = [
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

const VIDEO_VARIABLES = ['report_video_preview', 'report_video_url', 'report_video_caption'];

// gone_quiet carries no protocol/app module in the seed but is the
// re-engagement touch where fresh content earns its keep — it gets the
// report tour ahead of its FAQ module.
const GONE_QUIET_KEY = 'estimate.engage_gone_quiet';
const GONE_QUIET_ANCHOR = 'A few things folks usually ask';

const FIXTURE_VIDEO = {
  report_video_preview: `${VIDEOS}/waves-pest-tour-preview.gif`,
  report_video_url: `${VIDEOS}/waves-pest-tour.mp4`,
  report_video_caption: 'Tap to watch — what a real Waves pest control report looks like.',
};

function transformTemplates(templates) {
  return templates.map((t) => {
    const next = JSON.parse(JSON.stringify(t));
    const blocks = next.blocks || [];
    let touched = false;

    // Report tour: right after the protocol paragraph, wherever it appears.
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (typeof blocks[i]?.content === 'string' && blocks[i].content.startsWith(PROTOCOL_ANCHOR)) {
        blocks.splice(i + 1, 0, ...JSON.parse(JSON.stringify(REPORT_VIDEO_BLOCKS)));
        touched = true;
      }
    }
    if (next.key === GONE_QUIET_KEY) {
      const at = blocks.findIndex((b) => b?.type === 'heading' && b.content === GONE_QUIET_ANCHOR);
      if (at === -1) throw new Error(`engage-video migration: FAQ anchor missing in ${next.key}`);
      blocks.splice(at, 0, ...JSON.parse(JSON.stringify(REPORT_VIDEO_BLOCKS)));
      touched = true;
    }

    // App tour: replace the reschedule still inside APP_MODULE.
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]?.type === 'image' && blocks[i].src === APP_IMAGE_ANCHOR) {
        blocks.splice(i, 1, ...JSON.parse(JSON.stringify(APP_VIDEO_BLOCKS)));
        touched = true;
      }
    }

    if (touched) {
      next.optional = [...new Set([...(next.optional || []), ...VIDEO_VARIABLES])];
      next.fixture = { ...(next.fixture || {}), ...FIXTURE_VIDEO };
    }
    return next;
  });
}

const TEMPLATES = transformTemplates(seed._TEMPLATES);

// Sanity: the owner ask covers the report tour on every long-form touch and
// the app tour on the three templates that carried APP_MODULE.
const WITH_REPORT = TEMPLATES.filter((t) => (t.blocks || []).some(
  (b) => b?.src === '{{report_video_preview}}',
)).map((t) => t.key);
const WITH_APP = TEMPLATES.filter((t) => (t.blocks || []).some(
  (b) => b?.src === `${VIDEOS}/waves-app-tour-poster.jpg`,
)).map((t) => t.key);
if (WITH_REPORT.length !== 4 || WITH_APP.length !== 3) {
  throw new Error(`engage-video migration: expected 4 report / 3 app placements, got ${WITH_REPORT.length}/${WITH_APP.length}`);
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

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    for (const t of TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
};

exports.down = async function down(knex) {
  // Restore the pre-video seed content (blocks, variable lists, fixtures).
  if (await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')) {
    for (const t of seed._TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
};

// Exported for the placement-pinning test.
exports._TEMPLATES = TEMPLATES;
exports._private = { transformTemplates, WITH_REPORT, WITH_APP, VIDEO_VARIABLES };
