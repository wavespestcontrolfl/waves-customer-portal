/**
 * Route customer-email CTA fixtures to the most specific existing surface.
 *
 * The app supports public token routes for onboarding/pay/receipt/report and
 * authenticated portal tabs through ?tab=. These fixture values keep exports
 * and test sends from showing generic portal/login links where a more useful
 * customer destination exists.
 */

const PORTAL = 'https://portal.wavespestcontrol.com';

const URLS = {
  dashboard: `${PORTAL}/?tab=dashboard`,
  plan: `${PORTAL}/?tab=plan`,
  visits: `${PORTAL}/?tab=visits`,
  billing: `${PORTAL}/?tab=billing`,
  property: `${PORTAL}/?tab=property`,
  request: `${PORTAL}/?tab=request`,
  loginDashboard: `${PORTAL}/login?next=%2F%3Ftab%3Ddashboard`,
  onboarding: `${PORTAL}/onboard/onb_2026_1042`,
  booking: `${PORTAL}/book?service=pest_control&source=quote-wizard`,
};

const PATCHES = {
  'quote.request_received': { booking_url: URLS.booking },
  'onboarding.24h_reminder': { onboarding_url: URLS.onboarding },
  'onboarding.72h_reminder': { onboarding_url: URLS.onboarding },
  'onboarding.expiring_notice': { onboarding_url: URLS.onboarding },
  'welcome.new_recurring': { portal_url: URLS.visits, customer_portal_url: URLS.visits },

  'prep.bed_bug': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.cockroach': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.rodent': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.flea': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.mosquito': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.lawn': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.termite': { prep_url: URLS.visits, customer_portal_url: URLS.visits },
  'prep.interior_pest': { prep_url: URLS.visits, customer_portal_url: URLS.visits },

  'payment.autopay_enabled': { customer_portal_url: URLS.billing },
  'payment.method_updated': { customer_portal_url: URLS.billing },
  'payment.method_expiring': { customer_portal_url: URLS.billing },
  'payment.plan_confirmed': { customer_portal_url: URLS.billing },
  'payment.refund_issued': { customer_portal_url: URLS.billing },

  'account.updated': {
    customer_portal_url: URLS.property,
    manage_preferences_url: URLS.visits,
  },
  'account.request_received': {
    customer_portal_url: URLS.dashboard,
    portal_requests_url: URLS.request,
  },
  'account.request_updated': {
    customer_portal_url: URLS.dashboard,
    portal_requests_url: URLS.request,
  },
  'portal.invite': {
    customer_portal_url: URLS.dashboard,
    portal_invite_url: URLS.loginDashboard,
  },

  'membership.started': { customer_portal_url: URLS.plan },
  'membership.updated': { customer_portal_url: URLS.plan },
  'membership.renewal_reminder': { customer_portal_url: URLS.plan },
  'membership.canceled': { customer_portal_url: URLS.plan },
  'membership.paused': { customer_portal_url: URLS.plan },
  'membership.reactivated': { customer_portal_url: URLS.plan },
};

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return value;
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('email_templates');
  const hasFixtures = await knex.schema.hasTable('email_template_fixtures');
  if (!hasTemplates || !hasFixtures) return;

  for (const [templateKey, patch] of Object.entries(PATCHES)) {
    const template = await knex('email_templates').where({ template_key: templateKey }).first();
    if (!template) continue;

    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();

    if (!fixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Happy path',
        payload: JSON.stringify({ first_name: 'Taylor', ...patch }),
        is_default: true,
      });
      continue;
    }

    const payload = parsePayload(fixture.payload);
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: JSON.stringify({ ...payload, ...patch }),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down() {
  // Fixture routing polish is intentionally retained.
};
