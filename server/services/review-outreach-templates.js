/**
 * Review Outreach template registry (server-authoritative).
 *
 * These are the bodies the admin "Review Outreach" composer offers and the
 * multi-touch cadence sends. They live here, on the server, so the template the
 * operator selects/edits is the template that actually goes out — previously the
 * client held them and the server ignored them, always sending a single
 * canonical message (audit finding O2).
 *
 * Placeholders ({first}, {tech}, {service_type}, {review_url}, ...) are
 * substituted by renderOutreachBody. {review_url} always resolves to the
 * tokenized NPS rate page (/rate/<token>), never a bare Google link, so the
 * happy→Google / issue→private gate is preserved regardless of which template
 * an operator picks.
 *
 * The mirror in client/src/pages/admin/ReviewVelocityEngine.jsx (TEMPLATES) is
 * presentation-only; this module is the single source of truth for the body
 * that sends.
 */

const OUTREACH_TEMPLATES = [
  {
    id: 'friendly_ask',
    name: 'Friendly Ask',
    sentiment: 'happy',
    body: "Hey {first}! This is Adam with Waves Pest Control. Thanks for being a great customer — it means the world to our small family business.\n\nIf you have 30 seconds, a quick Google review would help us more than you know:\n\n{review_url}\n\nThank you!",
  },
  {
    id: 'soft_reminder',
    name: 'Soft Reminder (Day 3)',
    sentiment: 'happy',
    body: "Hi {first}! Just a quick follow-up from Waves. If you had a chance to leave us a review, we'd really appreciate it — helps other families find us.\n\n{review_url}\n\nThanks so much!",
  },
  {
    id: 'final_nudge',
    name: 'Final Nudge (Day 7)',
    sentiment: 'happy',
    body: "Hey {first} — last one from us, promise! If you've been happy with Waves, a 15-second Google review would mean a lot to our crew.\n\n{review_url}\n\nEither way, thank you for trusting us with your home!",
  },
  {
    id: 'post_service_hot',
    name: 'Post-Service Hot (2hr)',
    sentiment: 'happy',
    body: "Hey {first}! {tech} here from Waves. Just finished up at your place — hope everything looks great!\n\nIf you have a sec, a quick Google review would make my day:\n\n{review_url}\n\nThanks for choosing Waves!",
  },
  {
    id: 'service_specific_pest',
    name: 'Service-Specific: Pest Control',
    sentiment: 'happy',
    body: "Hi {first}! After your {service_type} treatment, we hope the critters are staying away!\n\nIf we earned it, a quick review would help other SWFL families find us:\n\n{review_url}\n\nThank you!",
  },
  {
    id: 'service_specific_lawn',
    name: 'Service-Specific: Lawn Care',
    sentiment: 'happy',
    body: "Hey {first}! Hope the yard is looking great after your {service_type} service.\n\nIf you're loving the results, a quick review would mean the world:\n\n{review_url}\n\n— The Waves Crew",
  },
  {
    id: 'resolution_check',
    name: 'Issue Resolution Check',
    sentiment: 'issue',
    // No review link — this is a private check-in, not an ask.
    body: "Hi {first}, this is Adam with Waves. I wanted to follow up and make sure everything's been taken care of. Your satisfaction is our top priority.\n\nPlease let me know if there's anything else we can do. — Waves",
  },
  {
    id: 'satisfaction_confirm',
    name: 'Satisfaction Confirm',
    sentiment: 'issue',
    body: "Hey {first} — just checking in one more time. Is everything resolved to your satisfaction? We want to make sure you're 100% happy. Let me know!",
  },
  {
    id: 'recovery_review',
    name: 'Recovery → Review',
    sentiment: 'issue',
    body: "Hi {first}! Glad we got everything sorted. Since you mentioned things are looking good now, would you mind sharing your experience?\n\n{review_url}\n\nYour feedback helps us keep getting better. Thank you!",
  },
  {
    id: 'winback_checkin',
    name: 'Win-Back Check-In',
    sentiment: 'neutral',
    body: "Hey {first}! It's been a while since your last Waves service. Hope everything's been great at the property.\n\nJust wanted to check in — let us know if you need anything!",
  },
  {
    id: 'winback_ask',
    name: 'Win-Back Review Ask',
    sentiment: 'neutral',
    body: "Hi {first}! We realized we never asked — if you were happy with your Waves service, a quick Google review would mean the world to our small team:\n\n{review_url}\n\nThanks so much!",
  },
  {
    id: 'qr_followup',
    name: 'QR Code Follow-Up',
    sentiment: 'happy',
    body: "Hey {first}! Great seeing you today. Here's that review link one more time in case you didn't get a chance:\n\n{review_url}\n\nThanks for supporting Waves!",
  },
];

const TEMPLATES_BY_ID = Object.fromEntries(OUTREACH_TEMPLATES.map((t) => [t.id, t]));

// Templates that carry NO review link — private check-ins (issue resolution /
// satisfaction confirm), not review asks. They must not count toward the review
// 3-cap / 30-day cooldown, and they must not trigger the legacy Day-3 follow-up.
const NO_LINK_TEMPLATE_KEYS = OUTREACH_TEMPLATES
  .filter((t) => !t.body.includes("{review_url}"))
  .map((t) => t.id);

// True when a template (by id) is an actual review ask (contains a link). An
// unknown / null id is treated as an ask (the canonical post-service template).
function isAskTemplate(id) {
  if (!id) return true;
  const t = TEMPLATES_BY_ID[id];
  return t ? t.body.includes("{review_url}") : true;
}

/**
 * Default multi-touch cadence: Day 0 SMS → Day 3 SMS → Day 7 email.
 * Mirrors ReviewRover's "a couple of SMS then an email" pattern. The day
 * offsets are measured from the sequence start. Channel is the *intent*; the
 * sender downgrades/swaps based on what contact info + opt-ins the customer
 * actually has.
 */
const DEFAULT_SEQUENCE_PLAN = [
  { day: 0, channel: 'sms', templateKey: 'friendly_ask' },
  { day: 3, channel: 'sms', templateKey: 'soft_reminder' },
  { day: 7, channel: 'email', templateKey: 'final_nudge' },
];

function getOutreachTemplate(id) {
  return TEMPLATES_BY_ID[id] || null;
}

/**
 * Substitute placeholders in a template body. Always guarantees the review link
 * is present for ask-style templates: if the (possibly operator-edited) body
 * dropped the {review_url} token, the link is appended — except for the
 * issue/check-in templates that deliberately carry no link.
 *
 * @param {string} body        raw template body (with {placeholders})
 * @param {object} vars        { first, name, tech, service_type, review_url, date }
 * @param {object} [opts]      { requireLink:boolean } force-append the link
 */
function renderOutreachBody(body, vars = {}, opts = {}) {
  const v = {
    first: vars.first || vars.name || 'there',
    name: vars.name || vars.first || 'there',
    tech: vars.tech || 'Adam',
    service_type: vars.service_type || 'service',
    review_url: vars.review_url || '',
    date: vars.date || '',
  };
  let out = String(body || '')
    .replace(/\{first\}/g, v.first)
    .replace(/\{name\}/g, v.name)
    .replace(/\{tech\}/g, v.tech)
    .replace(/\{service_type\}/g, v.service_type)
    .replace(/\{review_url\}/g, v.review_url)
    .replace(/\{date\}/g, v.date);

  // Safety net: if a link is required but the body no longer contains it
  // (operator deleted the token while editing), append it so the ask is never
  // sent without a way to act on it.
  if (opts.requireLink && v.review_url && !out.includes(v.review_url)) {
    out = `${out.trim()}\n\n${v.review_url}`;
  }
  return out;
}

module.exports = {
  OUTREACH_TEMPLATES,
  TEMPLATES_BY_ID,
  DEFAULT_SEQUENCE_PLAN,
  NO_LINK_TEMPLATE_KEYS,
  isAskTemplate,
  getOutreachTemplate,
  renderOutreachBody,
};
