// The one reader for "what is open". Owner and Claude sessions read the same list, each
// item in the shape of docs/admin-notifications.md section 2: what it is about, what would
// clear it, and who may act. Read-only, no LLM. Two sources: open admin notification rows (the bell's and the Activity feed's)
// and the dashboard's standing conditions. A source that fails reports a warning; the
// other still answers (CLAUDE.md rule 6).
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { computeDashboardAlerts } = require('./dashboard-alerts');
const { refsFromRow } = require('./admin-alert-relevance');
const { AREAS, SEVERITIES, WHO, SUBJECT_TYPES, cutAtWord, firstSentence } = require('./admin-alert-compose');
const { legacyKindFromTitle } = require('./agent-activity');

const DEFAULT_LIMIT = 200;
const ROW_CAP = 500; // most items one response returns
const PAGE_SIZE = 500;
const SCAN_CAP = 20000;
const DETAIL_CHARS = 2000; // the full ops_digest finding, bounded
const WHY_FROM_DETAIL_CHARS = 200;
const ACTIVITY_FEED_LINK_RE = /^\/admin\/agents\?tab=activity\b/;

// Legacy rows (raw emitters that predate the rule) carry no area. First match wins;
// anything unlisted is System. Inferred, so the row is flagged `derived`.
const AREA_BY_CATEGORY = [
  [/^(inbound_sms|inbound_email|missed_call|voicemail_callback|comms|communications)$/, 'Comms'],
  [/^(new_lead|lead)/, 'Leads'],
  [/^estimate/, 'Estimates'],
  [/^(payment|billing|dispute|payout)/, 'Billing'],
  [/^(schedule|appointment|service)/, 'Schedule'],
  [/^(customer|visit_prep_photos)/, 'Customers'],
  [/^inventory/, 'Inventory'],
  [/^(content|newsletter|knowledge|review)/, 'Content'],
  [/^(system|agents|token_alert|credential|ops_digest)/, 'System'],
];
// A standing condition's area, from the admin page its link opens. Matched on
// the whole link: /admin/pipeline hosts both Leads and Estimates, told apart by
// its tab (the old /admin/leads and /admin/estimates routes redirect there).
const AREA_BY_PATH = [
  [/^\/admin\/pipeline\/?\?(.*&)?tab=leads(&|$)/, 'Leads'],
  [/^\/admin\/pipeline(\/|\?|$)/, 'Estimates'],
  [/^\/admin\/(invoices|billing)/, 'Billing'],
  [/^\/admin\/communications/, 'Comms'],
  [/^\/admin\/customers/, 'Customers'],
  [/^\/admin\/inventory/, 'Inventory'],
  [/^\/admin\/(dispatch|schedule)/, 'Schedule'],
  [/^\/admin\/leads/, 'Leads'],
  [/^\/admin\/estimates/, 'Estimates'],
];
const areaFrom = (table, text) => (table.find(([re]) => re.test(String(text || ''))) || [])[1] || 'System';

const SEVERITY_RANK = { broken: 0, 'needs-you': 1 };

function parseMeta(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}

const validSubject = (s) => s && typeof s.type === 'string' && s.id != null && String(s.id).trim() !== '';

// What a legacy row is about, from the ids its emitter already wrote (top level or
// payload) and its deep link. The record the fix is made on comes first.
function legacySubject(row, meta) {
  const payload = parseMeta(meta.payload);
  const refs = refsFromRow(row);
  const pick = (...keys) => keys.map((k) => meta[k] ?? payload[k]).find((v) => (typeof v === 'string' && v.trim()) || Number.isFinite(v));
  const hit = [
    ['visit', refs.visitId], ['invoice', pick('invoiceId', 'invoice_id')], ['estimate', refs.estimateId],
    ['lead', refs.leadId], ['call', pick('callLogId', 'call_log_id')], ['customer', pick('customerId', 'customer_id')],
  ].find(([, id]) => id);
  return hit ? { type: hit[0], id: String(hit[1]) } : null;
}

// An ops_digest row's action kind: the stamped metadata.kind, else the Activity feed's own
// reading of the legacy title prefix (FIX:/ACT:/[Review]; FYI:/OK:/anything else is info).
const digestKind = (row, meta) => meta.kind || legacyKindFromTitle(String(row.title || ''));

// A digest for the fyi audience (or kind) is information, never work: severity fyi, left out
// of the list.
function legacySeverity(row, meta) {
  if (row.category !== 'ops_digest') return 'needs-you';
  if (meta.audience === 'fyi') return 'fyi';
  const kind = digestKind(row, meta);
  if (kind === 'FIX') return 'broken';
  return kind === 'ACT' || kind === 'REVIEW' ? 'needs-you' : 'fyi';
}

// The whole finding, bounded. Engineering digests keep the diagnosis only here (body can be null).
function boundedDetail(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  return text.length <= DETAIL_CHARS ? text : `${text.slice(0, DETAIL_CHARS - 1).trimEnd()}\u2026`;
}

// The first line's first sentence (the compose rule's own cut), for a row with no body.
function whyFromDetail(detail) {
  const line = String(detail || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line ? cutAtWord(firstSentence(line), WHY_FROM_DETAIL_CHARS) : null;
}

// An ops_digest row opens its full report in the Activity feed, focused on this row.
function digestLinks(row) {
  if (row.category !== 'ops_digest') return { link: row.link || null };
  const focused = `/admin/agents?tab=activity&focus=${encodeURIComponent(row.id)}`;
  if (!row.link) return { link: focused };
  if (ACTIVITY_FEED_LINK_RE.test(row.link)) return { link: `${row.link}${row.link.includes('?') ? '&' : '?'}focus=${encodeURIComponent(row.id)}` };
  return { link: row.link, reportLink: focused };
}

// A row's area when it carries none: an ops digest names its work page in its
// link (estimates, communications, ...), so that page's area wins over the
// generic System its category maps to.
function inferredArea(row) {
  if (row.category === 'ops_digest' && row.link) {
    const fromLink = areaFrom(AREA_BY_PATH, String(row.link));
    if (fromLink !== 'System') return fromLink;
  }
  return areaFrom(AREA_BY_CATEGORY, row.category);
}

function mapAlertRow(row) {
  const meta = parseMeta(row.metadata);
  // Composed only with ALL its parts, a valid allowlisted subject included:
  // raiseAdminAlert keeps the other fields when it drops an invalid subject,
  // and such a row is still partly inferred (derived).
  // Each structured part stands on its own: raiseAdminAlert keeps the valid
  // ones when it drops an invalid subject. Only a missing part is inferred,
  // and the row is `derived` when ANY part was.
  const has = {
    area: AREAS.includes(meta.area),
    severity: SEVERITIES.includes(meta.severity),
    who: WHO.includes(meta.who),
    doneWhen: typeof meta.doneWhen === 'string',
    subject: !!validSubject(meta.subject) && SUBJECT_TYPES.includes(meta.subject.type),
  };
  const detail = boundedDetail(row.detail);
  return {
    kind: 'alert',
    id: row.id,
    category: row.category,
    area: has.area ? meta.area : inferredArea(row),
    headline: row.title,
    why: row.body || whyFromDetail(detail),
    detail,
    severity: has.severity ? meta.severity : legacySeverity(row, meta),
    ...digestLinks(row),
    subject: has.subject ? { type: meta.subject.type, id: meta.subject.id } : legacySubject(row, meta),
    doneWhen: has.doneWhen ? meta.doneWhen : null,
    who: has.who ? meta.who : (row.category === 'ops_digest' && meta.audience === 'engineering' ? 'claude' : 'person'),
    derived: !Object.values(has).every(Boolean),
    activityOnly: meta.feed === 'activity',
    createdAt: row.created_at,
    readAt: row.read_at || null,
    metadata: { dedupeKey: meta.dedupeKey || null, triggerKey: meta.triggerKey || null },
  };
}

// A standing condition clears itself at zero (docs/admin-notifications.md section 1).
function mapStanding(alert) {
  return {
    kind: 'standing',
    id: `live:${alert.id}`,
    area: areaFrom(AREA_BY_PATH, String(alert.href || '')),
    headline: alert.label,
    why: null,
    severity: 'needs-you',
    count: alert.count,
    link: alert.href || null,
    doneWhen: 'count_zero',
    who: 'person',
    // Standing conditions are first-class, not legacy rows with inferred parts.
    derived: false,
    createdAt: null,
    members: alert.members || null,
  };
}

// Every open row, walked in id-keyset pages: area, severity and who are judged in JS, so
// a newest-N read would drop an older open finding from a filtered list and its totals.
// SCAN_CAP is a runaway guard only; reaching it is reported as a warning, never silent.
async function openAlertRows(role) {
  // Activity-only rows (feed 'activity': engineering findings, quiet standing digests) are
  // included on purpose: the bell never shows them, but they are open work, and the
  // engineering ones are the Claude work. Each carries activityOnly: true.
  const rows = [];
  let after = null;
  for (;;) {
    const query = NotificationService.scopeAdminFeedToRole(db('notifications').where({ recipient_type: 'admin' }), role);
    if (after) query.where('id', '>', after);
    // The cron's persisted dashboard_alert rows echo the standing conditions below.
    const page = await query.whereNull('done_at')
      .whereRaw("COALESCE(metadata->>'triggerKey', '') <> 'dashboard_alert'")
      .orderBy('id', 'asc').limit(PAGE_SIZE)
      .select('id', 'category', 'title', 'body', 'detail', 'link', 'metadata', 'created_at', 'read_at');
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
    if (rows.length >= SCAN_CAP) return { rows, truncated: true };
    after = page[page.length - 1].id;
  }
}

// Exact: `claude` is what Claude may fix alone. `either` (Claude drafts, a person approves)
// is its own filter and never rides along with `claude`.
const whoMatches = (filter, who) => !filter || filter === who;

// One total order, the same on every call: severity (broken first), then
// newest, then id. A standing condition has no time; it sorts first within its
// severity at a fixed point, so a cursor never moves under it.
const STANDING_TS = Number.MAX_SAFE_INTEGER;
const sortKey = (item) => [SEVERITY_RANK[item.severity] ?? 1,
  item.createdAt ? new Date(item.createdAt).getTime() : STANDING_TS, String(item.id)];
function compareKeys(a, b) {
  return (a[0] - b[0]) || (b[1] - a[1]) || (a[2] < b[2] ? 1 : a[2] > b[2] ? -1 : 0);
}
const compareItems = (a, b) => compareKeys(sortKey(a), sortKey(b));
const encodeCursor = (key) => Buffer.from(JSON.stringify(key)).toString('base64url');
// A cursor from `next`; anything else is null (the route answers 400).
function decodeCursor(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const key = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const ok = Array.isArray(key) && key.length === 3 && Number.isFinite(key[0]) && Number.isFinite(key[1]) && typeof key[2] === 'string';
    return ok ? key : null;
  } catch { return null; }
}

async function listNeedsMe({ who, area, limit, role, after = null } = {}) {
  const generatedAt = new Date();
  const warnings = [];
  let items = [];
  const attempt = async (source, load) => {
    try { items = items.concat(await load()); } catch (err) {
      logger.error(`[needs-me] ${source} failed: ${err.message}`);
      warnings.push({ source, error: 'unavailable' });
    }
  };
  await attempt('notifications', async () => {
    const { rows, truncated } = await openAlertRows(role);
    if (truncated) {
      logger.warn(`[needs-me] stopped at ${SCAN_CAP} open notification rows`);
      warnings.push({ source: 'notifications', error: 'truncated' });
    }
    return rows.map(mapAlertRow);
  });
  // Standing conditions carry finance totals and owner-only links: admin only, like the bell overlay.
  if (!role || role === 'admin') {
    await attempt('dashboard_alerts', async () => {
      const result = await computeDashboardAlerts();
      // computeDashboardAlerts fail-softs per generator: a queue that threw is missing from
      // `alerts`, so say which one instead of reporting a quiet dashboard.
      for (const failure of result.failures || []) {
        warnings.push({ source: 'dashboard_alerts', generator: failure.id, error: 'unavailable' });
      }
      return (result.alerts || []).map(mapStanding);
    });
  }

  const matching = items
    .filter((item) => item.severity !== 'fyi' && whoMatches(who, item.who) && (!area || item.area === area))
    .sort(compareItems);
  const tally = (key) => matching.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
  const max = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), ROW_CAP);
  // Keyset paging over the same total order: strictly after the cursor's item.
  const remaining = after ? matching.filter((item) => compareKeys(sortKey(item), after) > 0) : matching;
  const page = remaining.slice(0, max);
  return {
    generatedAt: generatedAt.toISOString(),
    total: matching.length,
    counts: { byArea: tally('area'), byWho: tally('who'), bySeverity: tally('severity') },
    items: page,
    next: remaining.length > page.length ? encodeCursor(sortKey(page[page.length - 1])) : null,
    warnings,
  };
}

module.exports = { listNeedsMe, mapAlertRow, mapStanding, decodeCursor };
