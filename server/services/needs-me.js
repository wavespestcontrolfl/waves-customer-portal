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
const { AREAS, SEVERITIES, WHO } = require('./admin-alert-compose');

const DEFAULT_LIMIT = 200;
const ROW_CAP = 500; // most items one response returns
const PAGE_SIZE = 500;
const SCAN_CAP = 20000;

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
// A standing condition's area, from the admin page its link opens.
const AREA_BY_PATH = [
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

// A digest for the fyi audience is information, never work: severity fyi, left out of the list.
function legacySeverity(row, meta) {
  if (row.category === 'ops_digest' && meta.audience === 'fyi') return 'fyi';
  return meta.kind === 'FIX' ? 'broken' : 'needs-you';
}

function mapAlertRow(row) {
  const meta = parseMeta(row.metadata);
  const composed = AREAS.includes(meta.area) && SEVERITIES.includes(meta.severity) && WHO.includes(meta.who)
    && typeof meta.doneWhen === 'string';
  return {
    kind: 'alert',
    id: row.id,
    category: row.category,
    area: composed ? meta.area : areaFrom(AREA_BY_CATEGORY, row.category),
    headline: row.title,
    why: row.body || null,
    severity: composed ? meta.severity : legacySeverity(row, meta),
    link: row.link || null,
    subject: validSubject(meta.subject) ? { type: meta.subject.type, id: meta.subject.id } : legacySubject(row, meta),
    doneWhen: composed ? meta.doneWhen : null,
    who: composed ? meta.who : (row.category === 'ops_digest' && meta.audience === 'engineering' ? 'claude' : 'person'),
    derived: !composed,
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
    area: areaFrom(AREA_BY_PATH, String(alert.href || '').split('?')[0]),
    headline: alert.label,
    why: null,
    severity: 'needs-you',
    count: alert.count,
    link: alert.href || null,
    doneWhen: 'count_zero',
    who: 'person',
    derived: true,
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
      .select('id', 'category', 'title', 'body', 'link', 'metadata', 'created_at', 'read_at');
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
    if (rows.length >= SCAN_CAP) return { rows, truncated: true };
    after = page[page.length - 1].id;
  }
}

// `claude` returns what Claude may fix on its own: who is `claude` or `either`.
const whoMatches = (filter, who) => !filter || filter === who || (filter === 'claude' && who === 'either');

async function listNeedsMe({ who, area, limit, role } = {}) {
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
    await attempt('dashboard_alerts', async () => ((await computeDashboardAlerts()).alerts || []).map(mapStanding));
  }

  const when = (item) => (item.createdAt ? new Date(item.createdAt).getTime() : generatedAt.getTime());
  const matching = items
    .filter((item) => item.severity !== 'fyi' && whoMatches(who, item.who) && (!area || item.area === area))
    .sort((a, b) => ((SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1)) || (when(b) - when(a)));
  const tally = (key) => matching.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] || 0) + 1 }), {});
  const max = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), ROW_CAP);
  return {
    generatedAt: generatedAt.toISOString(),
    total: matching.length,
    counts: { byArea: tally('area'), byWho: tally('who'), bySeverity: tally('severity') },
    items: matching.slice(0, max),
    warnings,
  };
}

module.exports = { listNeedsMe, mapAlertRow, mapStanding };
