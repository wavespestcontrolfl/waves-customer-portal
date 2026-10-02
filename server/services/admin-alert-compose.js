// The one way new admin notifications are written. Contract: docs/admin-notifications.md.
// composeAdminAlert is pure (no I/O); raiseAdminAlert routes the composed alert by severity.
// Errors name the field and the rule, never the text: headline and why carry customer names.
// notification-service is required at call time so composing never loads the database.
const logger = require('./logger');
const { truncateAtWord } = require('./ops-digest');
const { stripEmoji } = require('../utils/strip-emoji');

const AREAS = ['Comms', 'Schedule', 'Billing', 'Estimates', 'Leads', 'Customers', 'Inventory', 'Content', 'System'];
const SEVERITIES = ['needs-you', 'broken', 'fyi'];
const WHO = ['person', 'claude', 'either'];
const SUBJECT_TYPES = ['customer', 'visit', 'invoice', 'estimate', 'lead', 'call', 'check'];
const MAX_HEADLINE_CHARS = 60;
const MAX_WHY_CHARS = 110;
const RULE_CODE = 'ADMIN_ALERT_RULE';
const DONE_WHEN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

// Doc section 3: what never appears in a headline or a why. [slug, test(text)].
const FORBIDDEN = [
  ['iso_date', (t) => /\d{4}-\d{2}-\d{2}/.test(t)],
  ['hash', (t) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t) || /\b[0-9a-f]{12,}\b/i.test(t)],
  ['env_name', (t) => /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(t)],
  ['snake_case', (t) => /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/.test(t)],
  ['file_path', (t) => /~\/|\/[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z]\w{0,4}\b|\b[\w-]+(?:\/[\w.-]+)+\.[A-Za-z]\w{0,4}\b/.test(t)],
  ['bracket_tag', (t) => /\[[^\]]*\]/.test(t)],
  ['zero_new', (t) => /\b0 new\b/i.test(t)],
  ['action_prefix', (t) => /^(?:\w+ — )?(?:ACT|FIX|OK|FYI):/i.test(t)],
  ['exclamation', (t) => t.includes('!')],
  ['emoji', (t) => { const tidy = t.replace(/[ \t]{2,}/g, ' ').trim(); return stripEmoji(tidy) !== tidy; }],
];

// One rule for where a sentence ends, shared by the check and by callers that take a
// first sentence: a `.`, `?` or `!` followed by whitespace and an uppercase letter.
// The one exception is a title that is always followed by a name (Dr. Lee, St.
// Augustine, Mt. Dora). Anything else ending in a full stop and followed by a
// capital (Acme Inc. Retry, plan A. Review, an initial) is an end: regex cannot tell
// those apart, so the rule does not try. Lowercase or a digit after the stop never
// ends a sentence (11:00 a.m. on a call, approx. 40).
const TITLE_BEFORE_NAME = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Ft)\.$/;
function firstSentenceEnd(text) {
  const end = /[.?!]["')\]]?\s+(?=[A-Z])/g;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const upTo = text.slice(0, m.index + 1);
    if (!(upTo.endsWith('.') && TITLE_BEFORE_NAME.test(upTo))) return m.index + m[0].trimEnd().length;
  }
  return -1;
}
const hasSecondSentence = (text) => firstSentenceEnd(text) !== -1;
// The first sentence of free text (a customer's message), by the same rule.
function firstSentence(text) {
  const tidy = String(text || '').replace(/\s+/g, ' ').trim();
  const at = firstSentenceEnd(tidy);
  return at === -1 ? tidy : tidy.slice(0, at);
}

const ACTIVITY_FEED_LINK = /^\/admin\/agents\b.*\btab=activity/;
const isAdminLink = (link) => typeof link === 'string' && link.startsWith('/admin/');
// A needs-you alert's link must open the work: an admin page, never the Activity feed.
const linkIsUsable = (link) => isAdminLink(link) && !ACTIVITY_FEED_LINK.test(link);

function ruleError(violations, message = `Admin alert breaks docs/admin-notifications.md: ${violations.join(', ')}`) {
  return Object.assign(new Error(message), { code: RULE_CODE, violations });
}

function composeAdminAlert(spec = {}) {
  const { area, action, why, severity, link, subject, doneWhen, who } = spec;
  const v = [];
  if (!AREAS.includes(area)) v.push('area_invalid');
  if (!SEVERITIES.includes(severity)) v.push('severity_invalid');
  if (!WHO.includes(who)) v.push('who_invalid');
  if (!SUBJECT_TYPES.includes(subject?.type)) v.push('subject_type_invalid');
  const id = subject?.id;
  if (!((typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id)))) v.push('subject_id_invalid');
  if (!(typeof doneWhen === 'string' && DONE_WHEN.test(doneWhen))) v.push('done_when_invalid');
  if (typeof action !== 'string' || !action.trim()) v.push('action_missing');

  const headline = `${area} — ${typeof action === 'string' ? action.trim() : ''}`;
  if (headline.length > MAX_HEADLINE_CHARS) v.push('headline_too_long');
  const whyText = typeof why === 'string' ? why.trim() : '';
  if (!whyText && severity !== 'fyi') v.push('why_missing');
  if (whyText.length > MAX_WHY_CHARS) v.push('why_too_long');
  if (hasSecondSentence(whyText)) v.push('why_multiple_sentences');
  for (const [field, text] of [['headline', headline], ['why', whyText]]) {
    for (const [slug, hit] of FORBIDDEN) if (hit(text)) v.push(`${field}_forbidden_token:${slug}`);
  }

  if (link != null && !isAdminLink(link)) v.push('link_not_admin');
  if (severity === 'needs-you') {
    if (!link) v.push('link_required');
    else if (ACTIVITY_FEED_LINK.test(link)) v.push('link_is_activity_feed');
  }
  if (v.length) throw ruleError(v);
  return { headline, why: whyText, link: link || null, metadata: { area, severity, subject: { type: subject.type, id }, doneWhen, who } };
}

// The structured parts of a spec that are individually valid. The fallback below keeps
// them: a copy violation (a customer's own words carrying a date) must not cost the
// alert its subject, done-when and who, which is what a Claude session acts on.
function validStructuredFields(spec = {}) {
  const { area, severity, subject, doneWhen, who } = spec;
  const id = subject?.id;
  const idOk = (typeof id === 'string' && id.trim()) || (typeof id === 'number' && Number.isFinite(id));
  return {
    ...(AREAS.includes(area) ? { area } : {}),
    ...(SEVERITIES.includes(severity) ? { severity } : {}),
    ...(SUBJECT_TYPES.includes(subject?.type) && idOk ? { subject: { type: subject.type, id } } : {}),
    ...(typeof doneWhen === 'string' && DONE_WHEN.test(doneWhen) ? { doneWhen } : {}),
    ...(WHO.includes(who) ? { who } : {}),
  };
}

// needs-you rings through notifyAdmin under the emitter's own category; broken belongs to
// deliverOpsDigest (the Activity feed reads ops_digest rows only); fyi writes nothing,
// unless the owner has ruled that one specific FYI is worth a row: `opts.fyiRow` is that
// per-emitter opt-in (the /book preferred-time auto-close, owner ruling 2026-10-01).
// A violation in a live emitter never crashes its work and never drops a needs-you alert:
// it rings with the headline cut to fit and the violations stamped. Tests rethrow.
async function raiseAdminAlert(category, spec = {}, rawOpts = {}) {
  const { fyiRow = false, ...opts } = rawOpts;
  let composed;
  try {
    composed = composeAdminAlert(spec);
  } catch (err) {
    const { severity } = spec;
    if (err.code !== RULE_CODE || process.env.NODE_ENV === 'test' || (severity !== 'needs-you' && severity !== 'fyi')) throw err;
    logger.warn(`[admin-alert] ${category} broke the notification rule: ${err.violations.join(', ')}`);
    if (severity === 'fyi' && !fyiRow) return { id: null, suppressed: true, reason: 'fyi' };
    return require('./notification-service').notifyAdmin(category, truncateAtWord([spec.area, spec.action].filter(Boolean).join(' — '), MAX_HEADLINE_CHARS), spec.why, {
      ...opts, ...(linkIsUsable(spec.link) ? { link: spec.link } : {}), metadata: { ...opts.metadata, ...validStructuredFields(spec), ruleViolations: err.violations },
    });
  }
  if (spec.severity === 'broken') {
    throw ruleError(['broken_uses_ops_digest'], "A broken alert is not raised here: call deliverOpsDigest (server/services/ops-digest.js) with the composed headline and why as headline and summary and audience 'engineering'. The Activity feed reads ops_digest rows only.");
  }
  if (spec.severity === 'fyi' && !fyiRow) return { id: null, suppressed: true, reason: 'fyi' };
  return require('./notification-service').notifyAdmin(category, composed.headline, composed.why, {
    ...opts, link: composed.link, metadata: { ...(opts.metadata || {}), ...composed.metadata },
  });
}

module.exports = {
  AREAS, SEVERITIES, WHO, SUBJECT_TYPES, MAX_HEADLINE_CHARS, MAX_WHY_CHARS,
  composeAdminAlert, raiseAdminAlert, cutAtWord: truncateAtWord, firstSentence,
};
