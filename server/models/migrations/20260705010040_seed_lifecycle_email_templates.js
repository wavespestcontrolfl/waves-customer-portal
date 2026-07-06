'use strict';

/**
 * Seed five lifecycle email templates (owner directive 2026-07-05, from
 * the email-program audit):
 *
 *   estimate.accepted_onboarding — "You're booked — here's what happens
 *     next." Nothing currently sends between estimate acceptance and the
 *     appointment confirmation; this closes the highest-anxiety window.
 *   appointment.no_show — email twin of the existing no-show SMS.
 *   referral.invite — the portal has a Refer tab with zero email support.
 *   referral.reward_earned — reward confirmation when a referral converts.
 *   termite.bond_renewal — bond holders get a renewal notice that speaks
 *     to their warranty instead of the generic membership reminder.
 *
 * Templates are seeded ACTIVE so they render/preview in the admin
 * library, but nothing sends them yet — sender wiring is a separate
 * lane per template. Copy follows the 2026-07 email copy standard (one
 *job, one primary CTA, no invented service names, no fake numbers).
 *
 * Same upsert mechanics as 20260626000004 (app_intro seed).
 * NOTE deliberately generic termite-bond coverage language — warranty
 * terms are not owner-finalized; the copy never states specific
 * coverage promises.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATES = [
  {
    key: 'estimate.accepted_onboarding',
    name: 'Estimate Accepted — What Happens Next',
    category: 'onboarding',
    sensitivity: 'account',
    stream: 'service_operational',
    description: "Sent when a customer accepts their estimate: confirms the decision and walks them through what happens between now and the first visit.",
    required: ['first_name', 'service_type', 'company_phone'],
    optional: ['appointment_line'],
    subject: "You're booked, {{first_name}} — here's what happens next",
    preview: 'Your {{service_type}} plan is confirmed. Here’s the road to your first visit.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_type}} plan is confirmed — welcome aboard. Here’s exactly what happens next, so there are no surprises.' },
      { type: 'heading', content: 'Between now and your first visit' },
      { type: 'paragraph', content: '{{appointment_line}}' },
      { type: 'paragraph', content: 'Before we arrive you’ll get a confirmation with your arrival window, a reminder the day before, and a live tracking link when your technician is on the way. No need to be home for most services.' },
      { type: 'heading', content: 'After every visit' },
      { type: 'paragraph', content: 'You’ll get a full service report — what we treated, what we found, and photos from your property. It lands in your email and lives in your customer portal.' },
      { type: 'small_note', content: 'Questions before we come out? Reply to this email or call {{company_phone}} — a real person answers.' },
      { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      service_type: 'Quarterly Pest Control Service',
      appointment_line: 'Your first visit is scheduled for Tuesday, July 8 with an 8–10 AM arrival window.',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
    },
  },
  {
    key: 'appointment.no_show',
    name: 'Missed Visit — Let’s Reschedule',
    category: 'appointment',
    sensitivity: 'account',
    // Appointment notices are required transactional messages — matches
    // appointment.confirmation / reminders, and the library would
    // otherwise downgrade a sender's transactional override.
    stream: 'transactional_required',
    description: 'Email twin of the no-show SMS: we came out but could not complete the visit (no access, locked gate, pet loose). Zero blame; one rebook action. missed_when and charge_line are SENDER-COMPOSED: the visit may be back-dated, and card-hold no-shows are charged a fee (CardHolds.chargeNoShowFee) so the template never promises "no charge". rebook_url must be a fresh booking/portal link — the public /reschedule/:token route rejects no_show visits.',
    required: ['first_name', 'service_type', 'missed_when', 'rebook_url'],
    optional: ['no_show_reason', 'charge_line'],
    subject: 'We missed you — let’s find a new time',
    preview: 'We couldn’t complete your {{service_type}} visit. Rebooking takes a minute.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, we came out for your {{service_type}} visit {{missed_when}} but couldn’t complete the service. {{no_show_reason}}' },
      { type: 'paragraph', content: '{{charge_line}} Rebooking takes about a minute — nearby openings go fastest, so grabbing a slot now usually means we’re back within days.' },
      { type: 'small_note', content: 'If a locked gate or a pet kept us out, a quick note on the new appointment helps us plan around it.' },
      { type: 'cta', label: 'Pick a new time', url_variable: 'rebook_url' },
      { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      service_type: 'Quarterly Pest Control Service',
      missed_when: 'today',
      no_show_reason: 'The side gate was locked and we couldn’t reach the backyard safely.',
      charge_line: 'There’s no charge for the attempted visit.',
      rebook_url: 'https://portal.wavespestcontrol.com/?tab=visits',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
    },
  },
  {
    key: 'referral.invite',
    name: 'Referral Invite',
    category: 'referral',
    sensitivity: 'normal',
    // OWNER DIRECTIVE 2026-07-06: render in the SERVICE chrome (pill
    // header + card, like the bond renewal) — not the newsletter wrapper.
    // The invite still routes through the marketing_referral suppression
    // group (seeded 20260518000001, user-unsubscribable), so a referral
    // opt-out is honored at send time without touching service email,
    // and the body carries an explicit reply-to-opt-out line.
    // layout 'service_pinned_v1' is the chrome pin sendTemplate honors —
    // without it the marketing_referral stream forces the newsletter wrapper.
    stream: 'marketing_referral',
    layout: 'service_pinned_v1',
    description: 'Invites a happy customer to refer neighbors; the reward line comes from the sender so amounts are never baked into copy.',
    required: ['first_name', 'referral_url', 'referral_reward_line'],
    optional: [],
    subject: 'Know a neighbor with a pest problem, {{first_name}}?',
    preview: 'Share your link — you both win when they sign up.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, most of our new customers come from people like you — a neighbor asks who handles your pest control, and you point at the Waves truck.' },
      { type: 'paragraph', content: 'Your account has a personal referral link that makes it official: share it, and when a neighbor signs up, {{referral_reward_line}}' },
      { type: 'small_note', content: 'Your link lives in the Refer tab of your portal too — share it by text, email, or the neighborhood group.' },
      { type: 'cta', label: 'Get my referral link', url_variable: 'referral_url' },
      { type: 'small_note', content: 'Prefer not to get referral emails? Reply "no thanks" and we\'ll turn them off.' },
      { type: 'signature', content: 'Thank you for spreading the word. — The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      referral_url: 'https://portal.wavespestcontrol.com/?tab=refer',
      referral_reward_line: 'you get an account credit and they get a discounted first service.',
    },
  },
  {
    key: 'referral.reward_earned',
    name: 'Referral Reward Earned',
    category: 'referral',
    sensitivity: 'account',
    stream: 'service_operational',
    description: 'A referral converted — confirm the reward. The reward line, CTA label, and CTA destination come from the sender (referral-balance vs account-credit payouts point at different ledgers).',
    required: ['first_name', 'reward_line', 'cta_label'],
    optional: ['referred_first_name'],
    subject: 'Your referral came through — thank you',
    preview: '{{reward_line}}',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, good news: your referral signed up. {{reward_line}}' },
      { type: 'paragraph', content: 'Referrals like yours are the best compliment we get — thank you for trusting us with your neighbors.' },
      { type: 'cta', label: '{{cta_label}}', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you. — The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      referred_first_name: 'Jordan',
      reward_line: 'Your account credit has been applied and will show on your next invoice.',
      cta_label: 'View my account credit',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
    },
  },
  {
    key: 'termite.bond_renewal',
    name: 'Termite Bond Renewal',
    category: 'billing',
    // 'financial' matches the dunning series and is an admin-API-valid
    // sensitivity ('billing' is not in the accepted enum).
    sensitivity: 'financial',
    stream: 'transactional_required',
    description: 'Renewal notice for termite bond holders — speaks to continuous warranty protection rather than the generic membership reminder. Coverage language stays generic: warranty terms are not baked into copy.',
    required: ['first_name', 'renewal_date', 'company_phone'],
    optional: ['bond_term', 'property_label', 'renewal_url'],
    subject: 'Your termite bond renews {{renewal_date}}',
    preview: 'Keep your termite protection continuous — renewal is one tap.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your termite bond is coming up for renewal.' },
      { type: 'details', rows: [
        { label: 'Bond', value: '{{bond_term}}' },
        { label: 'Property', value: '{{property_label}}' },
        { label: 'Renews', value: '{{renewal_date}}' },
      ] },
      { type: 'paragraph', content: 'Renewing on time keeps your protection continuous — a lapse can mean re-inspection or re-treatment before coverage can restart, which costs more than the renewal.' },
      { type: 'small_note', content: 'Questions about what your bond covers? Reply to this email or call {{company_phone}} and we’ll walk through your specific terms.' },
      { type: 'cta', label: 'Renew my bond', url_variable: 'renewal_url' },
      { type: 'cta', label: 'View my account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'We look forward to servicing your home. — The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      bond_term: 'Termite Bond Service (1-Year Term)',
      property_label: '123 Palm Ave, Bradenton, FL 34211',
      renewal_date: 'August 1, 2026',
      renewal_url: 'https://portal.wavespestcontrol.com/login',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
    },
  },
];

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.category,
    legal_classification: t.legal || 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'account',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: t.layout || 'service_default_v1',
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
    const payload = { company_phone: REAL_PHONE, company_email: SERVICE_FROM, ...(t.fixture || {}) };
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
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  for (const t of TEMPLATES) {
    await upsertTemplate(knex, t);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Archive rather than delete — send logs may reference the rows.
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .update({ status: 'archived', updated_at: new Date() });
};
